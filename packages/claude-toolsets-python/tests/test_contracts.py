import json
import threading
import time
import unittest
from unittest.mock import Mock, patch

from anthropic.tools import ToolError
from anthropic.tools.browser import BetaToolsetCallContext, BetaURLContext
from support import ChromeProtocol, Desktop, call

from e2b_claude_toolsets import E2BBrowserToolset, E2BComputerToolset, allow_hosts
from e2b_claude_toolsets._browser import BrowserInitializationError
from e2b_claude_toolsets._cdp import CdpClient
from e2b_claude_toolsets._policy import check_url
from e2b_claude_toolsets._sandbox import BrowserRuntime
from e2b_claude_toolsets._scripts import RUNTIME_SOURCE


class BrowserTests(unittest.TestCase):
    def setUp(self):
        self.chrome = ChromeProtocol()

        def start(runtime, **kwargs):
            runtime.sandbox = kwargs["sandbox"]
            runtime.directory = "/tmp/e2b-browser-abc123"
            return self.chrome.url, {}

        self.patch = patch.object(BrowserRuntime, "start", start)
        self.patch.start()
        self.desktop = Desktop()
        self.browser = E2BBrowserToolset(sandbox=self.desktop, url_policy=allow_hosts(["example.com"]))
        self.context = BetaToolsetCallContext()
        self.addCleanup(self.chrome.close)
        self.addCleanup(self.patch.stop)
        self.addCleanup(self.browser.close)

    def test_sdk_members_and_complete_action_path(self):
        self.assertEqual(len(self.browser._toolset_options.served), 31)
        for name in {"file_upload", "javascript_exec", "read_console", "read_network"}:
            self.assertFalse(self.browser._toolset_options.is_enabled(name))
            self.assertTrue(call(self.browser, name)["is_error"])
        self.assertFalse(call(self.browser, "navigate", {"url": "https://example.com"}).get("is_error"))
        read = call(self.browser, "read_page")
        self.assertIn("ref_1", json.dumps(read))
        click = call(self.browser, "left_click", {"target": {"type": "ref", "ref": "ref_1"}})
        self.assertFalse(click.get("is_error"))
        self.assertTrue(call(self.browser, "left_click", {"target": {"type": "ref", "ref": "ref_999"}})["is_error"])
        self.assertTrue(any(b["type"] == "image" for b in call(self.browser, "screenshot")["content"]))
        self.assertTrue(any(b["type"] == "browser_state" for b in read["content"]))

    def test_refusal_before_navigation_and_confirmation(self):
        before = len(self.chrome.commands)
        self.assertTrue(call(self.browser, "navigate", {"url": "https://evil.test"})["is_error"])
        self.assertFalse(any(m["method"] == "Page.navigate" for m in self.chrome.commands[before:]))
        with patch.object(self.browser, "_policy", lambda *_: False):
            self.browser._intercept(
                {"requestId": "refusal", "request": {"url": "https://example.com"}, "resourceType": "Document"},
                "session-1",
                self.browser._tab(),
            )
        self.browser._client().send("Fixture.reply")  # Ordered barrier after the pipelined refusal.
        self.assertTrue(any(m["method"] == "Fetch.failRequest" for m in self.chrome.commands))

    def test_tabs_zoom_and_state(self):
        new = call(self.browser, "new_tab")
        self.assertFalse(new.get("is_error"))
        self.assertFalse(call(self.browser, "switch_tab", {"tab_id": "tab_1"}).get("is_error"))
        state = self.browser._browser_state(self.context)
        self.assertEqual(len(state.tabs), 2)
        self.assertEqual(sum(t["active"] for t in state.tabs), 1)
        self.assertTrue(call(self.browser, "zoom", {"region": [100, 100, 50, 50]})["is_error"])
        self.assertFalse(call(self.browser, "zoom", {"region": [0, 0, 100, 100]}).get("is_error"))
        shot = next(m for m in reversed(self.chrome.commands) if m["method"] == "Page.captureScreenshot")
        self.assertEqual(shot["params"]["clip"]["y"], 100)
        self.assertFalse(call(self.browser, "close_tab", {"tab_id": "tab_2"}).get("is_error"))
        self.assertTrue(call(self.browser, "close_tab", {"tab_id": "tab_1"})["is_error"])

    def test_runtime_installs_once_and_recovers_after_context_destruction(self):
        for name, args in [("read_page", {}), ("find", {"query": "Submit"})]:
            self.assertFalse(call(self.browser, name, args).get("is_error"))

        def installs():
            return [
                command
                for command in self.chrome.commands
                if command["method"] == "Runtime.evaluate" and command["params"]["expression"] == RUNTIME_SOURCE
            ]

        self.assertEqual(len(installs()), 1)
        tab = next(iter(self.browser._tabs.values()))
        self.browser._event("Runtime.executionContextDestroyed", {"executionContextId": tab.world}, tab.session)
        self.assertIsNone(tab.world)
        self.assertFalse(call(self.browser, "find", {"query": "Submit"}).get("is_error"))
        self.assertEqual(len(installs()), 2)

    def test_failed_runtime_install_never_dispatches_the_action(self):
        self.chrome.errors["Runtime.evaluate"] = {"code": -32000, "message": "context destroyed"}
        self.assertTrue(call(self.browser, "find", {"query": "Submit"}).get("is_error"))
        evaluations = [command for command in self.chrome.commands if command["method"] == "Runtime.evaluate"]
        self.assertEqual(len(evaluations), 1)
        self.assertEqual(evaluations[0]["params"]["expression"], RUNTIME_SOURCE)
        self.assertIsNone(next(iter(self.browser._tabs.values())).world)
        del self.chrome.errors["Runtime.evaluate"]
        self.assertFalse(call(self.browser, "find", {"query": "Submit"}).get("is_error"))

    def test_navigation_during_install_does_not_cache_or_dispatch(self):
        original = self.browser._send
        tab = next(iter(self.browser._tabs.values()))

        def send(current_tab, method, params=None, *args, **kwargs):
            if method == "Runtime.evaluate" and params and params["expression"] == RUNTIME_SOURCE:
                self.browser._event("Runtime.executionContextsCleared", {}, tab.session)
            return original(current_tab, method, params, *args, **kwargs)

        with patch.object(self.browser, "_send", side_effect=send):
            self.assertTrue(call(self.browser, "find", {"query": "Submit"}).get("is_error"))
        self.assertIsNone(tab.world)
        evaluations = [command for command in self.chrome.commands if command["method"] == "Runtime.evaluate"]
        self.assertEqual(len(evaluations), 1)
        self.assertEqual(evaluations[0]["params"]["expression"], RUNTIME_SOURCE)
        self.assertFalse(call(self.browser, "find", {"query": "Submit"}).get("is_error"))

    def test_failed_operation_is_not_replayed_or_reinstalled(self):
        self.assertFalse(call(self.browser, "find", {"query": "Submit"}).get("is_error"))
        before = len(self.chrome.commands)
        self.chrome.errors["Runtime.evaluate"] = {"code": -32000, "message": "lost action reply"}
        self.assertTrue(call(self.browser, "find", {"query": "Submit"}).get("is_error"))
        evaluations = [command for command in self.chrome.commands[before:] if command["method"] == "Runtime.evaluate"]
        self.assertEqual(len(evaluations), 1)
        self.assertNotEqual(evaluations[0]["params"]["expression"], RUNTIME_SOURCE)

    def test_all_standard_members_dispatch(self):
        target = {"type": "coordinate", "x": 20, "y": 30}
        cases = {
            "right_click": {"target": target},
            "middle_click": {"target": target},
            "double_click": {"target": target},
            "triple_click": {"target": target},
            "hover": {"target": target},
            "mouse_move": {"target": target},
            "left_mouse_down": {"target": target},
            "left_mouse_up": {"target": target},
            "left_click_drag": {"from": target, "target": {"type": "coordinate", "x": 40, "y": 60}},
            "scroll": {"target": target, "scroll_direction": "down", "scroll_amount": 1},
            "scroll_to": {"target": {"type": "ref", "ref": "ref_1"}},
            "type": {"text": "Hello\nWorld"},
            "key": {"text": "ctrl+a"},
            "hold_key": {"text": "shift", "duration": 1},
            "form_input": {"target": {"type": "ref", "ref": "ref_1"}, "value": "value"},
            "find": {"query": "Submit"},
            "get_page_text": {},
            "wait": {"duration": 0},
            "list_tabs": {},
        }
        with patch("e2b_claude_toolsets._browser.time.sleep", lambda _: None):
            for name, data in cases.items():
                with self.subTest(name=name):
                    self.assertFalse(call(self.browser, name, data).get("is_error"))

    def test_borrowed_cleanup_and_thread_exit(self):
        client = self.browser._cdp
        assert client is not None
        self.browser.close()
        self.browser.close()
        self.assertNotIn("kill-sandbox", self.desktop.calls)
        self.assertFalse(client._reader.is_alive())
        self.assertFalse(client._worker.is_alive())
        with self.assertRaises(Exception):
            call(self.browser, "wait", {"duration": 0})

    def test_runtime_cleanup_failure_is_retryable(self):
        runtime = BrowserRuntime()
        runtime.sandbox, runtime.owned = self.desktop, True
        self.desktop.fail = "kill"
        with self.assertRaises(RuntimeError):
            runtime.close()
        self.assertTrue(runtime.owned)
        self.desktop.fail = None
        runtime.close()
        runtime.close()
        self.assertFalse(runtime.owned)
        self.assertEqual(self.desktop.calls.count("kill-sandbox"), 2)

    def test_borrowed_input_cleanup_retries_before_disconnect(self):
        tab = self.browser._tab()
        tab.buttons = 1
        client = self.browser._cdp
        with patch.object(self.browser, "_mouse", side_effect=ToolError("failed release")):
            with self.assertRaises(RuntimeError):
                self.browser.close()
        self.assertEqual(tab.buttons, 1)
        self.assertIs(self.browser._cdp, client)
        self.browser.close()
        self.assertEqual(tab.buttons, 0)
        self.assertIsNone(self.browser._cdp)

    def test_failed_mouse_down_releases_and_state_changes_are_preserved(self):
        original = self.browser._mouse

        def mouse(tab, kind, point, **kwargs):
            if kind == "mousePressed":
                raise ToolError("lost acknowledgment")
            return original(tab, kind, point, **kwargs)

        with patch.object(self.browser, "_mouse", side_effect=mouse):
            result = call(self.browser, "left_mouse_down", {"target": {"type": "coordinate", "x": 0, "y": 0}})
        self.assertTrue(result["is_error"])
        self.assertFalse(self.browser._tab().buttons)
        self.assertTrue(any(c["params"].get("type") == "mouseReleased" for c in self.chrome.commands))
        self.browser._event("Browser.downloadWillBegin", {"guid": "fixture", "url": "https://example.com/file"}, None)
        result = call(self.browser, "list_tabs")
        state = next(b for b in result["content"] if b["type"] == "browser_state")
        self.assertEqual(state["state_changes"][0]["type"], "download_started")

    def test_worker_detach_preserves_the_real_tab(self):
        tab = self.browser._tab()
        self.browser._event("Target.detachedFromTarget", {"sessionId": "duplicate", "targetId": tab.target}, None)
        self.assertIs(self.browser._tab(), tab)
        self.browser._attached(
            {"sessionId": "worker", "targetInfo": {"targetId": "worker", "type": "worker"}, "waitingForDebugger": True},
            tab.session,
        )
        self.browser._client().send("Fixture.reply")
        methods = [m["method"] for m in self.chrome.commands if m.get("sessionId") == "worker"]
        self.assertEqual(methods, ["Runtime.runIfWaitingForDebugger"])
        self.assertFalse(self.browser._client().closed)

    def test_paused_worker_does_not_block_tab_events(self):
        self.chrome.resume_after_detach = True
        self.chrome.event(
            "Target.attachedToTarget",
            {"sessionId": "worker", "targetInfo": {"targetId": "worker", "type": "worker"}, "waitingForDebugger": True},
            self.browser._tab().session,
        )
        # The fixture withholds the resume reply until detach is sent. A blocking
        # resume prevents both detach and the following tab events from running.
        self.assertFalse(call(self.browser, "new_tab").get("is_error"))
        self.assertFalse(call(self.browser, "close_tab", {"tab_id": "tab_2"}).get("is_error"))
        self.assertFalse(self.chrome.pending_resume)
        self.assertFalse(self.browser._client().closed)

    def test_notification_flood_is_bounded_without_closing(self):
        for number in range(300):
            self.browser._event(
                "Browser.downloadWillBegin", {"guid": str(number), "url": f"https://example.com/{number}"}, None
            )
        self.assertEqual(len(self.browser._downloads), 100)
        self.assertEqual(len(self.browser._changes), 256)
        self.assertFalse(call(self.browser, "list_tabs").get("is_error"))

    def test_disconnected_borrowed_input_still_cleans_directory(self):
        tab = self.browser._tab()
        tab.buttons = 1
        self.browser._client().close()
        with self.assertRaisesRegex(RuntimeError, "borrowed Chrome input"):
            self.browser.close()
        self.assertIn(("remove", "/tmp/e2b-browser-abc123"), self.desktop.calls)
        self.assertNotIn("kill-sandbox", self.desktop.calls)
        tab.buttons = 0

    def test_disconnect_stops_owned_chrome_despite_blocked_event_handler(self):
        paused, release, finished = threading.Event(), threading.Event(), threading.Event()

        def blocked(*_):
            paused.set()
            release.wait(3)
            finished.set()

        self.browser._runtime.pid = 123
        self.browser._owns_browser = True
        client = self.browser._client()
        client.on("Fixture.blocked", blocked)
        self.chrome.event("Fixture.blocked", {})
        try:
            self.assertTrue(paused.wait(2))
            client._socket.close()
            deadline = time.monotonic() + 2
            while self.browser._runtime.pid is not None and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertIn(("kill", 123), self.desktop.calls)
            self.assertFalse(finished.is_set())
        finally:
            release.set()

    def test_invalid_configuration_keeps_its_explanation(self):
        for options, message in [(dict(api_key="TEST"), "apply only"), (dict(display="0"), "display")]:
            with self.assertRaisesRegex(ValueError, message):
                E2BBrowserToolset(sandbox=self.desktop, **options)


