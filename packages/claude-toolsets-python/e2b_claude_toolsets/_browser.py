"""The sync Anthropic browser contract on one private Chrome/CDP session."""

from __future__ import annotations

import math
import re
import threading
import time
from urllib.parse import urlsplit

from anthropic import NOT_GIVEN
from anthropic.tools import ToolError
from anthropic.tools.browser import (
    BetaAbstractBrowserToolset20260801,
    BetaBrowserNavigateResult,
    BetaBrowserState,
    BetaDialogDismissed,
    BetaNavigationRefused,
    BetaScreenshotResult,
    BetaURLContext,
)

from . import _input
from ._browser_state import BrowserStateMixin, Tab
from ._cdp import CdpClient, CdpProtocolError
from ._computer import duration, integer, screen_size
from ._policy import check_url, local_host
from ._sandbox import BrowserRuntime, resolve_display
from ._scripts import (
    RUNTIME_SOURCE,
    expression,
    file_input_expression,
    file_input_validation,
    runtime_result,
)
from ._uploads import prepare_uploads


class BrowserInitializationError(RuntimeError):
    """Startup cleanup failed. Call close() on this exception to retry releasing its resources."""

    def __init__(self, toolset):
        super().__init__("Browser initialization and cleanup failed; call error.close() to retry cleanup")
        self._toolset = toolset

    def close(self):
        self._toolset.close()


