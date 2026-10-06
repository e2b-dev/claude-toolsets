"""Native asyncio browser toolset; the DOM runtime and state contract match the sync driver."""

from __future__ import annotations

import asyncio
import inspect
import math
import re
import time
from urllib.parse import urlsplit

from anthropic import NOT_GIVEN
from anthropic.tools import ToolError
from anthropic.tools.browser import (
    BetaAsyncAbstractBrowserToolset20260801,
    BetaBrowserNavigateResult,
    BetaBrowserState,
    BetaDialogDismissed,
    BetaNavigationRefused,
    BetaScreenshotResult,
    BetaURLContext,
)

from . import _input
from ._async import finish_cleanup
from ._async_cdp import AsyncCdpClient
from ._async_sandbox import AsyncBrowserRuntime
from ._browser_state import BrowserStateMixin, Tab
from ._cdp import CdpProtocolError
from ._computer import duration, integer, screen_size
from ._policy import check_url, local_host
from ._sandbox import resolve_display
from ._scripts import (
    FILE_INPUT_VALIDATION,
    RUNTIME_SOURCE,
    expression,
    file_input_expression,
    file_input_validation_arguments,
    runtime_result,
)
from ._uploads import prepare_uploads


class AsyncBrowserInitializationError(RuntimeError):
    """Failed startup cleanup retains a toolset; await error.close() to retry."""

    def __init__(self, toolset):
        super().__init__("Browser initialization and cleanup failed; await error.close() to retry cleanup")
        self._toolset = toolset

    async def close(self):
        await self._toolset.close()