class ComputerTests(unittest.TestCase):
    def setUp(self):
        self.desktop = Desktop()
        self.computer = E2BComputerToolset(self.desktop, confirm=lambda _: True)
        self.addCleanup(self.computer.close)

    def test_coverage_and_required_confirmation(self):
        self.assertEqual(len(self.computer._toolset_options.served), 16)
        self.assertEqual(self.computer.configs, {"zoom": {"enabled": False}})
        with self.assertRaises(Exception):
            E2BComputerToolset(self.desktop)
        with E2BComputerToolset(self.desktop, confirm=lambda _: False) as c:
            self.assertTrue(call(c, "type", {"text": "secret"})["is_error"])
        self.assertNotIn(("write", "secret"), self.desktop.calls)

    def test_input_validation_zero_and_release(self):
        self.assertFalse(call(self.computer, "left_click", {"coordinate": [0, 0]}).get("is_error"))
        self.assertIn("xdotool mousemove 0 0 click --repeat 1 --delay 80 1", self.desktop.calls)
        before = len(self.desktop.calls)
        for name, data in [
            ("mouse_move", {"coordinate": [1280, 0]}),
            ("key", {"text": "ctrl+$(id)"}),
            ("hold_key", {"text": "shift", "duration": 31}),
        ]:
            self.assertTrue(call(self.computer, name, data)["is_error"])
        self.assertEqual(len(self.desktop.calls), before)
        self.desktop.fail = "keydown"
        with patch("e2b_claude_toolsets._computer.time.sleep", lambda _: None):
            self.assertTrue(call(self.computer, "hold_key", {"text": "shift", "duration": 1})["is_error"])
        self.assertIn("xdotool keyup shift", self.desktop.calls)
        self.desktop.fail = None
        self.assertFalse(self.computer._held_keys)
        self.desktop.fail = "mousedown"
        self.assertTrue(call(self.computer, "left_mouse_down")["is_error"])
        self.assertIn("xdotool mouseup 1", self.desktop.calls)
        self.assertFalse(self.computer._mouse_down)
        self.desktop.fail = None
        self.assertNotIn("PRIVATE-TRAFFIC-TOKEN", json.dumps(call(self.computer, "zoom", {"region": [0, 0, 1, 1]})))

    def test_all_members(self):
        cases = {
            "key": {"text": "ctrl+a"},
            "hold_key": {"text": "shift", "duration": 1},
            "type": {"text": "Hello"},
            "cursor_position": {},
            "mouse_move": {"coordinate": [0, 0]},
            "left_click": {},
            "right_click": {},
            "middle_click": {},
            "double_click": {},
            "triple_click": {},
            "left_mouse_down": {},
            "left_mouse_up": {},
            "left_click_drag": {"start_coordinate": [0, 0], "coordinate": [20, 30]},
            "scroll": {"scroll_direction": "left", "scroll_amount": 1},
            "wait": {"duration": 0},
            "screenshot": {},
        }
        with patch("e2b_claude_toolsets._computer.time.sleep", lambda _: None):
            for name, data in cases.items():
                with self.subTest(name=name):
                    self.assertFalse(call(self.computer, name, data).get("is_error"))
        self.computer.close()
        self.assertNotIn("kill-sandbox", self.desktop.calls)


