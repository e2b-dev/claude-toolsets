"""Regressions for detached sessions, delivered input and private CDP traffic."""

import asyncio
import io
import json
import logging
import threading
import unittest
from unittest.mock import patch

from support import ChromeProtocol, Desktop, call
from test_async import AsyncDesktop

from e2b_claude_toolsets import AsyncE2BBrowserToolset, E2BBrowserToolset
from e2b_claude_toolsets._async_cdp import AsyncCdpClient
from e2b_claude_toolsets._async_sandbox import AsyncBrowserRuntime
from e2b_claude_toolsets._cdp import CdpClient, CdpProtocolError
from e2b_claude_toolsets._sandbox import BrowserRuntime


class DroppingChrome(ChromeProtocol):
    def reply(self, msg, result=None):
        if msg["method"] == "Runtime.runIfWaitingForDebugger" and msg.get("sessionId") == "other":
            return
        super().reply(msg, result)
        if msg["method"] == "Target.detachFromTarget":
            self.event("Target.detachedFromTarget", {"sessionId": msg["params"]["sessionId"]})

    def attach_other(self):
        self.event(
            "Target.attachedToTarget",
            {"sessionId": "other", "targetInfo": {"targetId": "other", "type": "other"}, "waitingForDebugger": True},
        )


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.chrome = DroppingChrome()
        self.addCleanup(self.chrome.close)

        def start(runtime, **kwargs):
            runtime.sandbox, runtime.directory = kwargs["sandbox"], "/tmp/e2b-browser-review"
            return self.chrome.url, {}

        with patch.object(BrowserRuntime, "start", start):
            self.browser = E2BBrowserToolset(sandbox=Desktop())
        self.addCleanup(self.browser.close)

    def test_detached_other_target_does_not_leave_event_deadline(self):
        self.chrome.attach_other()
        self.browser._client().send("Fixture.reply")
        self.browser._client().drain(timeout=0.5)
        self.assertFalse(self.browser._client()._submitted)
        self.assertFalse(call(self.browser, "screenshot").get("is_error"))

    def test_detached_session_settles_foreground_and_late_reply_is_ignored(self):
        client = self.browser._client()
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def blocked(*_):
            entered.set()
            release.wait(2)

        client.on("Fixture.callback", blocked)
        client.send("Fixture.event")
        self.assertTrue(entered.wait(1))
        pending = client.request("Fixture.never", session="gone")
        live = client.request("Fixture.never", session="live")
        self.chrome.event("Target.detachedFromTarget", {"sessionId": "gone"})
        client.send("Fixture.reply")
        with self.assertRaises(CdpProtocolError) as caught:
            client.result(pending, timeout=0.1)
        self.assertTrue(caught.exception.stale)
        self.assertFalse(live[1].done())
        assert self.chrome.socket is not None
        self.chrome.socket.send(json.dumps({"id": pending[0], "result": {}}))
        self.chrome.socket.send(json.dumps({"id": live[0], "result": {}}))
        client.result(live)
        client.send("Fixture.reply")
        self.assertFalse(client.closed)
        release.set()

    def test_startup_failure_reports_stage_without_provider_secrets(self):
        def fail(runtime, **_):
            runtime.stage = "Chrome startup"
            raise RuntimeError("PRIVATE-PROVIDER-ERROR")

        with patch.object(BrowserRuntime, "start", fail), self.assertRaises(RuntimeError) as caught:
            E2BBrowserToolset(sandbox=Desktop())
        self.assertIn("Chrome startup", str(caught.exception))
        self.assertNotIn("PRIVATE", str(caught.exception))
        self.assertTrue(caught.exception.__suppress_context__)

    def test_delivered_click_is_successful_even_if_navigation_still_loading(self):
        self.browser._tab().loading = True
        with patch("e2b_claude_toolsets._browser.time") as clock:
            clock.monotonic.side_effect = [0, 1, 2, 20]
            result = call(self.browser, "left_click", {"target": {"type": "coordinate", "x": 10, "y": 10}})
        self.assertFalse(result.get("is_error"), result)
        self.assertTrue(self.browser._tab().loading)
        events = [c["params"]["type"] for c in self.chrome.commands if c["method"] == "Input.dispatchMouseEvent"]
        self.assertEqual(events, ["mouseMoved", "mousePressed", "mouseReleased"])

    def test_debug_logging_does_not_expose_client_headers_or_payloads(self):
        self.browser.close()
        logger, output = logging.getLogger("websockets.client"), io.StringIO()
        handler, level = logging.StreamHandler(output), logger.level
        logger.addHandler(handler)
        logger.setLevel(logging.DEBUG)
        try:
            client = CdpClient(self.chrome.url, {"e2b-traffic-access-token": "FAKE-TOKEN"})
            try:
                client.send("Input.insertText", {"text": "PRIVATE-TEXT"})
            finally:
                client.close()

            async def exercise():
                client = await AsyncCdpClient.connect(self.chrome.url, {"e2b-traffic-access-token": "FAKE-TOKEN"})
                try:
                    await client.send("Runtime.evaluate", {"expression": "PRIVATE-SCRIPT"})
                finally:
                    await client.close()

            asyncio.run(exercise())
        finally:
            logger.removeHandler(handler)
            logger.setLevel(level)
        for secret in ["FAKE-TOKEN", "PRIVATE-TEXT", "PRIVATE-SCRIPT"]:
            self.assertNotIn(secret, output.getvalue())


class AsyncReviewTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.chrome = DroppingChrome()
        self.addCleanup(self.chrome.close)

        async def start(runtime, **kwargs):
            runtime.sandbox, runtime.directory = kwargs["sandbox"], "/tmp/e2b-browser-review"
            return self.chrome.url, {}

        with patch.object(AsyncBrowserRuntime, "start", start):
            self.browser = await AsyncE2BBrowserToolset.create(sandbox=AsyncDesktop())
        self.addAsyncCleanup(self.browser.close)

    async def test_detached_other_target_does_not_leave_event_deadline(self):
        self.chrome.attach_other()
        await self.browser._client().send("Fixture.reply")
        await self.browser._client().drain(timeout=0.5)
        self.assertFalse(self.browser._client()._submitted)
        self.assertFalse((await call(self.browser, "screenshot")).get("is_error"))

    async def test_detached_session_settles_foreground_even_if_worker_blocked(self):
        client = self.browser._client()
        entered, release = asyncio.Event(), asyncio.Event()
        self.addCleanup(release.set)

        async def blocked(*_):
            entered.set()
            await release.wait()

        client.on("Fixture.callback", blocked)
        await client.send("Fixture.event")
        await asyncio.wait_for(entered.wait(), 1)
        pending = await client.request("Fixture.never", session="gone")
        live = await client.request("Fixture.never", session="live")
        self.chrome.event("Target.detachedFromTarget", {"sessionId": "gone"})
        await client.send("Fixture.reply")
        with self.assertRaises(CdpProtocolError) as caught:
            await client.result(pending, timeout=0.1)
        self.assertTrue(caught.exception.stale)
        self.assertFalse(live[1].done())
        assert self.chrome.socket is not None
        self.chrome.socket.send(json.dumps({"id": pending[0], "result": {}}))
        self.chrome.socket.send(json.dumps({"id": live[0], "result": {}}))
        await client.result(live)
        await client.send("Fixture.reply")
        self.assertFalse(client.closed)
        release.set()

    async def test_delivered_click_is_successful_even_if_navigation_still_loading(self):
        tab = await self.browser._tab()
        tab.loading = True
        # Patch this module's clock only; asyncio must retain its real scheduling clock.
        with patch("e2b_claude_toolsets._async_browser.time") as clock:
            clock.monotonic.side_effect = [0, 1, 2, 20]
            result = await call(self.browser, "left_click", {"target": {"type": "coordinate", "x": 10, "y": 10}})
        self.assertFalse(result.get("is_error"), result)
        self.assertTrue(tab.loading)
        events = [c["params"]["type"] for c in self.chrome.commands if c["method"] == "Input.dispatchMouseEvent"]
        self.assertEqual(events, ["mouseMoved", "mousePressed", "mouseReleased"])

    async def test_uninitialized_context_manager_refuses_before_io(self):
        browser = AsyncE2BBrowserToolset(sandbox=AsyncDesktop())
        self.addAsyncCleanup(browser.close)
        with self.assertRaisesRegex(RuntimeError, "create"):
            async with browser:
                self.fail("Uninitialized toolset was accepted")
        async with self.browser as entered:
            self.assertIs(entered, self.browser)

    async def test_startup_failure_reports_stage_without_provider_secrets(self):
        async def fail(runtime, **_):
            runtime.stage = "browser protocol setup"
            raise RuntimeError("PRIVATE-PROVIDER-ERROR")

        with patch.object(AsyncBrowserRuntime, "start", fail), self.assertRaises(RuntimeError) as caught:
            await AsyncE2BBrowserToolset.create(sandbox=AsyncDesktop())
        self.assertIn("browser protocol setup", str(caught.exception))
        self.assertNotIn("PRIVATE", str(caught.exception))
        self.assertTrue(caught.exception.__suppress_context__)


if __name__ == "__main__":
    unittest.main()
