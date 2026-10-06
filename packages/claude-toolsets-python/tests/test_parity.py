import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from anthropic.tools import ToolError
from anthropic.tools.browser import BetaLocalFilePolicy
from support import ChromeProtocol, Desktop, call

from e2b_claude_toolsets import E2BBrowserToolset, E2BComputerToolset, UploadFile
from e2b_claude_toolsets._sandbox import BrowserRuntime
from e2b_claude_toolsets._uploads import MAX_UPLOAD_BYTES, prepare_uploads


class ParityTests(unittest.TestCase):
    def setUp(self):
        self.chrome, self.desktop = ChromeProtocol(), Desktop()
        self.addCleanup(self.chrome.close)

        def start(runtime, **kwargs):
            runtime.sandbox = kwargs["sandbox"]
            runtime.directory = "/tmp/e2b-browser-abc123"
            return self.chrome.url, {}

        self.patch = patch.object(BrowserRuntime, "start", start)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def browser(self, **options):
        browser = E2BBrowserToolset(sandbox=self.desktop, **options)
        self.addCleanup(browser.close)
        return browser

    def test_attach_options_and_computer_limits_refuse_before_effects(self):
        for name, value in [
            ("template", "desktop"),
            ("timeout", 600),
            ("api_key", "TEST"),
            ("allow_out", []),
            ("metadata", {}),
        ]:
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, name):
                self.browser(**{name: value})
        self.assertFalse(self.desktop.calls)
        with E2BComputerToolset(self.desktop, confirm=lambda _: True) as computer:
            for name, data in [
                ("scroll", {"scroll_direction": "down", "scroll_amount": 0}),
                ("scroll", {"scroll_direction": "down", "scroll_amount": 51}),
                ("scroll", {"scroll_direction": "down", "scroll_amount": 1.5}),
                ("key", {"text": "a", "repeat": 101}),
                ("key", {"text": "a", "repeat": 0}),
            ]:
                self.assertTrue(call(computer, name, data)["is_error"])
            self.assertFalse(self.desktop.calls)
            self.assertFalse(call(computer, "key", {"text": "a", "repeat": 100}).get("is_error"))
            self.assertFalse(
                call(computer, "scroll", {"scroll_direction": "down", "scroll_amount": 50}).get("is_error")
            )

    def test_browser_scroll_refuses_invalid_amounts_before_input(self):
        browser = self.browser()
        data = dict(target={"type": "coordinate", "x": 0, "y": 0}, scroll_direction="down")
        for amount in [0, 11]:
            with self.subTest(amount=amount):
                before = len(self.chrome.commands)
                self.assertTrue(call(browser, "scroll", dict(data, scroll_amount=amount)).get("is_error"))
                self.assertFalse(
                    any(command["method"] == "Input.dispatchMouseEvent" for command in self.chrome.commands[before:])
                )
        for amount, delta in [(None, 300), (1, 100), (10, 1000)]:
            self.assertFalse(call(browser, "scroll", dict(data, scroll_amount=amount)).get("is_error"))
            wheel = next(
                command for command in reversed(self.chrome.commands) if command["method"] == "Input.dispatchMouseEvent"
            )
            self.assertEqual((wheel["params"]["deltaX"], wheel["params"]["deltaY"]), (0, delta))

    def test_detach_releases_domains_before_disconnect_and_preserves_chrome(self):
        browser = self.browser()
        browser._runtime.pid = 123
        browser._owns_browser = True
        browser._tab().buttons = 1
        before = len(self.chrome.commands)
        browser.detach()
        browser.detach()
        browser.close()
        methods = [command["method"] for command in self.chrome.commands[before:]]
        self.assertLess(methods.index("Fetch.disable"), methods.index("Target.setAutoAttach"))
        self.assertLess(methods.index("Target.setAutoAttach"), methods.index("Target.detachFromTarget"))
        self.assertFalse(
            any(
                command == "kill-sandbox" or isinstance(command, tuple) and command[0] in {"remove", "kill"}
                for command in self.desktop.calls
            )
        )
        with self.assertRaises(Exception):
            call(browser, "list_tabs")

    def test_detach_refusals_leave_toolset_usable_and_failure_is_retryable(self):
        browser = self.browser()
        browser._runtime.owned = True
        with self.assertRaises(ValueError):
            browser.detach()
        browser._runtime.owned = False
        browser._downloads["busy"] = ("download_1", "https://example.com/file")
        with self.assertRaises(ValueError):
            browser.detach()
        browser._downloads.clear()
        self.assertFalse(call(browser, "list_tabs").get("is_error"))
        self.chrome.errors["Fetch.disable"] = {"code": -32602, "message": "PRIVATE-TRAFFIC-TOKEN"}
        with self.assertRaises(ToolError):
            browser.detach()
        self.assertIsNotNone(browser._cdp)
        del self.chrome.errors["Fetch.disable"]
        browser.detach()

    def test_failed_guard_keeps_a_waiting_target_paused_without_losing_tabs(self):
        browser = self.browser()
        self.chrome.errors["Fetch.enable"] = {"code": -32601, "message": "unsupported"}
        browser._attached(
            {
                "sessionId": "frame-session",
                "targetInfo": {"targetId": "frame", "type": "iframe"},
                "waitingForDebugger": True,
            },
            browser._tab().session,
        )
        self.assertFalse(
            any(
                c["method"] in ("Runtime.runIfWaitingForDebugger", "Target.closeTarget")
                and c.get("sessionId", c["params"].get("targetId")) in ("frame", "frame-session")
                for c in self.chrome.commands
            ),
            "a waiting iframe whose interception failed stays paused: neither resumed nor closed",
        )
        self.assertFalse(browser._client().closed)
        self.assertFalse(call(browser, "list_tabs").get("is_error"))

    def test_guard_on_a_running_target_that_cannot_be_closed_keeps_the_connection(self):
        browser = self.browser()
        tab = browser._tab()
        self.chrome.errors["Fetch.enable"] = {"code": -32601, "message": "unsupported"}
        self.chrome.close_failed.update(["frame", tab.target])
        # an iframe already running (an open page): closing is the only fail-closed step; when even that fails, no
        # raise, which would drop the connection and resume every paused target
        browser._attached(
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

    def test_opt_in_sdk_gates_pinned_upload_and_cleanup_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "binary.dat")
            path.write_bytes(b"\x00\xffexample")
            configs = {
                name: {"enabled": True} for name in ["file_upload", "javascript_exec", "read_console", "read_network"]
            }
            with self.assertRaises(Exception):
                self.browser(configs=configs)
            browser = self.browser(
                configs=configs, confirm=lambda _: True, file_policy=BetaLocalFilePolicy(upload_roots=[directory])
            )
            request = dict(target={"type": "ref", "ref": "ref_1"}, paths=[str(path)])
            self.assertFalse(call(browser, "file_upload", request).get("is_error"))
            staged = next(
                command for command in self.desktop.calls if isinstance(command, tuple) and command[0] == "file-write"
            )
            self.assertEqual(staged[2], path.read_bytes())
            self.assertEqual(browser._upload_bytes, len(staged[2]))
            with self.assertRaises(ValueError):
                browser.detach()
            self.assertIn("42", json.dumps(call(browser, "javascript_exec", {"text": "Promise.resolve(42)"})))
            self.assertTrue(any(command["method"] == "Runtime.releaseObjectGroup" for command in self.chrome.commands))
            self.chrome.promise_result = {"type": "object", "objectId": "promise-value", "description": "Object"}
            call(browser, "javascript_exec", {"text": "Promise.resolve({value:42})"})
            self.assertTrue(
                any(
                    command["method"] == "Runtime.releaseObject" and command["params"]["objectId"] == "promise-value"
                    for command in self.chrome.commands
                )
            )
            with patch.object(self.desktop.files, "remove", side_effect=RuntimeError("PRIVATE-TRAFFIC-TOKEN")):
                with self.assertRaisesRegex(RuntimeError, "upload staging"):
                    browser.close()
            self.assertTrue(browser._upload_directories)
            browser.close()
            self.assertFalse(browser._upload_directories)

    def test_file_policy_and_confirmation_stop_before_read_or_upload(self):
        for policy, confirmation in [
            (None, lambda _: True),
            (BetaLocalFilePolicy(upload_roots=["/private/tmp"]), lambda _: False),
        ]:
            browser = self.browser(configs={"file_upload": {"enabled": True}}, confirm=confirmation, file_policy=policy)
            before = len(self.chrome.commands)
            result = call(
                browser,
                "file_upload",
                {"target": {"type": "ref", "ref": "ref_1"}, "paths": ["/private/tmp/not-an-approved-file"]},
            )
            self.assertTrue(result["is_error"])
            self.assertFalse(
                any(command["method"] == "DOM.setFileInputFiles" for command in self.chrome.commands[before:])
            )
            self.assertFalse(
                any(isinstance(command, tuple) and command[0] == "file-write" for command in self.desktop.calls)
            )
            browser.close()

    def test_console_and_network_are_bounded_and_drained(self):
        browser = self.browser(configs={"read_console": {"enabled": True}, "read_network": {"enabled": True}})
        tab = browser._tab()
        for index in range(105):
            browser._event("Runtime.consoleAPICalled", {"type": "log", "args": [{"value": str(index)}]}, tab.session)
            browser._event(
                "Network.requestWillBeSent",
                {
                    "requestId": str(index),
                    "request": {"url": "https://example.com/data", "method": "GET"},
                    "timestamp": index,
                    "type": "Fetch",
                },
                tab.session,
            )
        browser._event(
            "Network.responseReceived",
            {"requestId": "104", "type": "Fetch", "response": {"status": 200, "mimeType": "text/plain"}},
            tab.session,
        )
        browser._event("Network.loadingFinished", {"requestId": "104", "timestamp": 104.1}, tab.session)
        self.assertEqual(len(tab.console), 100)
        self.assertEqual(len(tab.network), 100)
        self.assertEqual(len(tab.requests), 100)
        self.assertIn(
            "200 https://example.com/data Fetch text/plain 100 ms",
            browser.read_network(None, type("Input", (), {"tab_id": None})()),
        )
        self.assertIn("[log] 104", json.dumps(call(browser, "read_console")))
        self.assertIn("No console", json.dumps(call(browser, "read_console")))
        self.assertIn("No network", json.dumps(call(browser, "read_network")))

    def test_upload_race_never_selects_new_document_and_reads_are_bounded(self):
        browser = self.browser(
            configs={"file_upload": {"enabled": True}},
            confirm=lambda _: True,
            file_policy=BetaLocalFilePolicy(upload_document_ids=["doc"]),
            upload_documents={"doc": UploadFile("note.txt", b"hello")},
        )
        original = self.desktop.files.write

        def changed(path, data):
            original(path, data)
            browser._tab().world_generation += 1

        self.desktop.files.write = changed
        result = call(browser, "file_upload", {"target": {"type": "ref", "ref": "ref_1"}, "document_ids": ["doc"]})
        self.assertTrue(result["is_error"])
        self.assertFalse(any(command["method"] == "DOM.setFileInputFiles" for command in self.chrome.commands))
        self.assertFalse(browser._upload_directories)
        self.assertEqual(browser._upload_bytes, 0)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "file")
            path.write_bytes(b"content")
            link = Path(directory, "link")
            link.symlink_to(path)
            for bad in [str(link), directory, str(Path(directory, "absent"))]:
                with self.assertRaises(ToolError) as raised:
                    prepare_uploads([bad], [], {})
                self.assertNotIn(directory, str(raised.exception))
        with self.assertRaises(ToolError):
            prepare_uploads([], ["large"], {"large": UploadFile("large.bin", bytes(MAX_UPLOAD_BYTES + 1))})


if __name__ == "__main__":
    unittest.main()