class CdpTests(unittest.TestCase):
    def setUp(self):
        self.chrome = ChromeProtocol()
        self.client = CdpClient(self.chrome.url, {})
        self.addCleanup(self.chrome.close)
        self.addCleanup(self.client.close)

    def test_handler_can_issue_command_without_reader_deadlock(self):
        done = threading.Event()

        def handler(*_):
            self.client.send("Fixture.reply")
            done.set()

        self.client.on("Fixture.callback", handler)
        self.client.send("Fixture.event")
        self.assertTrue(done.wait(2))

    def test_diagnostic_flood_leaves_room_for_security_events(self):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def blocked(*_):
            entered.set()
            release.wait(3)

        self.client.on("Runtime.consoleAPICalled", blocked)
        self.client.on("Fetch.requestPaused", lambda *_: None)
        self.chrome.event("Runtime.consoleAPICalled", {})
        self.assertTrue(entered.wait(2))
        for _ in range(300):
            self.chrome.event("Runtime.consoleAPICalled", {})
        self.client.send("Fixture.reply")
        self.assertEqual(self.client._events.qsize(), 32)
        self.chrome.event("Fetch.requestPaused", {})
        self.client.send("Fixture.reply")
        self.assertFalse(self.client.closed)
        for _ in range(224):
            self.chrome.event("Fetch.requestPaused", {})
        self.assertTrue(self.client._closed.wait(2))
        release.set()

    def test_timeout_late_reply_and_disconnect(self):
        with self.assertRaises(ToolError):
            self.client.send("Fixture.never", timeout=0.01)
        self.assertFalse(self.client._pending)
        assert self.chrome.socket is not None
        self.chrome.socket.send(json.dumps({"id": 1, "result": {"late": True}}))
        self.client.send("Fixture.reply")
        pending = self.client.request("Fixture.never")
        with self.assertRaises(ToolError):
            self.client.send("Fixture.disconnect")
        with self.assertRaises(ToolError):
            self.client.result(pending)

    def test_event_commands_pipeline_and_classify_errors(self):
        self.chrome.reply_delay = 0.1
        started = time.monotonic()
        for _ in range(16):
            self.client.submit("Fixture.reply", {})
        self.client.send("Fixture.reply")
        self.assertLess(time.monotonic() - started, 1)  # Serial waits would take at least 1.7 seconds.
        self.chrome.errors["Fetch.continueRequest"] = {"code": -32602, "message": "Invalid InterceptionId."}
        self.client.submit("Fetch.continueRequest", {"requestId": "canceled"})
        self.client.send("Fixture.reply")
        self.assertFalse(self.client.closed)
        self.chrome.errors["Fetch.continueRequest"] = {"code": -32602, "message": "Invalid parameters"}
        self.client.submit("Fetch.continueRequest", {"requestId": "unexpected"})
        self.assertTrue(self.client._closed.wait(2))

    def test_unacknowledged_event_command_expires_and_cleans_up(self):
        cleaned = threading.Event()
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def blocked_handler(*_):
            entered.set()
            release.wait(3)

        self.client.on("Fixture.callback", blocked_handler)
        self.client.send("Fixture.event")
        self.assertTrue(entered.wait(2))
        self.client._on_disconnect = cleaned.set
        self.client.submit("Fixture.never", {})
        with self.client._lock:
            for ident in self.client._submitted:
                self.client._submitted[ident] = time.monotonic() - 1
        self.assertTrue(cleaned.wait(2))
        self.assertTrue(self.client.closed)
        self.assertFalse(self.client._pending)
        self.assertTrue(self.client._worker.is_alive())
        release.set()

    def test_pipeline_capacity_keeps_foreground_commands_available(self):
        for _ in range(96):
            self.client.submit("Fixture.never", {})
        sent = threading.Event()

        def submit():
            self.client.submit("Fixture.reply", {})
            sent.set()

        worker = threading.Thread(target=submit)
        worker.start()
        try:
            self.assertFalse(sent.wait(0.05))
            self.client.send("Fixture.reply")
            assert self.chrome.socket is not None
            self.chrome.socket.send(json.dumps({"id": 1, "result": {}}))
            self.assertTrue(sent.wait(2))
        finally:
            self.client.close()
            worker.join(2)