class AsyncE2BBrowserToolset(BrowserStateMixin, BetaAsyncAbstractBrowserToolset20260801):
    """Use await create(...), then async with. All 31 members use native async I/O."""

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
        if sandbox is not None and not inspect.iscoroutinefunction(sandbox.commands.run):
            raise ValueError("AsyncE2BBrowserToolset requires e2b.AsyncSandbox")
        if len(viewport) != 2 or any((isinstance(n, bool) or not isinstance(n, int) for n in viewport)):
            raise ValueError("viewport must contain two integers")
        screen_size(*viewport, what="viewport")
        if timeout is not None and (isinstance(timeout, bool) or not isinstance(timeout, int) or timeout <= 0):
            raise ValueError("timeout must be a positive number of seconds")
        display = resolve_display(sandbox, headless, display)  # before anything starts
        AsyncBrowserRuntime.validate_options(
            sandbox=sandbox,
            api_key=api_key,
            display=display,
            allow_out=allow_out,
            metadata=metadata,
            template=template,
            timeout=timeout,
        )
        self._initialize_state(viewport, url_policy, upload_documents)
        self._runtime = AsyncBrowserRuntime()
        self._cdp: AsyncCdpClient | None = None
        self._cleanup_lock = asyncio.Lock()
        self._start_options = dict(
            sandbox=sandbox,
            api_key=api_key,
            template=template,
            timeout=timeout,
            viewport=viewport,
            display=display,
            allow_out=allow_out,
            metadata=metadata,
        )

    @classmethod
    async def create(cls, **options):
        toolset = cls(**options)
        try:
            await toolset._initialize()
        except BaseException as error:
            try:
                await toolset.close()
            except BaseException:
                # from None: the startup error can carry provider details (hosts, tokens) that must not reach logs
                raise AsyncBrowserInitializationError(toolset) from None
            if isinstance(error, (asyncio.CancelledError, KeyboardInterrupt, SystemExit)):
                raise
            raise RuntimeError(f"Could not initialize the browser toolset during {toolset._runtime.stage}") from None
        finally:
            toolset._start_options.clear()
        return toolset

    async def _initialize(self):
        url, headers = await self._runtime.start(**self._start_options)
        self._owns_browser = self._runtime.owned or self._runtime.pid is not None
        self._runtime.stage = "browser connection"
        self._cdp = await AsyncCdpClient.connect(url, headers, on_disconnect=self._disconnected)
        self._runtime.stage = "browser protocol setup"
        self._listen(self._cdp, self._attached, self._event, self._toolset_options)
        await self._client().send(
            "Browser.setDownloadBehavior",
            {
                "behavior": "allowAndName",
                "downloadPath": str(self._runtime.directory) + "/downloads",
                "eventsEnabled": True,
            },
        )
        await self._client().send("Target.setDiscoverTargets", {"discover": True})
        await self._client().send(
            "Target.setAutoAttach", {"autoAttach": True, "waitForDebuggerOnStart": True, "flatten": True}
        )
        initial_pages = [
            info
            for info in (await self._client().send("Target.getTargets")).get("targetInfos", [])
            if info["type"] == "page"
        ]
        for info in initial_pages:
            if not self._by_target(info["targetId"]):
                await self._client().send("Target.attachToTarget", {"targetId": info["targetId"], "flatten": True})
        if not initial_pages:
            await self._client().send("Target.createTarget", {"url": "about:blank"})
        first = await self._wait_tab(lambda: next(iter(self._tabs.values()), None))
        await self._activate(first)
        with self._state_lock:
            self._started = True
            self._changes.clear()

    @property
    def sandbox(self):
        return self._runtime.sandbox

    async def __aenter__(self):
        if not self._started:
            raise RuntimeError("Use await AsyncE2BBrowserToolset.create(...) before entering the context")
        return await super().__aenter__()

    def _client(self) -> AsyncCdpClient:
        if self._cdp is None or self._cdp.closed:
            raise ToolError(self._disconnect_error or "The browser connection is closed")
        return self._cdp

    async def _disconnected(self) -> None:
        if self._closing:
            return
        if not self._owns_browser:
            self._disconnect_error = (
                "The browser connection is closed; URL policy is no longer enforced in caller-owned Chrome"
            )
            return
        try:
            await self._runtime.stop_chrome()
        except Exception:
            self._disconnect_error = "The browser connection is closed; could not stop owned Chrome, retry close()"

    async def _event_send(self, method, params, session=None) -> bool:
        try:
            await self._client().send(method, params, session)
            return True
        except CdpProtocolError as error:
            if not error.stale:
                raise
            return False

    async def _send(self, tab: Tab, method: str, params=None, timeout=30):
        return await self._client().send(method, params, tab.session, timeout)

    async def close(self) -> None:
        self._closing = True
        await self._drain_then(self._cleanup)

    async def _drain_then(self, cleanup):
        sdk_close = super().close
        try:
            await sdk_close()
        except asyncio.CancelledError:

            async def finish():
                await sdk_close()
                await cleanup()

            await finish_cleanup(finish())
            raise
        await finish_cleanup(cleanup())

    async def _cleanup(self):
        async with self._cleanup_lock:
            if self._detached:
                return
            errors = []
            owned_sandbox = self._runtime.owned
            foreign_chrome = not (self._owns_browser or self._runtime.owned or self._runtime.pid is not None)
            for tab in tuple(self._tabs.values()):
                if tab.held_keys and self._cdp is not None and (not self._cdp.closed):
                    try:
                        await _input.release_async(lambda m, p: self._send(tab, m, p), tab.held_keys, 0)
                    except Exception:
                        errors.append("browser keys")
                if tab.buttons and self._cdp is not None and (not self._cdp.closed):
                    try:
                        await self._mouse(
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
            unreleased = foreign_chrome and any((tab.buttons or tab.held_keys for tab in self._tabs.values()))
            if unreleased:
                errors.append("borrowed Chrome input (release it manually if disconnected)")
            if self._cdp is not None and (not (unreleased and (not self._cdp.closed))):
                if self._runtime.pid is not None and (not self._cdp.closed):
                    try:
                        await self._cdp.send("Browser.close", timeout=5)
                    except Exception:
                        pass
                try:
                    await self._cdp.close()
                    self._cdp = None
                except Exception:
                    errors.append("browser connection")
            try:
                if not self._runtime.owned:
                    for directory in tuple(self._upload_directories):
                        try:
                            await self.sandbox.files.remove(directory)
                        except Exception:
                            errors.append("upload staging files")
                        else:
                            self._upload_bytes -= self._upload_directories.pop(directory)
                await self._runtime.close()
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

    async def detach(self) -> None:
        """Leave borrowed Chrome running without interception before pause/fork. Reattach with fresh refs."""
        if self._detached:
            return
        if self._closing and (not self._detaching):
            raise RuntimeError("detach: the toolset is already closed")
        if self._runtime.owned:
            raise ValueError("detach: this toolset owns its sandbox; use close()")
        if self._upload_directories or self._downloads:
            raise ValueError("detach: upload files are staged or a download is in progress; use close() or wait")
        self._closing = True
        await self._drain_then(self._detach)

    async def _detach(self):
        async with self._cleanup_lock:
            if self._detached:
                return
            if self._upload_directories or self._downloads:
                raise RuntimeError("detach: an accepted operation staged files; use close()")
            self._detaching = True
            client = self._client()
            for tab in tuple(self._tabs.values()):
                if tab.held_keys:
                    await _input.release_async(lambda m, p: self._send(tab, m, p), tab.held_keys, 0)
                if tab.buttons:
                    await self._mouse(tab, "mouseReleased", tab.point, button="left", buttons=0, clickCount=1)
                    tab.buttons = 0
            await client.drain()
            sessions = [tab.session for tab in tuple(self._tabs.values())] + list(self._guarded)
            for session in sessions:
                await self._event_send("Fetch.disable", {}, session)
            for session in [*sessions, None]:
                await self._event_send(
                    "Target.setAutoAttach", dict(autoAttach=False, waitForDebuggerOnStart=False, flatten=True), session
                )
            for session in sessions:
                await self._event_send("Target.detachFromTarget", dict(sessionId=session))
            await client.drain()
            await client.close()
            self._cdp = None
            self._runtime.pid = self._runtime.directory = None
            self._owns_browser = False
            self._tabs.clear()
            self._guarded.clear()
            self._detached = True

    async def _detach_target(self, session, waiting):
        client = self._client()
        if waiting:
            await client.submit("Runtime.runIfWaitingForDebugger", {}, session)
        await client.submit("Target.detachFromTarget", {"sessionId": session})

    async def _attached(self, p, parent):
        info, session = (p["targetInfo"], p["sessionId"])
        waiting = p.get("waitingForDebugger", False)
        client = self._client()
        if self._detaching:
            await self._detach_target(session, waiting)
            return
        page = info["type"] == "page" and parent is None
        if page and self._by_target(info["targetId"]):
            await self._detach_target(session, waiting)
            return
        if page and len(self._tabs) >= 100:
            await client.send("Target.closeTarget", {"targetId": info["targetId"]})
            return
        tab = None
        if page:
            with self._state_lock:
                tab = Tab(
                    f"tab_{self._next_tab}", info["targetId"], session, info.get("url", ""), info.get("title", "")
                )
                tab.ready = asyncio.Event()
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
            await self._detach_target(session, waiting)
            return
        steps = self._target_setup(info, tab, waiting)
        resume_after = tab is None and waiting
        if resume_after:
            steps = [step for step in steps if step[0] != "Runtime.runIfWaitingForDebugger"]
        pending = [(method, await client.request(method, params, session)) for method, params in steps]
        try:
            for method, request in pending:
                result = await client.result(request)
                if method == "Page.getFrameTree" and tab:
                    tab.frame = result["frameTree"]["frame"]["id"]
            if resume_after:
                await client.send("Runtime.runIfWaitingForDebugger", {}, session)
        except Exception:
            if tab:
                tab.failed = True
            owner_id = self._guarded.pop(session, None)
            if tab is None and waiting:
                # not closed: in a visible Chrome that closes the whole tab
                return
            closed = False
            try:
                closed = (await client.send("Target.closeTarget", {"targetId": info["targetId"]})).get(
                    "success"
                ) is not False
            except CdpProtocolError as error:
                closed = error.stale
            except Exception:
                pass
            if not closed:
                owner = self._tabs.get(owner_id)
                if owner is not None:
                    owner.failed = True
                    try:
                        await client.send("Target.closeTarget", {"targetId": owner.target})
                    except Exception:
                        pass
                # no raise: a dropped connection lets Chrome resume paused targets
                return
            await self._detach_target(session, False)
        finally:
            if tab:
                tab.ready.set()

    async def _event(self, event, p, session):
        tab = self._by_session(session)
        if event == "Fetch.requestPaused":
            await self._intercept(p, session, tab)
            return
        if event == "Page.javascriptDialogOpening":
            accept = p["type"] == "beforeunload"
            dismissed = await self._event_send("Page.handleJavaScriptDialog", {"accept": accept}, session)
            if dismissed and (not accept):
                self._change(BetaDialogDismissed(kind=p["type"], message=p.get("message", "")[:1000]))
            return
        self._record_event(event, p, session)

    async def _intercept(self, p, session, tab):
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
                    allowed = await self._policy_allows(owner, url)
                else:
                    allowed = True
            else:
                allowed = True
        except Exception:
            allowed = False
        if not allowed:
            if document:
                self._change(BetaNavigationRefused())
            await self._client().submit(
                "Fetch.failRequest", {"requestId": p["requestId"], "errorReason": "BlockedByClient"}, session
            )
        else:
            await self._client().submit("Fetch.continueRequest", {"requestId": p["requestId"]}, session)

    async def _wait_tab(self, find):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            self._client()
            with self._state_lock:
                tab = find()
            if tab and tab.ready.is_set():
                if tab.failed:
                    raise ToolError("The tab could not be initialized safely")
                return tab
            await asyncio.sleep(0.02)
        raise ToolError("The tab did not open within 10 seconds")

    async def _tab(self, ident=None):
        with self._state_lock:
            if ident is None:
                ident = self._reported_active if self._reported_active in self._tabs else self._active
            tab = self._tabs.get(ident)
        if tab is None:
            raise ToolError("The tab is not open; call list_tabs")
        try:
            await asyncio.wait_for(tab.ready.wait(), 10)
        except asyncio.TimeoutError:
            raise ToolError("The tab is not ready") from None
        if tab.failed:
            raise ToolError("The tab is not ready")
        self._client()
        return tab

    async def _activate(self, tab):
        await self._send(tab, "Page.bringToFront")
        with self._state_lock:
            self._active = tab.id
            self._activations += 1
            tab.active_order = self._activations

    async def _browser_state(self, context) -> BetaBrowserState:
        try:
            infos = (await self._client().send("Target.getTargets", timeout=5)).get("targetInfos", [])
            with self._state_lock:
                live = {i["targetId"] for i in infos}
                for tab in tuple(self._tabs.values()):
                    if tab.target not in live:
                        self._tabs.pop(tab.id)
                    else:
                        info = next((i for i in infos if i["targetId"] == tab.target))
                        tab.url, tab.title = (info.get("url", tab.url), info.get("title", tab.title))
        except Exception:
            pass
        with self._state_lock:
            if self._active not in self._tabs:
                recent = max(self._tabs.values(), key=lambda t: t.active_order, default=None)
                self._active = recent.id if recent else None
            changes, self._changes = (self._changes, [])
            self._reported_active = self._active
            return BetaBrowserState(tabs=[self._entry(t) for t in self._tabs.values()], state_changes=changes)

    async def _runtime_world(self, tab):
        if tab.world is not None:
            return tab.world
        generation = tab.world_generation
        context_id = (
            await self._send(tab, "Page.createIsolatedWorld", {"frameId": tab.frame, "worldName": self._world_name})
        )["executionContextId"]
        if generation != tab.world_generation:
            raise ToolError("The page changed while creating its runtime")
        installed = await self._send(
            tab, "Runtime.evaluate", {"expression": RUNTIME_SOURCE, "contextId": context_id, "returnByValue": True}
        )
        if installed.get("exceptionDetails"):
            raise ToolError("The browser runtime could not be installed")
        with self._state_lock:
            if generation != tab.world_generation:
                raise ToolError("The page changed while installing its runtime")
            tab.world = context_id
        return context_id

    async def _run(self, tab, script):
        context_id = await self._runtime_world(tab)
        result = await self._send(
            tab,
            "Runtime.evaluate",
            {"expression": script, "contextId": context_id, "returnByValue": True, "awaitPromise": True},
        )
        if result.get("exceptionDetails"):
            raise ToolError("The page script failed; read_page again after navigation")
        return result.get("result", {}).get("value")

    async def _page_call(self, tab, script):
        try:
            result = runtime_result(await self._run(tab, script))
        except ValueError:
            raise ToolError("The page did not return a valid runtime result") from None
        if not result["ok"]:
            raise ToolError(result["error"]["message"])
        return result["value"]

    async def _point(self, tab, target, action="click"):
        if target.type == "ref":
            result = await self._page_call(
                tab, expression("resolve", {"ref": target.ref, "action": action, "base": self._reserve_refs()})
            )
            x, y = (result["x"], result["y"])
            if not all((math.isfinite(v) for v in (x, y))) or not (
                0 <= x < self._viewport[0] and 0 <= y < self._viewport[1]
            ):
                raise ToolError("The element resolved outside the viewport")
            return (x, y)
        return self._coordinate(target)

    async def _mouse(self, tab, kind, point, **extra):
        tab.point = point
        return await self._send(tab, "Input.dispatchMouseEvent", {"type": kind, "x": point[0], "y": point[1], **extra})

    async def _settle(self, tab, sequence, navigation=True):
        # ponytail: bounded settle window; precise action/navigation correlation if delayed pages demand it.
        await asyncio.sleep(0.3)
        if not navigation:
            return
        deadline = time.monotonic() + 0.3
        while time.monotonic() < deadline and tab.sequence == sequence and (not tab.loading):
            await asyncio.sleep(0.025)
        deadline = time.monotonic() + 10
        while tab.loading and time.monotonic() < deadline:
            self._client()
            await asyncio.sleep(0.025)
        # Input was acknowledged; a slow navigation must not encourage replay of the action.

    async def _check_policy(self, tab, url):
        if self._policy is NOT_GIVEN:
            return
        try:
            if not await self._policy_allows(tab.id, url):
                raise ValueError
        except Exception:
            raise ToolError("Navigation policy refused or failed") from None

    async def _policy_allows(self, tab_id, url):
        if not callable(self._policy):
            return False
        result = self._policy(BetaURLContext(tab_id=tab_id), url)
        if inspect.isawaitable(result):
            result = await result
        return result is None

    async def navigate(self, context, input) -> BetaBrowserNavigateResult:
        tab = await self._tab(input.tab_id)
        url = input.url
        before, sequence = (tab.loader, tab.sequence)
        if url in {"back", "forward"}:
            history = await self._send(tab, "Page.getNavigationHistory")
            index = history["currentIndex"] + (-1 if url == "back" else 1)
            if not 0 <= index < len(history["entries"]):
                raise ToolError("No history entry in that direction")
            entry = history["entries"][index]
            check_url(entry["url"])
            await self._check_policy(tab, entry["url"])
            result = await self._send(tab, "Page.navigateToHistoryEntry", {"entryId": entry["id"]})
        elif url == "reload":
            check_url(tab.url)
            await self._check_policy(tab, tab.url)
            result = await self._send(tab, "Page.reload")
        else:
            result = await self._send(tab, "Page.navigate", {"url": check_url(url)})
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
                await asyncio.sleep(0.025)
        else:
            await self._settle(tab, sequence)
        info = (await self._client().send("Target.getTargetInfo", {"targetId": tab.target}))["targetInfo"]
        tab.url, tab.title = (info["url"], info["title"])
        return BetaBrowserNavigateResult(url=tab.url, title=tab.title, status=tab.status.get(loader or tab.loader))

    async def _capture(self, tab, params):
        background = tab.id != self._active
        if background:
            await self._send(tab, "Page.bringToFront")
        try:
            shot = await self._send(tab, "Page.captureScreenshot", {"format": "png", **params}, timeout=10)
            return BetaScreenshotResult(data=shot["data"], media_type="image/png")
        finally:
            if background and self._active in self._tabs:
                await finish_cleanup(self._send(self._tabs[self._active], "Page.bringToFront"))

    async def screenshot(self, context, input) -> BetaScreenshotResult:
        return await self._capture(await self._tab(input.tab_id), {})

    async def zoom(self, context, input) -> BetaScreenshotResult:
        tab = await self._tab(input.tab_id)
        if len(input.region) != 4:
            raise ToolError("region must be [x0, y0, x1, y1]")
        x0, y0, x1, y1 = input.region
        width, height = self._viewport
        if not (0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height):
            raise ToolError("region must fit the viewport")
        view = (await self._send(tab, "Page.getLayoutMetrics"))["cssVisualViewport"]
        return await self._capture(
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

    async def _click(self, input, button="left", count=1):
        tab = await self._tab(input.tab_id)
        bits = _input.modifiers(input.modifiers)
        point = await self._point(tab, input.target)
        sequence = tab.sequence
        await self._mouse(tab, "mouseMoved", point, modifiers=bits)
        for n in range(1, count + 1):
            try:
                tab.buttons = {"left": 1, "right": 2, "middle": 4}[button]
                await self._mouse(
                    tab, "mousePressed", point, button=button, buttons=tab.buttons, clickCount=n, modifiers=bits
                )
            finally:
                await finish_cleanup(self._release_mouse(tab, point, button=button, clickCount=n, modifiers=bits))
        await self._settle(tab, sequence)

    async def _release_mouse(self, tab, point, **extra):
        await self._mouse(tab, "mouseReleased", point, buttons=0, **extra)
        tab.buttons = 0

    async def left_click(self, context, input) -> None:
        await self._click(input)

    async def right_click(self, context, input) -> None:
        await self._click(input, "right")

    async def middle_click(self, context, input) -> None:
        await self._click(input, "middle")

    async def double_click(self, context, input) -> None:
        await self._click(input, count=2)

    async def triple_click(self, context, input) -> None:
        await self._click(input, count=3)

    async def hover(self, context, input) -> None:
        tab = await self._tab(input.tab_id)
        await self._mouse(tab, "mouseMoved", await self._point(tab, input.target, "hover"))
        await self._settle(tab, tab.sequence, False)

    async def mouse_move(self, context, input) -> None:
        tab = await self._tab(input.tab_id)
        await self._mouse(tab, "mouseMoved", self._coordinate(input.target), buttons=tab.buttons)

    async def left_mouse_down(self, context, input) -> None:
        tab = await self._tab(input.tab_id)
        point = self._coordinate(input.target)
        tab.buttons = 1
        try:
            await self._mouse(tab, "mouseMoved", point)
            await self._mouse(tab, "mousePressed", point, button="left", buttons=1, clickCount=1)
        except BaseException:
            await finish_cleanup(self._release_mouse(tab, point, button="left", clickCount=1))
            raise

    async def left_mouse_up(self, context, input) -> None:
        tab = await self._tab(input.tab_id)
        point = self._coordinate(input.target)
        await self._mouse(tab, "mouseReleased", point, button="left", buttons=0, clickCount=1)
        tab.buttons = 0
        await self._settle(tab, tab.sequence)

    async def left_click_drag(self, context, input) -> None:
        tab = await self._tab(input.tab_id)
        start, end = (self._coordinate(input.from_), self._coordinate(input.target))
        sequence = tab.sequence
        try:
            await self._mouse(tab, "mouseMoved", start)
            tab.buttons = 1
            await self._mouse(tab, "mousePressed", start, button="left", buttons=1, clickCount=1)
            steps = min(50, max(10, math.ceil(math.dist(start, end) / 20)))
            for n in range(1, steps + 1):
                point = (start[0] + (end[0] - start[0]) * n / steps, start[1] + (end[1] - start[1]) * n / steps)
                await self._mouse(tab, "mouseMoved", point, button="left", buttons=1)
        finally:
            await finish_cleanup(self._release_mouse(tab, tab.point, button="left", clickCount=1))
        await self._settle(tab, sequence)

    async def scroll(self, context, input) -> None:
        tab = await self._tab(input.tab_id)
        point = self._coordinate(input.target)
        amount = integer(3 if input.scroll_amount is None else input.scroll_amount, "scroll_amount", 10)
        delta = amount * 100
        dx = -delta if input.scroll_direction == "left" else delta if input.scroll_direction == "right" else 0
        dy = -delta if input.scroll_direction == "up" else delta if input.scroll_direction == "down" else 0
        await self._mouse(tab, "mouseWheel", point, deltaX=dx, deltaY=dy)
        await self._settle(tab, tab.sequence, False)

    async def scroll_to(self, context, input) -> None:
        tab = await self._tab(input.tab_id)
        await self._page_call(tab, expression("scroll_to", {"ref": input.target.ref, "base": self._reserve_refs()}))
        await self._settle(tab, tab.sequence, False)

    async def type(self, context, input) -> None:
        tab = await self._tab(input.tab_id)
        sequence = tab.sequence
        await _input.type_text_async(lambda m, p: self._send(tab, m, p), input.text, held=tab.held_keys)
        await self._settle(tab, sequence)

    async def key(self, context, input) -> None:
        tab = await self._tab(input.tab_id)
        sequence = tab.sequence
        repeat = integer(1 if input.repeat is None else input.repeat, "repeat", 100)
        await _input.press_async(lambda m, p: self._send(tab, m, p), input.text, repeat, held=tab.held_keys)
        await self._settle(tab, sequence)

    async def hold_key(self, context, input) -> None:
        tab = await self._tab(input.tab_id)
        await _input.press_async(
            lambda m, p: self._send(tab, m, p), input.text, hold=duration(input.duration), held=tab.held_keys
        )
        await self._settle(tab, tab.sequence, False)

    async def form_input(self, context, input) -> str:
        tab = await self._tab(input.tab_id)
        outcome = await self._page_call(
            tab, expression("form_input", {"ref": input.target.ref, "value": input.value, "base": self._reserve_refs()})
        )
        await self._settle(tab, tab.sequence, False)
        return outcome.get("summary", "")

    async def read_page(self, context, input) -> str:
        tab = await self._tab(input.tab_id)
        if input.depth is not None and input.depth < 1:
            raise ToolError("depth must be a positive integer")
        return self._ref_text(
            await self._page_call(
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

    async def find(self, context, input) -> str:
        tab = await self._tab(input.tab_id)
        if not input.query.strip():
            raise ToolError("query must describe the element to find")
        return (
            self._ref_text(
                await self._page_call(tab, expression("find", {"query": input.query, "base": self._reserve_refs()}))
            )
            or "No element matches; try read_page"
        )

    async def get_page_text(self, context, input) -> str:
        return self._ref_text(
            await self._page_call(
                await self._tab(input.tab_id), expression("page_text", {"max": 30000, "base": self._reserve_refs()})
            )
        )

    async def wait(self, context, input) -> None:
        if input.tab_id is not None:
            await self._tab(input.tab_id)
        await asyncio.sleep(duration(input.duration))

    async def file_upload(self, context, input) -> None:
        tab = await self._tab(input.tab_id)
        paths, documents = (input.paths or [], input.document_ids or [])
        count = len(paths) + len(documents)
        sequence, requests, generation = (tab.sequence, tab.nav_requests, tab.world_generation)
        target = await self._send(
            tab,
            "Runtime.evaluate",
            dict(
                expression=file_input_expression(input.target.ref, count, self._reserve_refs()),
                contextId=await self._runtime_world(tab),
                returnByValue=False,
                awaitPromise=True,
            ),
        )
        remote = target.get("result", {})
        object_id = remote.get("objectId")
        if not object_id or target.get("exceptionDetails"):
            raise ToolError("file_upload: target could not be resolved")
        directory = None
        staging = {}
        selected = False
        try:
            if remote.get("subtype") != "node":
                raise ToolError("file_upload: target must be an enabled file input permitting these files")
            node = (await self._send(tab, "DOM.describeNode", dict(objectId=object_id)))["node"]["backendNodeId"]
            files = await asyncio.to_thread(prepare_uploads, paths, documents, self._upload_documents)
            size = sum((len(file.data) for file in files))
            if self._upload_bytes + size > 50 * 1024 * 1024 or len(self._upload_directories) >= 100:
                raise ToolError("file_upload: session staging limit reached; close and start a new session")
            try:
                await finish_cleanup(self._create_upload_directory(size, staging))
                directory = staging["directory"]
                staged = []
                for index, file in enumerate(files):
                    folder = f"{directory}/{index}"
                    await finish_cleanup(self.sandbox.files.make_dir(folder))
                    path = folder + "/" + file.name
                    await finish_cleanup(self.sandbox.files.write(path, file.data))
                    staged.append(path)
            except Exception:
                raise ToolError("file_upload: could not stage approved files") from None
            if (tab.sequence, tab.nav_requests, tab.world_generation) != (sequence, requests, generation):
                raise ToolError("file_upload: page changed while staging files; inspect it and retry")
            valid = await self._send(
                tab,
                "Runtime.callFunctionOn",
                dict(
                    objectId=object_id,
                    functionDeclaration=FILE_INPUT_VALIDATION,
                    arguments=file_input_validation_arguments(input.target.ref, count, self._reserve_refs()),
                    returnByValue=True,
                    awaitPromise=True,
                ),
            )
            if valid.get("result", {}).get("value") is not True:
                raise ToolError("file_upload: target changed while staging files")
            selected = True
            await self._send(tab, "DOM.setFileInputFiles", dict(backendNodeId=node, files=staged))
            await self._settle(tab, sequence)
        finally:
            await finish_cleanup(self._finish_upload(tab, object_id, staging.get("directory"), selected))

    async def _create_upload_directory(self, size, staging):
        result = await self.sandbox.commands.run("umask 077; mktemp -d /tmp/e2b-browser-upload.XXXXXX", timeout=5)
        directory = result.stdout.strip()
        if not re.fullmatch(r"/tmp/e2b-browser-upload\.[A-Za-z0-9]+", directory):
            raise ToolError("file_upload: could not create staging directory")
        staging["directory"] = directory
        self._upload_directories[directory] = size
        self._upload_bytes += size

    async def _finish_upload(self, tab, object_id, directory, selected):
        try:
            await self._send(tab, "Runtime.releaseObject", dict(objectId=object_id))
        except Exception:
            pass
        if directory is not None and not selected:
            try:
                await self.sandbox.files.remove(directory)
            except Exception:
                pass
            else:
                self._upload_bytes -= self._upload_directories.pop(directory)

    async def javascript_exec(self, context, input) -> str:
        tab = await self._tab(input.tab_id)
        sequence = tab.sequence
        group = self._world_name + "-script"
        promise_result = None
        try:
            evaluated = await self._send(
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
            if (
                remote.get("subtype") == "promise"
                and remote.get("objectId")
                and (not evaluated.get("exceptionDetails"))
            ):
                evaluated = await self._send(tab, "Runtime.awaitPromise", dict(promiseObjectId=remote["objectId"]))
                remote = evaluated.get("result", {})
                promise_result = remote.get("objectId")
            if evaluated.get("exceptionDetails"):
                raise ToolError("The page script threw an exception; inspect read_console")
            if remote.get("objectId") and remote.get("subtype") != "node":
                value = await self._send(
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
            await self._settle(tab, sequence)
            return text[:50000]
        finally:
            await finish_cleanup(self._release_script_group(tab, group, promise_result))

    async def _release_script_group(self, tab, group, promise_result):
        # awaitPromise results need not belong to the evaluation's object group.
        for method, params in [
            ("Runtime.releaseObject", dict(objectId=promise_result)),
            ("Runtime.releaseObjectGroup", dict(objectGroup=group)),
        ]:
            if method == "Runtime.releaseObject" and promise_result is None:
                continue
            try:
                await self._send(tab, method, params)
            except Exception:
                pass

    async def read_console(self, context, input) -> str:
        return self._console_text(await self._tab(input.tab_id))

    async def read_network(self, context, input) -> str:
        return self._network_text(await self._tab(input.tab_id))

    async def new_tab(self, context, input):
        result = await self._client().send("Target.createTarget", {"url": "about:blank"})
        tab = await self._wait_tab(lambda: self._by_target(result["targetId"]))
        await self._activate(tab)
        return self._entry(tab)

    async def list_tabs(self, context, input):
        self._client()
        with self._state_lock:
            return [self._entry(t) for t in self._tabs.values()]

    async def switch_tab(self, context, input):
        tab = await self._tab(input.tab_id)
        await self._activate(tab)
        return self._entry(tab)

    async def close_tab(self, context, input) -> None:
        tab = await self._tab(input.tab_id)
        with self._state_lock:
            if len(self._tabs) <= 1:
                raise ToolError("Cannot close the last tab; navigate it to about:blank")
        await self._client().send("Target.closeTarget", {"targetId": tab.target})
        deadline = time.monotonic() + 5
        while tab.id in self._tabs and time.monotonic() < deadline:
            self._client()
            await asyncio.sleep(0.025)
        if tab.id in self._tabs:
            raise ToolError("The tab did not close")
        if self._active in self._tabs:
            await self._activate(self._tabs[self._active])