class E2BBrowserToolset(BrowserStateMixin, BetaAbstractBrowserToolset20260801):
    @classmethod
    def create(cls, **options):
        """Start or attach to the browser, as AsyncE2BBrowserToolset.create() does; the same as calling the class."""
        return cls(**options)

    """27 standard and four opt-in browser members on a caller-owned or created sandbox."""

    def __init__(
        self,
        *,
        sandbox=None,
        api_key=None,
        template=None,
        timeout=None,
        viewport=(1280, 800),
        headless=None,
        display=None,
        allow_out=None,
        metadata=None,
        upload_documents=None,
        configs=None,
        confirm=None,
        url_policy=NOT_GIVEN,
        file_policy=None,
        tool_configs=None,
    ):
        super().__init__(
            configs=configs, confirm=confirm, url_policy=url_policy, file_policy=file_policy, tool_configs=tool_configs
        )
        if len(viewport) != 2 or any(isinstance(n, bool) or not isinstance(n, int) for n in viewport):
            raise ValueError("viewport must contain two integers")
        screen_size(*viewport, what="viewport")
        if timeout is not None and (isinstance(timeout, bool) or not isinstance(timeout, int) or timeout <= 0):
            raise ValueError("timeout must be a positive number of seconds")
        display = resolve_display(sandbox, headless, display)  # before anything starts
        BrowserRuntime.validate_options(
            sandbox=sandbox,
            api_key=api_key,
            display=display,
            allow_out=allow_out,
            metadata=metadata,
            template=template,
            timeout=timeout,
        )
        self._initialize_state(viewport, url_policy, upload_documents)
        self._runtime = BrowserRuntime()
        self._cdp: CdpClient | None = None
        self._cleanup_lock = threading.Lock()
        try:
            url, headers = self._runtime.start(
                sandbox=sandbox,
                api_key=api_key,
                template=template,
                timeout=timeout,
                viewport=viewport,
                display=display,
                allow_out=allow_out,
                metadata=metadata,
            )
            self._owns_browser = self._runtime.owned or self._runtime.pid is not None
            self._runtime.stage = "browser connection"
            self._cdp = CdpClient(url, headers, on_disconnect=self._disconnected)
            self._runtime.stage = "browser protocol setup"
            self._listen(self._cdp, self._attached, self._event, self._toolset_options)
            self._client().send(
                "Browser.setDownloadBehavior",
                {
                    "behavior": "allowAndName",
                    "downloadPath": str(self._runtime.directory) + "/downloads",
                    "eventsEnabled": True,
                },
            )
            self._client().send("Target.setDiscoverTargets", {"discover": True})
            self._client().send(
                "Target.setAutoAttach", {"autoAttach": True, "waitForDebuggerOnStart": True, "flatten": True}
            )
            initial_pages = [
                info
                for info in self._client().send("Target.getTargets").get("targetInfos", [])
                if info["type"] == "page"
            ]
            for info in initial_pages:
                if not self._by_target(info["targetId"]):
                    self._client().send("Target.attachToTarget", {"targetId": info["targetId"], "flatten": True})
            if not initial_pages:
                self._client().send("Target.createTarget", {"url": "about:blank"})
            first = self._wait_tab(lambda: next(iter(self._tabs.values()), None))
            self._activate(first)
            with self._state_lock:
                self._started = True
                self._changes.clear()
        except BaseException as error:
            try:
                self.close()
            except BaseException:
                # from None: the startup error can carry provider details (hosts, tokens) that must not reach logs
                raise BrowserInitializationError(self) from None
            if isinstance(error, (KeyboardInterrupt, SystemExit)):
                raise
            raise RuntimeError(f"Could not initialize the browser toolset during {self._runtime.stage}") from None

    @property
    def sandbox(self):
        return self._runtime.sandbox

    def _client(self) -> CdpClient:
        if self._cdp is None or self._cdp.closed:
            raise ToolError(self._disconnect_error or "The browser connection is closed")
        return self._cdp

    def _disconnected(self) -> None:
        if self._closing:
            return
        if not self._owns_browser:
            self._disconnect_error = (
                "The browser connection is closed; URL policy is no longer enforced in caller-owned Chrome"
            )
            return
        try:
            self._runtime.stop_chrome()
        except Exception:
            self._disconnect_error = "The browser connection is closed; could not stop owned Chrome, retry close()"

    def _event_send(self, method, params, session=None) -> bool:
        try:
            self._client().send(method, params, session)
            return True
        except CdpProtocolError as error:
            if not error.stale:
                raise
            return False

    def _send(self, tab: Tab, method: str, params=None, timeout=30):
        return self._client().send(method, params, tab.session, timeout)

    def close(self) -> None:
        self._closing = True
        super().close()
        with self._cleanup_lock:
            if self._detached:
                return
            errors = []
            owned_sandbox = self._runtime.owned
            foreign_chrome = not (self._owns_browser or self._runtime.owned or self._runtime.pid is not None)
            for tab in tuple(self._tabs.values()):
                if tab.held_keys and self._cdp is not None and not self._cdp.closed:
                    try:
                        _input._release(lambda m, p: self._send(tab, m, p), tab.held_keys, 0)
                    except Exception:
                        errors.append("browser keys")
                if tab.buttons and self._cdp is not None and not self._cdp.closed:
                    try:
                        self._mouse(
                            tab,
                            "mouseReleased",
                            tab.point,
                            button={1: "left", 2: "right", 4: "middle"}.get(tab.buttons, "left"),
                            buttons=0,
                            clickCount=1,
                        )
                        tab.buttons = 0
                    except Exception:
                        errors.append("browser input")
            unreleased = foreign_chrome and any(tab.buttons or tab.held_keys for tab in self._tabs.values())
            if unreleased:
                errors.append("borrowed Chrome input (release it manually if disconnected)")
            if self._cdp is not None and not (unreleased and not self._cdp.closed):
                if self._runtime.pid is not None and not self._cdp.closed:
                    try:
                        self._cdp.send("Browser.close", timeout=5)
                    except Exception:
                        pass  # commands.kill remains the fallback for the owned process
                try:
                    self._cdp.close()
                    self._cdp = None
                except Exception:
                    errors.append("browser connection")
            try:
                if not self._runtime.owned:
                    for directory in tuple(self._upload_directories):
                        try:
                            self.sandbox.files.remove(directory)
                        except Exception:
                            errors.append("upload staging files")
                        else:
                            self._upload_bytes -= self._upload_directories.pop(directory)
                self._runtime.close()
                if owned_sandbox:
                    self._upload_directories.clear()
                    self._upload_bytes = 0
                if not foreign_chrome:
                    for tab in self._tabs.values():
                        tab.buttons = 0
                        tab.held_keys.clear()
                    errors = [error for error in errors if error not in {"browser keys", "browser input"}]
            except Exception:
                errors.append("browser runtime")
            if errors:
                raise RuntimeError("Could not release " + ", ".join(errors) + "; retry close()") from None

    def detach(self) -> None:
        """Leave borrowed Chrome running without interception before pause/fork. Reattach with fresh refs."""
        if self._detached:
            return
        if self._closing and not self._detaching:
            raise RuntimeError("detach: the toolset is already closed")
        if self._runtime.owned:
            raise ValueError("detach: this toolset owns its sandbox; use close()")
        if self._upload_directories or self._downloads:
            raise ValueError("detach: upload files are staged or a download is in progress; use close() or wait")
        self._closing = True
        super().close()
        with self._cleanup_lock:
            if self._detached:
                return
            if self._upload_directories or self._downloads:
                raise RuntimeError("detach: an accepted operation staged files; use close()")
            self._detaching = True
            client = self._client()
            for tab in tuple(self._tabs.values()):
                if tab.held_keys:
                    _input._release(lambda m, p: self._send(tab, m, p), tab.held_keys, 0)
                if tab.buttons:
                    self._mouse(tab, "mouseReleased", tab.point, button="left", buttons=0, clickCount=1)
                    tab.buttons = 0
            client.drain()
            sessions = [tab.session for tab in tuple(self._tabs.values())] + list(self._guarded)
            for session in sessions:
                self._event_send("Fetch.disable", {}, session)
            for session in [*sessions, None]:
                self._event_send(
                    "Target.setAutoAttach", dict(autoAttach=False, waitForDebuggerOnStart=False, flatten=True), session
                )
            for session in sessions:
                self._event_send("Target.detachFromTarget", dict(sessionId=session))
            client.drain()
            client.close()
            self._cdp = None
            # Ownership of Chrome, its profile and downloads passes to the caller.
            self._runtime.pid = self._runtime.directory = None
            self._owns_browser = False
            self._tabs.clear()
            self._guarded.clear()
            self._detached = True

    def _detach_target(self, session, waiting):
        # Do not block the event worker on a paused target. Resume may need later
        # target events to run; queue detach too and let CdpClient check both replies.
        client = self._client()
        if waiting:
            client.submit("Runtime.runIfWaitingForDebugger", {}, session)
        client.submit("Target.detachFromTarget", {"sessionId": session})

    def _attached(self, p, parent):
        info, session = p["targetInfo"], p["sessionId"]
        waiting = p.get("waitingForDebugger", False)
        client = self._client()
        if self._detaching:
            self._detach_target(session, waiting)
            return
        page = info["type"] == "page" and parent is None
        if page and self._by_target(info["targetId"]):
            self._detach_target(session, waiting)
            return
        if page and len(self._tabs) >= 100:
            client.send("Target.closeTarget", {"targetId": info["targetId"]})
            return
        tab = None
        if page:
            with self._state_lock:
                tab = Tab(
                    f"tab_{self._next_tab}", info["targetId"], session, info.get("url", ""), info.get("title", "")
                )
                tab.frame = tab.target
                self._next_tab += 1
                self._tabs[tab.id] = tab
                if self._started:
                    self._active = tab.id
                    self._activations += 1
                    tab.active_order = self._activations
                    self._change({"type": "tab_opened", "tab_id": tab.id})
        elif info["type"] in {"iframe", "service_worker", "shared_worker", "page"}:
            owner = self._by_session(parent)
            with self._state_lock:
                self._guarded[session] = owner.id if owner else self._guarded.get(parent)
        else:
            self._detach_target(session, waiting)
            return
        steps = self._target_setup(info, tab, waiting)
        resume_after = tab is None and waiting
        if resume_after:
            steps = [step for step in steps if step[0] != "Runtime.runIfWaitingForDebugger"]
        pending = [(method, client.request(method, params, session)) for method, params in steps]
        try:
            for method, request in pending:
                result = client.result(request)
                if method == "Page.getFrameTree" and tab:
                    tab.frame = result["frameTree"]["frame"]["id"]
            if resume_after:
                client.send("Runtime.runIfWaitingForDebugger", {}, session)
        except Exception:
            if tab:
                tab.failed = True
            owner_id = self._guarded.pop(session, None)
            if tab is None and waiting:
                # not closed: in a visible Chrome that closes the whole tab
                return
            closed = False
            try:
                closed = client.send("Target.closeTarget", {"targetId": info["targetId"]}).get("success") is not False
            except CdpProtocolError as error:
                closed = error.stale
            except Exception:
                pass
            if not closed:
                owner = self._tabs.get(owner_id)
                if owner is not None:
                    owner.failed = True
                    try:
                        client.send("Target.closeTarget", {"targetId": owner.target})
                    except Exception:
                        pass
                # no raise: a dropped connection lets Chrome resume paused targets
                return
            self._detach_target(session, False)
        finally:
            if tab:
                tab.ready.set()

    def _event(self, event, p, session):
        tab = self._by_session(session)
        if event == "Fetch.requestPaused":
            self._intercept(p, session, tab)
            return
        if event == "Page.javascriptDialogOpening":
            accept = p["type"] == "beforeunload"
            dismissed = self._event_send("Page.handleJavaScriptDialog", {"accept": accept}, session)
            if dismissed and not accept:
                self._change(BetaDialogDismissed(kind=p["type"], message=p.get("message", "")[:1000]))
            return
        self._record_event(event, p, session)

    def _intercept(self, p, session, tab):
        allowed = False
        url = p["request"]["url"]
        document = p["resourceType"] == "Document"
        try:
            parsed = urlsplit(url)
            local = local_host(parsed.hostname or "")
            if document or local:
                check_url(url)
                if self._policy is not NOT_GIVEN:
                    owner = tab.id if tab else self._guarded.get(session)
                    allowed = callable(self._policy) and self._policy(BetaURLContext(tab_id=owner), url) is None
                else:
                    allowed = True
            else:
                allowed = True  # public subresources are controlled by sandbox egress
        except Exception:
            allowed = False
        if not allowed:
            if document:
                self._change(BetaNavigationRefused())
            self._client().submit(
                "Fetch.failRequest", {"requestId": p["requestId"], "errorReason": "BlockedByClient"}, session
            )
        else:
            self._client().submit("Fetch.continueRequest", {"requestId": p["requestId"]}, session)

    def _wait_tab(self, find):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            self._client()
            with self._state_lock:
                tab = find()
            if tab and tab.ready.wait(0.02):
                if tab.failed:
                    raise ToolError("The tab could not be initialized safely")
                return tab
            time.sleep(0.02)
        raise ToolError("The tab did not open within 10 seconds")

    def _tab(self, ident=None):
        with self._state_lock:
            if ident is None:
                ident = self._reported_active if self._reported_active in self._tabs else self._active
            tab = self._tabs.get(ident)
        if tab is None:
            raise ToolError("The tab is not open; call list_tabs")
        if not tab.ready.wait(10) or tab.failed:
            raise ToolError("The tab is not ready")
        self._client()
        return tab

    def _activate(self, tab):
        self._send(tab, "Page.bringToFront")
        with self._state_lock:
            self._active = tab.id
            self._activations += 1
            tab.active_order = self._activations

    def _browser_state(self, context) -> BetaBrowserState:
        try:
            infos = self._client().send("Target.getTargets", timeout=5).get("targetInfos", [])
            with self._state_lock:
                live = {i["targetId"] for i in infos}
                for tab in tuple(self._tabs.values()):
                    if tab.target not in live:
                        self._tabs.pop(tab.id)
                    else:
                        info = next(i for i in infos if i["targetId"] == tab.target)
                        tab.url, tab.title = info.get("url", tab.url), info.get("title", tab.title)
        except Exception:
            pass  # Report the last registry, including after a failed/disconnected action.
        with self._state_lock:
            if self._active not in self._tabs:
                recent = max(self._tabs.values(), key=lambda t: t.active_order, default=None)
                self._active = recent.id if recent else None
            changes, self._changes = self._changes, []
            self._reported_active = self._active
            return BetaBrowserState(tabs=[self._entry(t) for t in self._tabs.values()], state_changes=changes)

    def _runtime_world(self, tab):
        if tab.world is not None:
            return tab.world
        generation = tab.world_generation
        context_id = self._send(tab, "Page.createIsolatedWorld", {"frameId": tab.frame, "worldName": self._world_name})[
            "executionContextId"
        ]
        if generation != tab.world_generation:
            raise ToolError("The page changed while creating its runtime")
        installed = self._send(
            tab, "Runtime.evaluate", {"expression": RUNTIME_SOURCE, "contextId": context_id, "returnByValue": True}
        )
        if installed.get("exceptionDetails"):
            raise ToolError("The browser runtime could not be installed")
        with self._state_lock:
            if generation != tab.world_generation:
                raise ToolError("The page changed while installing its runtime")
            tab.world = context_id
        return context_id

    def _run(self, tab, script):
        context_id = self._runtime_world(tab)
        result = self._send(
            tab,
            "Runtime.evaluate",
            {"expression": script, "contextId": context_id, "returnByValue": True, "awaitPromise": True},
        )
        if result.get("exceptionDetails"):
            raise ToolError("The page script failed; read_page again after navigation")
        return result.get("result", {}).get("value")

    def _page_call(self, tab, script):
        try:
            result = runtime_result(self._run(tab, script))
        except ValueError:
            raise ToolError("The page did not return a valid runtime result") from None
        if not result["ok"]:
            raise ToolError(result["error"]["message"])
        return result["value"]

    def _point(self, tab, target, action="click"):
        if target.type == "ref":
            result = self._page_call(
                tab, expression("resolve", {"ref": target.ref, "action": action, "base": self._reserve_refs()})
            )
            x, y = result["x"], result["y"]
            if not all(math.isfinite(v) for v in (x, y)) or not (
                0 <= x < self._viewport[0] and 0 <= y < self._viewport[1]
            ):
                raise ToolError("The element resolved outside the viewport")
            return x, y
        return self._coordinate(target)

    def _mouse(self, tab, kind, point, **extra):
        tab.point = point
        return self._send(tab, "Input.dispatchMouseEvent", {"type": kind, "x": point[0], "y": point[1], **extra})

    def _settle(self, tab, sequence, navigation=True):
        time.sleep(0.3)
        if not navigation:
            return
        # ponytail: bounded settle window; more precise action/navigation correlation if delayed pages demand it.
        deadline = time.monotonic() + 0.3
        while time.monotonic() < deadline and tab.sequence == sequence and not tab.loading:
            time.sleep(0.025)
        deadline = time.monotonic() + 10
        while tab.loading and time.monotonic() < deadline:
            self._client()
            time.sleep(0.025)
        # Input was acknowledged; a slow navigation must not encourage replay of the action.

    def _check_policy(self, tab, url):
        if self._policy is NOT_GIVEN:
            return
        try:
            if not callable(self._policy) or self._policy(BetaURLContext(tab_id=tab.id), url) is not None:
                raise ValueError
        except Exception:
            raise ToolError("Navigation policy refused or failed") from None

    def navigate(self, context, input) -> BetaBrowserNavigateResult:
        tab = self._tab(input.tab_id)
        url = input.url
        before, sequence = tab.loader, tab.sequence
        if url in {"back", "forward"}:
            history = self._send(tab, "Page.getNavigationHistory")
            index = history["currentIndex"] + (-1 if url == "back" else 1)
            if not 0 <= index < len(history["entries"]):
                raise ToolError("No history entry in that direction")
            entry = history["entries"][index]
            check_url(entry["url"])
            self._check_policy(tab, entry["url"])
            result = self._send(tab, "Page.navigateToHistoryEntry", {"entryId": entry["id"]})
        elif url == "reload":
            check_url(tab.url)
            self._check_policy(tab, tab.url)
            result = self._send(tab, "Page.reload")
        else:
            result = self._send(tab, "Page.navigate", {"url": check_url(url)})
        if result.get("errorText"):
            raise ToolError("Navigation failed or was refused")
        if result.get("isDownload"):
            raise ToolError("The address started a download; see browser_state")
        loader = result.get("loaderId")
        if loader:
            deadline = time.monotonic() + 30
            while loader not in tab.loaded:
                if tab.loader not in {None, before, loader} and tab.loader in tab.loaded:
                    loader = tab.loader
                    break
                if time.monotonic() >= deadline:
                    raise ToolError("Navigation did not load within 30 seconds")
                self._client()
                time.sleep(0.025)
        else:
            self._settle(tab, sequence)
        info = self._client().send("Target.getTargetInfo", {"targetId": tab.target})["targetInfo"]
        tab.url, tab.title = info["url"], info["title"]
        return BetaBrowserNavigateResult(url=tab.url, title=tab.title, status=tab.status.get(loader or tab.loader))

    def _capture(self, tab, params):
        background = tab.id != self._active
        if background:
            self._send(tab, "Page.bringToFront")
        try:
            shot = self._send(tab, "Page.captureScreenshot", {"format": "png", **params}, timeout=10)
            return BetaScreenshotResult(data=shot["data"], media_type="image/png")
        finally:
            if background and self._active in self._tabs:
                self._send(self._tabs[self._active], "Page.bringToFront")

    def screenshot(self, context, input) -> BetaScreenshotResult:
        return self._capture(self._tab(input.tab_id), {})

    def zoom(self, context, input) -> BetaScreenshotResult:
        tab = self._tab(input.tab_id)
        if len(input.region) != 4:
            raise ToolError("region must be [x0, y0, x1, y1]")
        x0, y0, x1, y1 = input.region
        width, height = self._viewport
        if not (0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height):
            raise ToolError("region must fit the viewport")
        view = self._send(tab, "Page.getLayoutMetrics")["cssVisualViewport"]
        return self._capture(
            tab,
            {
                "clip": {
                    "x": x0 + view["pageX"],
                    "y": y0 + view["pageY"],
                    "width": x1 - x0,
                    "height": y1 - y0,
                    "scale": min(width / (x1 - x0), height / (y1 - y0)),
                }
            },
        )

    def _click(self, input, button="left", count=1):
        tab = self._tab(input.tab_id)
        bits = _input.modifiers(input.modifiers)
        point = self._point(tab, input.target)
        sequence = tab.sequence
        self._mouse(tab, "mouseMoved", point, modifiers=bits)
        for n in range(1, count + 1):
            try:
                tab.buttons = {"left": 1, "right": 2, "middle": 4}[button]
                self._mouse(
                    tab, "mousePressed", point, button=button, buttons=tab.buttons, clickCount=n, modifiers=bits
                )
            finally:
                self._mouse(tab, "mouseReleased", point, button=button, buttons=0, clickCount=n, modifiers=bits)
                tab.buttons = 0
        self._settle(tab, sequence)

    def left_click(self, context, input) -> None:
        self._click(input)

    def right_click(self, context, input) -> None:
        self._click(input, "right")

    def middle_click(self, context, input) -> None:
        self._click(input, "middle")

    def double_click(self, context, input) -> None:
        self._click(input, count=2)

    def triple_click(self, context, input) -> None:
        self._click(input, count=3)

    def hover(self, context, input) -> None:
        tab = self._tab(input.tab_id)
        self._mouse(tab, "mouseMoved", self._point(tab, input.target, "hover"))
        self._settle(tab, tab.sequence, False)

    def mouse_move(self, context, input) -> None:
        tab = self._tab(input.tab_id)
        self._mouse(tab, "mouseMoved", self._coordinate(input.target), buttons=tab.buttons)

    def left_mouse_down(self, context, input) -> None:
        tab = self._tab(input.tab_id)
        point = self._coordinate(input.target)
        tab.buttons = 1
        try:
            self._mouse(tab, "mouseMoved", point)
            self._mouse(tab, "mousePressed", point, button="left", buttons=1, clickCount=1)
        except BaseException:
            self._mouse(tab, "mouseReleased", point, button="left", buttons=0, clickCount=1)
            tab.buttons = 0
            raise

    def left_mouse_up(self, context, input) -> None:
        tab = self._tab(input.tab_id)
        point = self._coordinate(input.target)
        self._mouse(tab, "mouseReleased", point, button="left", buttons=0, clickCount=1)
        tab.buttons = 0
        self._settle(tab, tab.sequence)

    def left_click_drag(self, context, input) -> None:
        tab = self._tab(input.tab_id)
        start, end = self._coordinate(input.from_), self._coordinate(input.target)
        sequence = tab.sequence
        try:
            self._mouse(tab, "mouseMoved", start)
            tab.buttons = 1
            self._mouse(tab, "mousePressed", start, button="left", buttons=1, clickCount=1)
            steps = min(50, max(10, math.ceil(math.dist(start, end) / 20)))
            for n in range(1, steps + 1):
                point = (start[0] + (end[0] - start[0]) * n / steps, start[1] + (end[1] - start[1]) * n / steps)
                self._mouse(tab, "mouseMoved", point, button="left", buttons=1)
        finally:
            self._mouse(tab, "mouseReleased", tab.point, button="left", buttons=0, clickCount=1)
            tab.buttons = 0
        self._settle(tab, sequence)

    def scroll(self, context, input) -> None:
        tab = self._tab(input.tab_id)
        point = self._coordinate(input.target)
        amount = integer(3 if input.scroll_amount is None else input.scroll_amount, "scroll_amount", 10)
        delta = amount * 100
        dx = -delta if input.scroll_direction == "left" else delta if input.scroll_direction == "right" else 0
        dy = -delta if input.scroll_direction == "up" else delta if input.scroll_direction == "down" else 0
        self._mouse(tab, "mouseWheel", point, deltaX=dx, deltaY=dy)
        self._settle(tab, tab.sequence, False)

    def scroll_to(self, context, input) -> None:
        tab = self._tab(input.tab_id)
        self._page_call(tab, expression("scroll_to", {"ref": input.target.ref, "base": self._reserve_refs()}))
        self._settle(tab, tab.sequence, False)

    def type(self, context, input) -> None:
        tab = self._tab(input.tab_id)
        sequence = tab.sequence
        _input.type_text(lambda m, p: self._send(tab, m, p), input.text, held=tab.held_keys)
        self._settle(tab, sequence)

    def key(self, context, input) -> None:
        tab = self._tab(input.tab_id)
        sequence = tab.sequence
        repeat = integer(1 if input.repeat is None else input.repeat, "repeat", 100)
        _input.press(lambda m, p: self._send(tab, m, p), input.text, repeat, held=tab.held_keys)
        self._settle(tab, sequence)

    def hold_key(self, context, input) -> None:
        tab = self._tab(input.tab_id)
        _input.press(lambda m, p: self._send(tab, m, p), input.text, hold=duration(input.duration), held=tab.held_keys)
        self._settle(tab, tab.sequence, False)

    def form_input(self, context, input) -> str:
        tab = self._tab(input.tab_id)
        outcome = self._page_call(
            tab,
            expression("form_input", {"ref": input.target.ref, "value": input.value, "base": self._reserve_refs()}),
        )
        self._settle(tab, tab.sequence, False)
        return outcome.get("summary", "")

    def read_page(self, context, input) -> str:
        tab = self._tab(input.tab_id)
        if input.depth is not None and input.depth < 1:
            raise ToolError("depth must be a positive integer")
        return self._ref_text(
            self._page_call(
                tab,
                expression(
                    "read_page",
                    {
                        "filter": input.filter,
                        "ref": input.ref,
                        "depth": max(1, min(input.depth or 15, 100)),
                        "cap": 50000,
                        "base": self._reserve_refs(),
                    },
                ),
            )
        )

    def find(self, context, input) -> str:
        tab = self._tab(input.tab_id)
        if not input.query.strip():
            raise ToolError("query must describe the element to find")
        return (
            self._ref_text(
                self._page_call(tab, expression("find", {"query": input.query, "base": self._reserve_refs()}))
            )
            or "No element matches; try read_page"
        )

    def get_page_text(self, context, input) -> str:
        return self._ref_text(
            self._page_call(
                self._tab(input.tab_id), expression("page_text", {"max": 30000, "base": self._reserve_refs()})
            )
        )

    def wait(self, context, input) -> None:
        if input.tab_id is not None:
            self._tab(input.tab_id)
        time.sleep(duration(input.duration))

    def file_upload(self, context, input) -> None:
        tab = self._tab(input.tab_id)
        paths, documents = input.paths or [], input.document_ids or []
        count = len(paths) + len(documents)
        sequence, requests, generation = tab.sequence, tab.nav_requests, tab.world_generation
        target = self._send(
            tab,
            "Runtime.evaluate",
            dict(
                expression=file_input_expression(input.target.ref, count, self._reserve_refs()),
                contextId=self._runtime_world(tab),
                returnByValue=False,
                awaitPromise=True,
            ),
        )
        remote = target.get("result", {})
        object_id = remote.get("objectId")
        if not object_id or target.get("exceptionDetails"):
            raise ToolError("file_upload: target could not be resolved")
        directory = None
        selected = False
        try:
            if remote.get("subtype") != "node":
                raise ToolError("file_upload: target must be an enabled file input permitting these files")
            node = self._send(tab, "DOM.describeNode", dict(objectId=object_id))["node"]["backendNodeId"]
            files = prepare_uploads(paths, documents, self._upload_documents)
            size = sum(len(file.data) for file in files)
            if self._upload_bytes + size > 50 * 1024 * 1024 or len(self._upload_directories) >= 100:
                raise ToolError("file_upload: session staging limit reached; close and start a new session")
            try:
                result = self.sandbox.commands.run("umask 077; mktemp -d /tmp/e2b-browser-upload.XXXXXX", timeout=5)
                candidate = result.stdout.strip()
                if not re.fullmatch(r"/tmp/e2b-browser-upload\.[A-Za-z0-9]+", candidate):
                    raise ValueError
                directory = candidate
                self._upload_directories[directory] = size
                self._upload_bytes += size
                staged = []
                for index, file in enumerate(files):
                    folder = f"{directory}/{index}"
                    self.sandbox.files.make_dir(folder)
                    path = folder + "/" + file.name
                    self.sandbox.files.write(path, file.data)
                    staged.append(path)
            except Exception:
                raise ToolError("file_upload: could not stage approved files") from None
            if (tab.sequence, tab.nav_requests, tab.world_generation) != (sequence, requests, generation):
                raise ToolError("file_upload: page changed while staging files; inspect it and retry")
            valid = self._send(
                tab,
                "Runtime.callFunctionOn",
                dict(
                    objectId=object_id,
                    functionDeclaration=file_input_validation(input.target.ref, count, self._reserve_refs()),
                    returnByValue=True,
                    awaitPromise=True,
                ),
            )
            if valid.get("result", {}).get("value") is not True:
                raise ToolError("file_upload: target changed while staging files")
            # Set before sending: a lost acknowledgment may still have selected these files.
            selected = True
            self._send(tab, "DOM.setFileInputFiles", dict(backendNodeId=node, files=staged))
            self._settle(tab, sequence)
        finally:
            try:
                self._send(tab, "Runtime.releaseObject", dict(objectId=object_id))
            except Exception:
                pass
            if directory is not None and not selected:
                try:
                    self.sandbox.files.remove(directory)
                except Exception:
                    pass  # Retain the cleanup handle and quota for close().
                else:
                    self._upload_bytes -= self._upload_directories.pop(directory)

    def javascript_exec(self, context, input) -> str:
        tab = self._tab(input.tab_id)
        sequence = tab.sequence
        group = self._world_name + "-script"
        promise_result = None
        try:
            evaluated = self._send(
                tab,
                "Runtime.evaluate",
                dict(
                    expression=input.text,
                    awaitPromise=True,
                    returnByValue=False,
                    replMode=True,
                    userGesture=True,
                    objectGroup=group,
                ),
            )
            remote = evaluated.get("result", {})
            if remote.get("subtype") == "promise" and remote.get("objectId") and not evaluated.get("exceptionDetails"):
                evaluated = self._send(tab, "Runtime.awaitPromise", dict(promiseObjectId=remote["objectId"]))
                remote = evaluated.get("result", {})
                promise_result = remote.get("objectId")
            if evaluated.get("exceptionDetails"):
                raise ToolError("The page script threw an exception; inspect read_console")
            if remote.get("objectId") and remote.get("subtype") != "node":
                value = self._send(
                    tab,
                    "Runtime.callFunctionOn",
                    dict(
                        objectId=remote["objectId"],
                        returnByValue=True,
                        functionDeclaration="function(){try{return JSON.stringify(this,null,2) ?? String(this)}catch{return String(this)}}",
                    ),
                )
                text = value.get("result", {}).get("value")
                if not isinstance(text, str):
                    text = self._describe(remote)
            else:
                text = self._describe(remote)
            self._settle(tab, sequence)
            return text[:50000]
        finally:
            # awaitPromise results need not belong to the evaluation's object group.
            for method, params in [
                ("Runtime.releaseObject", dict(objectId=promise_result)),
                ("Runtime.releaseObjectGroup", dict(objectGroup=group)),
            ]:
                if method == "Runtime.releaseObject" and promise_result is None:
                    continue
                try:
                    self._send(tab, method, params)
                except Exception:
                    pass

    def read_console(self, context, input) -> str:
        return self._console_text(self._tab(input.tab_id))

    def read_network(self, context, input) -> str:
        return self._network_text(self._tab(input.tab_id))

    def new_tab(self, context, input):
        result = self._client().send("Target.createTarget", {"url": "about:blank"})
        tab = self._wait_tab(lambda: self._by_target(result["targetId"]))
        self._activate(tab)
        return self._entry(tab)

    def list_tabs(self, context, input):
        self._client()
        with self._state_lock:
            return [self._entry(t) for t in self._tabs.values()]

    def switch_tab(self, context, input):
        tab = self._tab(input.tab_id)
        self._activate(tab)
        return self._entry(tab)

    def close_tab(self, context, input) -> None:
        tab = self._tab(input.tab_id)
        with self._state_lock:
            if len(self._tabs) <= 1:
                raise ToolError("Cannot close the last tab; navigate it to about:blank")
        self._client().send("Target.closeTarget", {"targetId": tab.target})
        deadline = time.monotonic() + 5
        while tab.id in self._tabs and time.monotonic() < deadline:
            self._client()
            time.sleep(0.025)
        if tab.id in self._tabs:
            raise ToolError("The tab did not close")
        if self._active in self._tabs:
            self._activate(self._tabs[self._active])