class PolicyTests(unittest.TestCase):
    def test_url_boundaries(self):
        policy = allow_hosts(["example.com", "localhost:8000"])
        for url in ["example.com", "https://sub.example.com/path", "http://localhost:8000", "about:blank"]:
            policy(BetaURLContext(), url)
        for url in [
            "https://example.com.evil.test",
            "java\nscript:alert(1)",
            "file:///etc/passwd",
            "http://localhost:9222",
            "http://2130706433:49983",
            "http://[::ffff:127.0.0.1]:6080",
            "https://user@example.com",
        ]:
            with self.subTest(url=url), self.assertRaises(ToolError):
                policy(BetaURLContext(), url)
        self.assertEqual(check_url("example.com"), "https://example.com")


class StartupTests(unittest.TestCase):
    def test_partial_creation_and_failed_cleanup_retains_handle(self):
        desktop = Desktop()

        def fail(runtime, **kwargs):
            runtime.sandbox, runtime.owned = desktop, True
            raise KeyboardInterrupt

        with patch.object(BrowserRuntime, "start", fail):
            with self.assertRaises(KeyboardInterrupt):
                E2BBrowserToolset()
            desktop.fail = "kill"
            with self.assertRaises(BrowserInitializationError) as raised:
                E2BBrowserToolset()
            desktop.fail = None
            raised.exception.close()
        self.assertEqual(desktop.calls.count("kill-sandbox"), 3)


