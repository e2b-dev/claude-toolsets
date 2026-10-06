"""I/O-free browser state and validation, shared by the sync and asyncio drivers."""

from __future__ import annotations

import json
import math
import re
import secrets
import threading
from dataclasses import dataclass, field
from typing import Any

from anthropic.tools import ToolError

from ._scripts import REF_BLOCK_SIZE


@dataclass
class Tab:
    id: str
    target: str
    session: str
    url: str
    title: str
    frame: str = ""
    ready: Any = field(default_factory=threading.Event)
    failed: bool = False
    world: int | None = None
    world_generation: int = 0
    loading: bool = False
    loader: str | None = None
    loaded: set[str] = field(default_factory=set)
    status: dict[str, int] = field(default_factory=dict)
    buttons: int = 0
    held_keys: list[dict] = field(default_factory=list)
    point: tuple[float, float] = (0, 0)
    sequence: int = 0
    active_order: int = 0
    nav_requests: int = 0
    console: list[str] = field(default_factory=list)
    network: list[dict] = field(default_factory=list)
    requests: dict[str, dict] = field(default_factory=dict)


class BrowserStateMixin:
    _runtime: Any

    def _initialize_state(self, viewport, url_policy, upload_documents):
        self._world_name = "e2b-toolset-" + secrets.token_hex(12)
        self._viewport = viewport
        self._policy = url_policy
        self._state_lock = threading.RLock()
        self._tabs: dict[str, Tab] = {}
        self._guarded: dict[str, str | None] = {}
        self._changes: list[Any] = []
        self._downloads: dict[str, tuple[str, str]] = {}
        self._active: str | None = None
        self._reported_active: str | None = None
        self._next_tab = self._ref_next = 1
        self._next_download = 1
        self._activations = 0
        self._started = False
        self._closing = False
        self._owns_browser = False
        self._disconnect_error: str | None = None
        self._detaching = self._detached = False
        self._upload_documents = dict(upload_documents or {})
        self._upload_directories: dict[str, int] = {}
        self._upload_bytes = 0

    def _by_target(self, target):
        with self._state_lock:
            return next((t for t in self._tabs.values() if t.target == target), None)

    def _by_session(self, session):
        with self._state_lock:
            return next((t for t in self._tabs.values() if t.session == session), None)

    def _change(self, value):
        with self._state_lock:
            if len(self._changes) >= 256:
                # Notifications may be coalesced; interception commands are never discarded.
                self._changes.pop(0)
            self._changes.append(value)

    @staticmethod
    def _describe(value):
        if "unserializableValue" in value:
            return value["unserializableValue"]
        if "value" in value:
            return value["value"] if isinstance(value["value"], str) else json.dumps(value["value"], ensure_ascii=False)
        return value.get("description", value.get("type", "undefined"))

    def _capture_event(self, tab, event, p):
        if event == "Runtime.consoleAPICalled":
            line = "[" + p["type"] + "] " + " ".join(self._describe(value) for value in p.get("args", []))
            tab.console.append(line[:1000])
            del tab.console[:-100]
        elif event == "Runtime.exceptionThrown":
            detail = p["exceptionDetails"]
            tab.console.append(
                ("[exception] " + self._describe(detail.get("exception", {"value": detail.get("text", "Exception")})))[
                    :1000
                ]
            )
            del tab.console[:-100]
        elif event == "Network.requestWillBeSent":
            previous = tab.requests.get(p["requestId"])
            if previous is not None and p.get("redirectResponse"):
                previous["status"] = p["redirectResponse"]["status"]
            url = p["request"]["url"]
            if url.startswith("data:"):
                url = re.split("[;,]", url, maxsplit=1)[0][:100] + f" ({len(url)} characters)"
            entry = dict(
                method=p["request"]["method"], url=url[:500], type=p.get("type", "Other"), started=p["timestamp"]
            )
            tab.requests[p["requestId"]] = entry
            tab.network.append(entry)
            del tab.network[:-100]
            while len(tab.requests) > 100:
                tab.requests.pop(next(iter(tab.requests)))
        elif event == "Network.responseReceived":
            entry = tab.requests.get(p.get("requestId"))
            if entry is not None:
                entry.update(status=p["response"]["status"], mime=p["response"].get("mimeType", ""))
        elif event in {"Network.loadingFinished", "Network.loadingFailed"}:
            entry = tab.requests.get(p["requestId"])
            if entry is not None:
                if event.endswith("Finished"):
                    entry["ms"] = round((p["timestamp"] - entry["started"]) * 1000)
                else:
                    entry["error"] = p["errorText"][:100]

    def _console_text(self, tab):
        with self._state_lock:
            entries, tab.console = tab.console, []
        return "\n".join(entries) if entries else "No console messages since the last read."

    def _network_text(self, tab):
        with self._state_lock:
            entries, tab.network = tab.network, []
            tab.requests.clear()
        lines = []
        for entry in entries:
            status = "failed (" + entry["error"] + ")" if "error" in entry else str(entry.get("status", "pending"))
            fields = [entry["method"], status, entry["url"], entry["type"], entry.get("mime", "")]
            if "ms" in entry:
                fields.append(str(entry["ms"]) + " ms")
            lines.append(" ".join(filter(None, fields)))
        return "\n".join(lines) if lines else "No network requests since the last read."

    def _entry(self, tab):
        return {"tab_id": tab.id, "url": tab.url, "title": tab.title, "active": tab.id == self._active}

    def _reserve_refs(self):
        base = self._ref_next
        if base + REF_BLOCK_SIZE > 2**53 - 1:
            raise ToolError("Reference limit reached")
        self._ref_next += REF_BLOCK_SIZE
        return base

    def _coordinate(self, target):
        if target is None or target.type != "coordinate" or not all(math.isfinite(v) for v in (target.x, target.y)):
            raise ToolError("Expected a coordinate target")
        if not (0 <= target.x < self._viewport[0] and 0 <= target.y < self._viewport[1]):
            raise ToolError("Coordinate is outside the viewport")
        return target.x, target.y

    def _ref_text(self, value):
        if not isinstance(value, str):
            raise ToolError("The page did not return text")
        return value

    def _listen(self, client, attached, event_handler, options):
        client.capture_network = options.is_enabled("read_network")
        client.on("Target.attachedToTarget", attached)
        for event in [
            "Target.detachedFromTarget",
            "Target.targetDestroyed",
            "Target.targetInfoChanged",
            "Page.javascriptDialogOpening",
            "Page.frameRequestedNavigation",
            "Page.frameStartedLoading",
            "Page.frameStoppedLoading",
            "Page.frameNavigated",
            "Page.navigatedWithinDocument",
            "Page.lifecycleEvent",
            "Runtime.executionContextsCleared",
            "Runtime.executionContextDestroyed",
            "Network.responseReceived",
            "Fetch.requestPaused",
            "Browser.downloadWillBegin",
            "Browser.downloadProgress",
        ]:
            client.on(event, lambda p, s, event=event: event_handler(event, p, s))
        extra = []
        if options.is_enabled("read_console"):
            extra.extend(["Runtime.consoleAPICalled", "Runtime.exceptionThrown"])
        if options.is_enabled("read_network"):
            extra.extend(["Network.requestWillBeSent", "Network.loadingFinished", "Network.loadingFailed"])
        for event in extra:
            client.on(event, lambda p, s, event=event: event_handler(event, p, s))

    def _target_setup(self, info, tab, waiting):
        page = tab is not None
        patterns = [{"resourceType": "Document", "requestStage": "Request"}] + [
            {"urlPattern": pattern, "requestStage": "Request"}
            for pattern in [
                "*://localhost*",
                "*://*.localhost*",
                "*://127.*",
                "*://0.*",
                "*://10.*",
                "*://172.*",
                "*://192.168.*",
                "*://169.254.*",
                "*://[*",
                "*://*@*",
            ]
        ]
        steps = [("Fetch.enable", {"patterns": patterns})]
        if page or info["type"] in {"iframe", "page"}:
            steps.extend(
                [
                    ("Network.enable", {}),
                    ("Network.setBypassServiceWorker", {"bypass": True}),
                    ("Target.setAutoAttach", {"autoAttach": True, "waitForDebuggerOnStart": True, "flatten": True}),
                ]
            )
        if tab:
            steps.extend(
                [
                    ("Page.enable", {}),
                    ("Runtime.enable", {}),
                    ("Page.setLifecycleEventsEnabled", {"enabled": True}),
                    (
                        "Emulation.setDeviceMetricsOverride",
                        {
                            "width": self._viewport[0],
                            "height": self._viewport[1],
                            "deviceScaleFactor": 1,
                            "mobile": False,
                        },
                    ),
                    ("Emulation.setFocusEmulationEnabled", {"enabled": True}),
                    ("Page.getFrameTree", {}),
                ]
            )
        if waiting:
            steps.append(("Runtime.runIfWaitingForDebugger", {}))
        return steps

    def _record_event(self, event, p, session):
        tab = self._by_session(session)
        with self._state_lock:
            if tab and event.startswith(("Network.", "Runtime.console", "Runtime.exception")):
                self._capture_event(tab, event, p)
            if (
                event == "Page.frameRequestedNavigation"
                and tab
                and p.get("frameId") == tab.frame
                and p.get("disposition") == "currentTab"
            ):
                tab.nav_requests += 1
            elif event in {"Target.detachedFromTarget", "Target.targetDestroyed"}:
                tab = (
                    self._by_session(p.get("sessionId"))
                    if event == "Target.detachedFromTarget"
                    else self._by_target(p.get("targetId"))
                )
                self._guarded.pop(p.get("sessionId"), None)
                if tab:
                    self._tabs.pop(tab.id, None)
                    if self._active == tab.id:
                        recent = max(self._tabs.values(), key=lambda t: t.active_order, default=None)
                        self._active = recent.id if recent else None
            elif event == "Target.targetInfoChanged":
                info = p["targetInfo"]
                tab = self._by_target(info["targetId"])
                if tab:
                    tab.url, tab.title = info.get("url", tab.url), info.get("title", tab.title)
            elif event == "Runtime.executionContextsCleared" and tab:
                tab.world = None
                tab.world_generation += 1
            elif event == "Runtime.executionContextDestroyed" and tab:
                if tab.world is None or tab.world == p["executionContextId"]:
                    tab.world = None
                    tab.world_generation += 1
            elif event == "Page.frameStartedLoading" and tab and p["frameId"] == tab.frame:
                tab.loading = True
                tab.sequence += 1
            elif event == "Page.frameStoppedLoading" and tab and p["frameId"] == tab.frame:
                tab.loading = False
            elif event == "Page.frameNavigated" and tab and not p["frame"].get("parentId"):
                frame = p["frame"]
                tab.url, tab.loader, tab.world = frame["url"], frame.get("loaderId"), None
                tab.world_generation += 1
                tab.sequence += 1
            elif event == "Page.navigatedWithinDocument" and tab and p["frameId"] == tab.frame:
                tab.url = p["url"]
                tab.sequence += 1
            elif (
                event == "Page.lifecycleEvent" and tab and p["frameId"] == tab.frame and p["name"] == "DOMContentLoaded"
            ):
                tab.loading = False
                tab.loaded.add(p["loaderId"])
                if len(tab.loaded) > 100:
                    tab.loaded = {p["loaderId"]}
            elif (
                event == "Network.responseReceived"
                and tab
                and p.get("type") == "Document"
                and p.get("frameId") == tab.frame
            ):
                tab.status[p["loaderId"]] = int(p["response"]["status"])
                if len(tab.status) > 100:
                    tab.status = {p["loaderId"]: tab.status[p["loaderId"]]}
            elif event == "Browser.downloadWillBegin":
                if len(self._downloads) >= 100:
                    self._downloads.pop(next(iter(self._downloads)))
                ident = f"download_{self._next_download}"
                self._next_download += 1
                self._downloads[p["guid"]] = (ident, p["url"])
                self._change({"type": "download_started", "download_id": ident, "url": p["url"]})
            elif event == "Browser.downloadProgress" and p["state"] != "inProgress":
                download = self._downloads.pop(p["guid"], None)
                if download:
                    ident, url = download
                    if p["state"] == "completed":
                        self._change(
                            {
                                "type": "download_completed",
                                "download_id": ident,
                                "url": url,
                                "path": str(self._runtime.directory) + "/downloads/" + p["guid"],
                                "size_bytes": int(p["receivedBytes"]),
                            }
                        )
                    else:
                        self._change(
                            {
                                "type": "download_failed",
                                "download_id": ident,
                                "url": url,
                                "error": "The download failed",
                            }
                        )
