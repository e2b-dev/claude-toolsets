import asyncio
import base64
import json
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from anthropic.tools import ToolError
from anthropic.tools.browser import BetaLocalFilePolicy
from support import PNG, ChromeProtocol, Desktop, call

from e2b_claude_toolsets import (
    AsyncBrowserInitializationError,
    AsyncE2BBrowserToolset,
    AsyncE2BComputerToolset,
    UploadFile,
    allow_hosts,
)
from e2b_claude_toolsets._async_cdp import AsyncCdpClient
from e2b_claude_toolsets._async_sandbox import AsyncBrowserRuntime


class AsyncDesktop(Desktop):
    """Async E2B protocol fixture, deliberately without sync desktop helper methods."""

    def __init__(self):
        super().__init__()
        self.pressed = asyncio.Event()
        self.releasing = asyncio.Event()
        self.release_gate = None
        self.action_gate = None
        self.commands = SimpleNamespace(run=self.async_run, kill=self.kill_process)
        self.files = SimpleNamespace(remove=self.remove, write=self.file_write, make_dir=self.make_dir, read=self.read)

    async def async_run(self, command, **kwargs):
        if "keyup" in command:
            self.releasing.set()
            if self.release_gate is not None:
                await self.release_gate.wait()
        output = Desktop.run(self, command, **kwargs)
        output.disconnect = self.disconnect
        if command == "xrandr":
            output.stdout = "Screen 0: minimum 1 x 1, current 1280 x 800, maximum 1280 x 800"
        if command == "xdotool getmouselocation":
            output.stdout = "x:0 y:0 screen:0 window:0"
        if "keydown" in command or "type --delay" in command:
            self.pressed.set()
        if "type --delay" in command and self.action_gate is not None:
            await self.action_gate.wait()
        return output

    async def disconnect(self):
        pass

    async def kill_process(self, pid):
        self.calls.append(("kill", pid))

    async def kill(self):
        return Desktop.kill(self)

    async def remove(self, path):
        self.calls.append(("remove", path))
        if self.fail == "remove":
            raise RuntimeError("PRIVATE-TRAFFIC-TOKEN")

    async def file_write(self, path, data):
        self.calls.append(("file-write", path, data))

    async def make_dir(self, path):
        self.calls.append(("mkdir", path))

    async def read(self, path, **kwargs):
        return base64.b64decode(PNG)


class AsyncDriverTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.chrome, self.desktop = ChromeProtocol(), AsyncDesktop()
        self.addCleanup(self.chrome.close)

        async def start(runtime, **kwargs):
            runtime.sandbox = kwargs["sandbox"]
            runtime.directory = "/tmp/e2b-browser-abc123"
            return self.chrome.url, {}

        self.start_patch = patch.object(AsyncBrowserRuntime, "start", start)
        self.start_patch.start()
        self.addCleanup(self.start_patch.stop)

    async def browser(self, **options):
        browser = await AsyncE2BBrowserToolset.create(sandbox=self.desktop, **options)
        self.addAsyncCleanup(browser.close)
        return browser

    async def computer(self, **options):
        computer = await AsyncE2BComputerToolset.create(self.desktop, confirm=lambda _: True, **options)
        self.addAsyncCleanup(computer.close)
        return computer

    async def test_native_sdk_flavour_member_parity_and_async_policy(self):
        checked = []

        async def policy(context, url):
            await asyncio.sleep(0)
            checked.append(url)
            allow_hosts(["example.com"])(context, url)

        async def confirm(context):
            await asyncio.sleep(0)
            return True

        browser = await self.browser(url_policy=policy, confirm=confirm)
        computer = await self.computer()
        self.assertEqual(len(browser._toolset_options.served), 31)
        self.assertEqual(len(computer._toolset_options.served), 16)
        self.assertEqual(computer.configs, {"zoom": {"enabled": False}})
        result = await call(browser, "navigate", {"url": "https://example.com"})
        self.assertFalse(result.get("is_error"))
        self.assertGreaterEqual(len(checked), 2)  # SDK policy and driver interception both awaited.
        before = len(self.chrome.commands)
        self.assertTrue((await call(browser, "navigate", {"url": "https://evil.test"}))["is_error"])
        self.assertFalse(any(command["method"] == "Page.navigate" for command in self.chrome.commands[before:]))
        read = await call(browser, "read_page")
        self.assertIn("ref_1", json.dumps(read))
        self.assertFalse(
            (await call(browser, "left_click", {"target": {"type": "ref", "ref": "ref_1"}})).get("is_error")
        )
        self.assertTrue((await call(browser, "left_click", {"target": {"type": "ref", "ref": "ref_999"}}))["is_error"])
        self.assertTrue(any(block["type"] == "browser_state" for block in read["content"]))
        self.assertFalse((await call(browser, "new_tab")).get("is_error"))
        self.assertFalse((await call(browser, "close_tab", {"tab_id": "tab_2"})).get("is_error"))
        self.assertTrue(any(block["type"] == "image" for block in (await call(computer, "screenshot"))["content"]))
        await computer.close()
        await browser.close()
        self.assertNotIn("kill-sandbox", self.desktop.calls)

    async def test_computer_cancel_repeatedly_releases_keys_before_returning(self):
        computer = await self.computer()
        self.desktop.release_gate = asyncio.Event()
        task = asyncio.create_task(call(computer, "hold_key", {"text": "shift", "duration": 20}))
        await asyncio.wait_for(self.desktop.pressed.wait(), 2)
        started = time.monotonic()
        task.cancel()
        await asyncio.wait_for(self.desktop.releasing.wait(), 2)
        task.cancel()
        await asyncio.sleep(0)
        self.assertFalse(task.done())
        self.desktop.release_gate.set()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(task, 2)
        self.assertLess(time.monotonic() - started, 2)
        self.assertFalse(computer._held_keys)
        self.assertIn("xdotool keyup shift", self.desktop.calls)
        self.assertFalse((await call(computer, "wait", {"duration": 0})).get("is_error"))

    async def test_browser_scroll_refuses_invalid_amounts_before_input(self):
        browser = await self.browser()
        data = dict(target={"type": "coordinate", "x": 0, "y": 0}, scroll_direction="down")
        for amount in [0, 11]:
            with self.subTest(amount=amount):
                before = len(self.chrome.commands)
                self.assertTrue((await call(browser, "scroll", dict(data, scroll_amount=amount))).get("is_error"))
                self.assertFalse(
                    any(command["method"] == "Input.dispatchMouseEvent" for command in self.chrome.commands[before:])
                )
        for amount, delta in [(None, 300), (1, 100), (10, 1000)]:
            self.assertFalse((await call(browser, "scroll", dict(data, scroll_amount=amount))).get("is_error"))
            wheel = next(
                command for command in reversed(self.chrome.commands) if command["method"] == "Input.dispatchMouseEvent"
            )
            self.assertEqual((wheel["params"]["deltaX"], wheel["params"]["deltaY"]), (0, delta))

    async def test_browser_cancel_hold_releases_input_and_reader_survives(self):
        browser = await self.browser()
        down = asyncio.Event()
        original = browser._send

        async def send(tab, method, params=None, **kwargs):
            result = await original(tab, method, params, **kwargs)
            if (
                method == "Input.dispatchKeyEvent"
                and params is not None
                and params["type"] in {"keyDown", "rawKeyDown"}
            ):
                down.set()
            return result

        with patch.object(browser, "_send", send):
            task = asyncio.create_task(call(browser, "hold_key", {"text": "shift", "duration": 20}))
            await asyncio.wait_for(down.wait(), 2)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(task, 2)
        tab = await browser._tab()
        self.assertFalse(tab.held_keys)
        self.assertTrue(any(command["params"].get("type") == "keyUp" for command in self.chrome.commands))
        self.assertFalse((await call(browser, "list_tabs")).get("is_error"))

    async def test_sdk_serialization_and_cancelled_close_drain_accepted_calls(self):
        computer = await self.computer()
        self.desktop.action_gate = asyncio.Event()
        active = asyncio.create_task(call(computer, "type", {"text": "hello"}))
        await asyncio.wait_for(self.desktop.pressed.wait(), 2)
        queued = asyncio.create_task(call(computer, "wait", {"duration": 0}))
        await asyncio.sleep(0)
        closer = asyncio.create_task(computer.close())
        while not computer._toolset_closed:
            await asyncio.sleep(0)
        with self.assertRaises(Exception):
            await call(computer, "wait", {"duration": 0})
        closer.cancel()
        await asyncio.sleep(0)
        self.assertFalse(closer.done())
        self.desktop.action_gate.set()
        self.assertFalse((await active).get("is_error"))
        self.assertFalse((await queued).get("is_error"))
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(closer, 2)
        self.assertNotIn("kill-sandbox", self.desktop.calls)

    async def test_cancelled_owned_creation_records_then_cleans_resource(self):
        self.start_patch.stop()
        entered, finish = asyncio.Event(), asyncio.Event()

        async def create(**kwargs):
            entered.set()
            await finish.wait()
            return self.desktop

        with patch("e2b_claude_toolsets._async_sandbox.AsyncSandbox.create", create):
            task = asyncio.create_task(AsyncE2BBrowserToolset.create())
            await asyncio.wait_for(entered.wait(), 2)
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()
            finish.set()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(task, 3)
        self.assertEqual(self.desktop.calls.count("kill-sandbox"), 1)

    async def test_startup_cleanup_failure_retains_retry_handle(self):
        async def fail(runtime, **kwargs):
            runtime.sandbox, runtime.owned = self.desktop, True
            raise asyncio.CancelledError

        self.desktop.fail = "kill"
        with (
            patch.object(AsyncBrowserRuntime, "start", fail),
            self.assertRaises(AsyncBrowserInitializationError) as raised,
        ):
            await AsyncE2BBrowserToolset.create()
        self.desktop.fail = None
        await raised.exception.close()
        self.assertEqual(self.desktop.calls.count("kill-sandbox"), 2)

    async def test_failed_startup_and_cleanup_does_not_chain_the_raw_error(self):
        import traceback

        secret = "e2b_SECRET_TOKEN_sentinel"

        async def fail(runtime, **kwargs):
            runtime.sandbox, runtime.owned = self.desktop, True
            raise RuntimeError(f"connect failed: wss://host?token={secret}")

        self.desktop.fail = "kill"
        with (
            patch.object(AsyncBrowserRuntime, "start", fail),
            self.assertRaises(AsyncBrowserInitializationError) as raised,
        ):
            await AsyncE2BBrowserToolset.create()
        self.assertNotIn(secret, "".join(traceback.format_exception(raised.exception)))
        self.desktop.fail = None
        await raised.exception.close()

    async def test_optional_uploads_use_async_io_and_cleanup_retry(self):
        browser = await self.browser(
            configs={
                name: {"enabled": True} for name in ["file_upload", "javascript_exec", "read_console", "read_network"]
            },
            confirm=lambda _: True,
            file_policy=BetaLocalFilePolicy(upload_document_ids=["doc"]),
            upload_documents={"doc": UploadFile("binary.bin", b"\x00\xff")},
        )
        self.assertIn("42", json.dumps(await call(browser, "javascript_exec", {"text": "Promise.resolve(42)"})))
        self.chrome.promise_result = {"type": "object", "objectId": "promise-value", "description": "Object"}
        await call(browser, "javascript_exec", {"text": "Promise.resolve({value:42})"})
        self.assertTrue(
            any(
                command["method"] == "Runtime.releaseObject" and command["params"]["objectId"] == "promise-value"
                for command in self.chrome.commands
            )
        )
        self.assertFalse(
            (
                await call(browser, "file_upload", {"target": {"type": "ref", "ref": "ref_1"}, "document_ids": ["doc"]})
            ).get("is_error")
        )
        self.assertTrue(
            any(
                command[0] == "file-write" and command[2] == b"\x00\xff"
                for command in self.desktop.calls
                if isinstance(command, tuple)
            )
        )
        with self.assertRaises(ValueError):
            await browser.detach()
        self.desktop.fail = "remove"
        with self.assertRaises(RuntimeError):
            await browser.close()
        self.assertTrue(browser._upload_directories)
        self.desktop.fail = None
        await browser.close()
        self.assertFalse(browser._upload_directories)

    async def test_console_and_network_reports_consume_dispatched_events(self):
        browser = await self.browser(configs={"read_console": {"enabled": True}, "read_network": {"enabled": True}})
        tab = await browser._tab()
        self.chrome.event("Runtime.consoleAPICalled", {"type": "log", "args": [{"value": "hello"}]}, tab.session)
        for ident in ["ok", "failed"]:
            self.chrome.event(
                "Network.requestWillBeSent",
                {
                    "requestId": ident,
                    "request": {"url": "https://example.com/" + ident, "method": "GET"},
                    "timestamp": 1,
                    "type": "Fetch",
                },
                tab.session,
            )
        self.chrome.event(
            "Network.responseReceived",
            {"requestId": "ok", "type": "Fetch", "response": {"status": 200, "mimeType": "text/plain"}},
            tab.session,
        )
        self.chrome.event("Network.loadingFinished", {"requestId": "ok", "timestamp": 1.1}, tab.session)
        self.chrome.event("Network.loadingFailed", {"requestId": "failed", "errorText": "net::ERR_FAILED"}, tab.session)
        await browser._client().send("Fixture.reply")
        await browser._client().drain()
        self.assertIn("[log] hello", json.dumps(await call(browser, "read_console")))
        self.assertIn("No console", json.dumps(await call(browser, "read_console")))
        report = json.dumps(await call(browser, "read_network"))
        self.assertIn("GET 200 https://example.com/ok Fetch text/plain 100 ms", report)
        self.assertIn("GET failed (net::ERR_FAILED) https://example.com/failed Fetch", report)
        self.assertFalse(tab.requests)
        self.assertIn("No network", json.dumps(await call(browser, "read_network")))

    async def test_cancelled_upload_finishes_write_before_removing_staging(self):
        browser = await self.browser(
            configs={"file_upload": {"enabled": True}},
            confirm=lambda _: True,
            file_policy=BetaLocalFilePolicy(upload_document_ids=["doc"]),
            upload_documents={"doc": UploadFile("note.txt", b"hello")},
        )
        entered, finish = asyncio.Event(), asyncio.Event()

        async def write(path, data):
            entered.set()
            await finish.wait()
            await self.desktop.file_write(path, data)

        self.desktop.files.write = write
        task = asyncio.create_task(
            call(browser, "file_upload", {"target": {"type": "ref", "ref": "ref_1"}, "document_ids": ["doc"]})
        )
        await asyncio.wait_for(entered.wait(), 2)
        task.cancel()
        await asyncio.sleep(0)
        self.assertFalse(task.done())
        finish.set()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(task, 2)
        self.assertFalse(browser._upload_directories)
        self.assertEqual(browser._upload_bytes, 0)
        self.assertFalse(any(command["method"] == "DOM.setFileInputFiles" for command in self.chrome.commands))
        written = next(
            index
            for index, command in enumerate(self.desktop.calls)
            if isinstance(command, tuple) and command[0] == "file-write"
        )
        removed = next(
            index
            for index, command in enumerate(self.desktop.calls)
            if isinstance(command, tuple) and command[0] == "remove"
        )
        self.assertLess(written, removed)

    async def test_guard_on_a_running_target_that_cannot_be_closed_keeps_the_connection(self):
        browser = await self.browser()
        tab = await browser._tab()
        self.chrome.errors["Fetch.enable"] = {"code": -32601, "message": "unsupported"}
        self.chrome.close_failed.update(["frame", tab.target])
        # an iframe already running: closing is the only fail-closed step; when even that fails, no raise
        await browser._attached(
            {"sessionId": "frame", "targetInfo": {"type": "iframe", "targetId": "frame"}, "waitingForDebugger": False},
            tab.session,
        )
        self.assertTrue(tab.failed)
        self.assertFalse(browser._client().closed)
        resumed = [
            c
            for c in self.chrome.commands
            if c["method"] == "Runtime.runIfWaitingForDebugger" and c.get("sessionId") == "frame"
        ]
        self.assertEqual(resumed, [], "the iframe must stay paused")

    async def test_detach_guard_and_async_members_are_native(self):
        browser = await self.browser()
        self.chrome.errors["Fetch.enable"] = {"code": -32601, "message": "unsupported"}
        tab = await browser._tab()
        await browser._attached(
            {"sessionId": "frame", "targetInfo": {"type": "iframe", "targetId": "frame"}, "waitingForDebugger": True},
            tab.session,
        )
        self.assertFalse(browser._client().closed)
        self.assertFalse(
            any(
                c["method"] in ("Runtime.runIfWaitingForDebugger", "Target.closeTarget")
                and c.get("sessionId", c["params"].get("targetId")) in ("frame", "frame-session")
                for c in self.chrome.commands
            ),
            "a waiting iframe whose interception failed stays paused: neither resumed nor closed",
        )
        del self.chrome.errors["Fetch.enable"]
        client = browser._client()
        await browser.detach()
        await browser.close()
        self.assertTrue(client._reader.done())
        self.assertTrue(client._worker.done())
        self.assertNotIn("kill-sandbox", self.desktop.calls)
        for cls in [AsyncE2BBrowserToolset, AsyncE2BComputerToolset]:
            with self.assertRaises(ValueError):
                if cls is AsyncE2BBrowserToolset:
                    await cls.create(sandbox=Desktop())
                else:
                    await cls.create(Desktop(), confirm=lambda _: True)


class AsyncCdpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.chrome = ChromeProtocol()
        self.addCleanup(self.chrome.close)
        self.client = await AsyncCdpClient.connect(self.chrome.url, {})
        self.addAsyncCleanup(self.client.close)

    async def test_event_handler_can_send_and_timeouts_cancel_without_replay(self):
        replied = asyncio.Event()

        async def event(*_):
            await self.client.send("Fixture.reply")
            replied.set()

        self.client.on("Fixture.callback", event)
        await self.client.send("Fixture.event")
        await asyncio.wait_for(replied.wait(), 2)
        with self.assertRaises(ToolError):
            await self.client.send("Fixture.never", timeout=0.01)
        self.assertFalse(self.client._pending)
        assert self.chrome.socket is not None
        self.chrome.socket.send(json.dumps({"id": 3, "result": {"late": True}}))
        await self.client.send("Fixture.reply")
        task = asyncio.create_task(self.client.send("Fixture.never"))
        await asyncio.sleep(0.02)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertFalse(self.client._pending)
        self.assertEqual(sum(command["method"] == "Fixture.never" for command in self.chrome.commands), 2)

    async def test_pipeline_capacity_and_disconnect_finish_pending_calls(self):
        for _ in range(96):
            await self.client.submit("Fixture.never", {})
        waiting = asyncio.create_task(self.client.submit("Fixture.reply", {}))
        await asyncio.sleep(0.02)
        self.assertFalse(waiting.done())
        await self.client.send("Fixture.reply")
        assert self.chrome.socket is not None
        self.chrome.socket.send(json.dumps({"id": 1, "result": {}}))
        await asyncio.wait_for(waiting, 2)
        with self.assertRaises(ToolError):
            await self.client.send("Fixture.disconnect")
        self.assertTrue(self.client.closed)
        self.assertFalse(self.client._pending)

    async def test_deadline_and_cleanup_do_not_depend_on_event_worker(self):
        entered, release, cleaned = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def blocked(*_):
            entered.set()
            await release.wait()

        async def cleanup():
            cleaned.set()

        self.client.on("Fixture.callback", blocked)
        self.client._on_disconnect = cleanup
        await self.client.send("Fixture.event")
        await asyncio.wait_for(entered.wait(), 2)
        await self.client.submit("Fixture.never", {})
        for ident in self.client._submitted:
            self.client._submitted[ident] = time.monotonic() - 1
        await asyncio.wait_for(cleaned.wait(), 2)
        self.assertTrue(self.client.closed)
        self.assertFalse(self.client._worker.done())
        release.set()

    async def test_diagnostic_flood_is_discardable_but_security_events_are_not(self):
        entered, release = asyncio.Event(), asyncio.Event()

        async def console(*_):
            entered.set()
            await release.wait()

        async def request(*_):
            pass

        self.client.on("Runtime.consoleAPICalled", console)
        self.client.on("Fetch.requestPaused", request)
        self.chrome.event("Runtime.consoleAPICalled", {})
        await asyncio.wait_for(entered.wait(), 2)
        for _ in range(300):
            self.chrome.event("Runtime.consoleAPICalled", {})
        await self.client.send("Fixture.reply")
        self.assertFalse(self.client.closed)
        self.assertEqual(self.client._events.qsize(), 32)
        self.chrome.event("Fetch.requestPaused", {})
        await self.client.send("Fixture.reply")
        self.assertFalse(self.client.closed)  # Diagnostics leave room for URL protection.
        for _ in range(224):
            self.chrome.event("Fetch.requestPaused", {})
        with self.assertRaises(ToolError):
            await self.client.send("Fixture.reply")
        self.assertTrue(self.client.closed)
        release.set()


if __name__ == "__main__":
    unittest.main()