class ApiParityTests(unittest.TestCase):
    def test_screen_limit_matches_typescript(self):
        from e2b_claude_toolsets._computer import screen_size

        self.assertEqual(screen_size(2560, 1440), (2560, 1440))
        self.assertEqual(screen_size(1920, 1200), (1920, 1200))
        for width, height in [(2560, 1600), (3840, 2160)]:
            with self.assertRaisesRegex(ValueError, "too large"):
                screen_size(width, height)
        with self.assertRaisesRegex(ValueError, "at least 200"):
            screen_size(100, 800)
        with self.assertRaisesRegex(ValueError, "too large"):
            E2BBrowserToolset(viewport=(3840, 2160))  # refused before anything starts

    def test_sync_create_and_exports(self):
        import e2b_claude_toolsets as package
        from e2b_claude_toolsets import E2BComputerToolset, ViewerInitializationError

        self.assertTrue(callable(E2BBrowserToolset.create) and callable(E2BComputerToolset.create))
        self.assertIn("ViewerInitializationError", package.__all__)
        self.assertTrue(issubclass(ViewerInitializationError, RuntimeError))


class HeadlessTests(unittest.TestCase):
    def test_where_chrome_shows(self):
        from types import SimpleNamespace

        from e2b_claude_toolsets._sandbox import resolve_display

        desktop = SimpleNamespace(_display=":0")  # e2b_desktop keeps its screen in _display
        public = SimpleNamespace(display=":2")
        plain = SimpleNamespace()
        self.assertEqual(resolve_display(desktop, None, None), ":0")
        self.assertEqual(resolve_display(public, None, None), ":2")
        self.assertIsNone(resolve_display(plain, None, None))
        self.assertIsNone(resolve_display(None, None, None))
        self.assertIsNone(resolve_display(desktop, True, None))
        self.assertEqual(resolve_display(desktop, False, None), ":0")
        self.assertEqual(resolve_display(desktop, None, ":1"), ":1")
        with self.assertRaisesRegex(ValueError, "contradict"):
            resolve_display(desktop, True, ":1")
        with self.assertRaisesRegex(ValueError, "needs a screen"):
            resolve_display(plain, False, None)
        with self.assertRaisesRegex(ValueError, "True, False or None"):
            resolve_display(desktop, "yes", None)


class StartupErrorRedactionTests(unittest.TestCase):
    SECRET = "e2b_SECRET_TOKEN_sentinel"

    def traceback_text(self, error):
        import traceback

        return "".join(traceback.format_exception(error))

    def test_failed_startup_and_cleanup_does_not_chain_the_raw_error(self):
        desktop = Desktop()
        secret = self.SECRET

        def fail(runtime, **kwargs):
            runtime.sandbox, runtime.owned = desktop, True
            raise RuntimeError(f"connect failed: wss://host?token={secret}")

        desktop.fail = "kill"
        with patch.object(BrowserRuntime, "start", fail), self.assertRaises(BrowserInitializationError) as raised:
            E2BBrowserToolset()
        self.assertNotIn(self.SECRET, self.traceback_text(raised.exception))
        desktop.fail = None
        raised.exception.close()

    def test_failed_startup_with_clean_cleanup_is_fixed_text(self):
        desktop = Desktop()
        secret = self.SECRET

        def fail(runtime, **kwargs):
            runtime.sandbox, runtime.owned = desktop, True
            raise RuntimeError(f"connect failed: wss://host?token={secret}")

        with patch.object(BrowserRuntime, "start", fail), self.assertRaises(RuntimeError) as raised:
            E2BBrowserToolset()
        self.assertNotIn(self.SECRET, self.traceback_text(raised.exception))


class InputLifecycleTests(unittest.TestCase):
    def test_failed_browser_release_is_retained_for_retry(self):
        from e2b_claude_toolsets import _input

        held = []
        events = []

        def fail_release(method, params):
            events.append(params)
            if params["type"] == "keyUp":
                raise ToolError("unavailable")

        with self.assertRaises(ToolError):
            _input.press(fail_release, "shift+a", held=held)
        self.assertEqual(events[-1]["type"], "keyUp")
        self.assertTrue(held)
        _input._release(lambda *_: None, held, 0)
        self.assertFalse(held)
        letters = [e for e in events if e["code"] == "KeyA" and e["type"] == "keyDown"]
        self.assertEqual(letters[0]["text"], "A")

    def test_close_drains_accepted_sdk_call(self):
        desktop = Desktop()
        entered, finish, closed = threading.Event(), threading.Event(), threading.Event()

        def write(text, **kwargs):
            entered.set()
            finish.wait(3)

        desktop.write = Mock(side_effect=write)
        self.addCleanup(finish.set)
        computer = E2BComputerToolset(desktop, confirm=lambda _: True)
        result = []
        active = threading.Thread(target=lambda: result.append(call(computer, "type", {"text": "test"})))
        closer = threading.Thread(target=lambda: (computer.close(), closed.set()))
        active.start()
        self.assertTrue(entered.wait(2))
        closer.start()
        deadline = time.monotonic() + 2
        while not computer._toolset_closed and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertFalse(closed.is_set())
        with self.assertRaises(Exception):
            call(computer, "wait", {"duration": 0})
        finish.set()
        active.join(3)
        closer.join(3)
        self.assertTrue(closed.is_set())
        self.assertFalse(result[0].get("is_error"))
        self.assertNotIn("kill-sandbox", desktop.calls)

    def test_browser_failure_reply_cannot_rewind_reserved_counter(self):
        from e2b_claude_toolsets._browser import E2BBrowserToolset

        browser = object.__new__(E2BBrowserToolset)
        browser._ref_next = 1
        browser._reserve_refs()
        reserved_next = browser._ref_next
        with (
            patch.object(
                browser,
                "_run",
                return_value={
                    "ok": False,
                    "error": {"code": "action_failed", "message": "covered by ref_8"},
                    "nextRef": 9,
                },
            ),
            self.assertRaises(ToolError),
        ):
            browser._page_call(None, "")
        self.assertEqual(browser._ref_next, reserved_next)

    def test_native_startup_options_and_borrowed_process_ownership(self):
        desktop = Desktop()
        runtime = BrowserRuntime()
        with (
            patch("e2b_claude_toolsets._sandbox.Sandbox.create", return_value=desktop) as create,
            patch.object(runtime, "_endpoint", return_value="/devtools/browser/fixture"),
        ):
            runtime.start(
                sandbox=None,
                api_key="TEST",
                template="desktop",
                timeout=600,
                viewport=(1280, 800),
                display=None,
                allow_out=["example.com"],
                metadata=None,
            )
            self.assertEqual(create.call_args.kwargs["timeout"], 600)
            self.assertFalse(create.call_args.kwargs["network"]["allow_public_traffic"])
            self.assertEqual(create.call_args.kwargs["network"]["mask_request_host"], "localhost:${PORT}")
            self.assertNotIn("TEST", str(desktop.calls))
        runtime.close()
        borrowed = BrowserRuntime()
        with patch.object(borrowed, "_endpoint", return_value="/devtools/browser/fixture"):
            borrowed.start(
                sandbox=desktop,
                api_key=None,
                template=None,
                timeout=None,
                viewport=(1280, 800),
                display=None,
                allow_out=None,
                metadata=None,
            )
        before = desktop.calls.count("kill-sandbox")
        borrowed.close()
        self.assertEqual(desktop.calls.count("kill-sandbox"), before)
        self.assertFalse(any(isinstance(c, tuple) and c[0] == "kill" for c in desktop.calls))


if __name__ == "__main__":
    unittest.main()
