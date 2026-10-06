"""Local protocol fixture, not a Chrome substitute or live E2B validation."""

import base64
import json
import threading
from types import SimpleNamespace

from anthropic.types.beta import BetaToolUseBlock
from websockets.exceptions import ConnectionClosedOK
from websockets.sync.server import serve

from e2b_claude_toolsets._scripts import RUNTIME_SOURCE

PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="


def call(toolset, name, data=None):
    return toolset.tool_result(
        BetaToolUseBlock(
            id="test",
            type="tool_use",
            name=name,
            input=data or {},
            toolset_name=toolset.toolset_name,
        )
    )


class Desktop:
    def __init__(self):
        self.calls = []
        self.fail = None
        self.traffic_access_token = "PRIVATE-TRAFFIC-TOKEN"
        self.commands = SimpleNamespace(run=self.run, kill=lambda pid: self.calls.append(("kill", pid)))
        self.files = SimpleNamespace(
            remove=lambda path: self.calls.append(("remove", path)),
            make_dir=lambda path: self.calls.append(("mkdir", path)),
            write=lambda path, data: self.calls.append(("file-write", path, data)),
        )
        self.stream = SimpleNamespace(
            start=lambda **kw: self.calls.append(("start-stream", kw)), stop=lambda: self.calls.append(("stop-stream",))
        )

    def run(self, command, **kwargs):
        self.calls.append(command)
        if self.fail and self.fail in command:
            raise RuntimeError("PRIVATE-TRAFFIC-TOKEN")
        directory = "/tmp/e2b-browser-upload.abc123" if "e2b-browser-upload." in command else "/tmp/e2b-browser-abc123"
        return SimpleNamespace(stdout=directory + "\n", pid=10, disconnect=lambda: None)

    def get_screen_size(self):
        return 1280, 800

    def get_cursor_position(self):
        return 0, 0

    def get_host(self, port):
        return f"{port}-fixture.e2b.test"

    def screenshot(self):
        return base64.b64decode(PNG)

    def write(self, text, **kwargs):
        self.calls.append(("write", text))

    def kill(self):
        self.calls.append("kill-sandbox")
        if self.fail == "kill":
            raise RuntimeError("PRIVATE-TRAFFIC-TOKEN")
        return False


class ChromeProtocol:
    def __init__(self):
        self.commands = []
        self.tabs = {"target-1": {"targetId": "target-1", "type": "page", "url": "about:blank", "title": "Fixture"}}
        self.session = {"target-1": "session-1"}
        self.ref_base = 1
        self.socket = None
        self.pause = {}
        self.errors = {}
        self.close_failed = set()
        self.reply_delay = 0.0
        self.resume_after_detach = False
        self.pending_resume = {}
        self.timers = []
        self.file_valid = True
        self.promise_result = {"type": "number", "value": 42}
        self.server = serve(self.handle, "127.0.0.1", 0, compression=None, close_timeout=1)
        self.url = f"ws://127.0.0.1:{self.server.socket.getsockname()[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def event(self, method, params, session=None):
        obj = {"method": method, "params": params}
        if session:
            obj["sessionId"] = session
        assert self.socket is not None
        self.socket.send(json.dumps(obj))

    def reply(self, msg, result=None):
        assert self.socket is not None
        payload = {"id": msg["id"]}
        if msg["method"] in self.errors:
            payload["error"] = self.errors[msg["method"]]
        else:
            payload["result"] = result or {}
        if self.reply_delay:
            timer = threading.Timer(self.reply_delay, self.socket.send, args=(json.dumps(payload),))
            self.timers.append(timer)
            timer.start()
        else:
            try:
                self.socket.send(json.dumps(payload))
            except ConnectionClosedOK:
                # A test may finish while an asynchronous event reply is in flight.
                pass

    def handle(self, ws):
        self.socket = ws
        for raw in ws:
            msg = json.loads(raw)
            method, params, session = msg["method"], msg["params"], msg.get("sessionId")
            self.commands.append(msg)
            result = {}
            if method == "Target.getTargets":
                result = {"targetInfos": list(self.tabs.values())}
            elif method == "Target.getTargetInfo":
                result = {"targetInfo": self.tabs[params["targetId"]]}
            elif method in {"Target.attachToTarget", "Target.createTarget"}:
                target = params.get("targetId")
                if not target:
                    target = f"target-{len(self.tabs) + 1}"
                    self.tabs[target] = {"targetId": target, "type": "page", "url": "about:blank", "title": "New"}
                session = self.session.setdefault(target, f"session-{len(self.session) + 1}")
                self.event(
                    "Target.attachedToTarget",
                    {"sessionId": session, "targetInfo": self.tabs[target], "waitingForDebugger": True},
                )
                result = {"targetId": target, "sessionId": session}
            elif method == "Page.getFrameTree":
                target = next(t for t, s in self.session.items() if s == session)
                result = {"frameTree": {"frame": {"id": target}}}
            elif method == "Page.createIsolatedWorld":
                result = {"executionContextId": 1}
            elif method == "Runtime.evaluate" and params["expression"] == RUNTIME_SOURCE:
                result = {}
            elif method == "Runtime.evaluate" and "contextId" not in params:
                result = {"result": {"type": "object", "subtype": "promise", "objectId": "promise"}}
            elif method == "Runtime.awaitPromise":
                result = {"result": self.promise_result}
            elif method == "Runtime.callFunctionOn":
                result = {"result": {"value": self.file_valid}}
            elif method == "DOM.describeNode":
                result = {"node": {"backendNodeId": 7}}
            elif method == "Runtime.evaluate":
                # Stub the explicit operation contract; browser tests execute the real asset.
                source = params["expression"].splitlines()[-1].split(".call(", 1)[1]
                request = json.loads(source.split(").then(", 1)[0] if ").then(" in source else source[:-1])
                operation, args = request["operation"], request["args"]
                next_ref = args["base"]
                if operation in {"read_page", "find"}:
                    value = f'- button "Submit" [ref_{next_ref}]'
                    next_ref += 1
                elif operation == "resolve":
                    value = {"x": 20, "y": 30}
                elif operation == "form_input":
                    value = {"summary": "Set field"}
                elif operation == "scroll_to":
                    value = None
                else:
                    value = "Fixture page text"
                envelope = {"ok": True, "value": value, "nextRef": next_ref}
                if operation == "resolve" and args["ref"] == "ref_999":
                    envelope = {
                        "ok": False,
                        "error": {"code": "stale_ref", "message": "stale ref; read_page again"},
                        "nextRef": next_ref,
                    }
                result = (
                    {"result": {"objectId": "pinned-input", "subtype": "node"}}
                    if operation == "file_input"
                    else {"result": {"value": envelope}}
                )
            elif method == "Page.navigate":
                target = next(t for t, s in self.session.items() if s == session)
                request = f"request-{len(self.pause)}"
                self.pause[request] = (target, session, params["url"])
                self.event(
                    "Fetch.requestPaused",
                    {"requestId": request, "request": {"url": params["url"]}, "resourceType": "Document"},
                    session,
                )
                result = {"loaderId": request}
            elif method in {"Fetch.continueRequest", "Fetch.failRequest"} and params["requestId"] in self.pause:
                target, session, url = self.pause.pop(params["requestId"])
                loader = params["requestId"]
                if method == "Fetch.continueRequest":
                    self.tabs[target]["url"] = url
                    self.event(
                        "Page.frameNavigated", {"frame": {"id": target, "url": url, "loaderId": loader}}, session
                    )
                    self.event(
                        "Network.responseReceived",
                        {"type": "Document", "frameId": target, "loaderId": loader, "response": {"status": 200}},
                        session,
                    )
                self.event(
                    "Page.lifecycleEvent", {"frameId": target, "loaderId": loader, "name": "DOMContentLoaded"}, session
                )
            elif method == "Page.captureScreenshot":
                result = {"data": PNG}
            elif method == "Page.getLayoutMetrics":
                result = {"cssVisualViewport": {"pageX": 0, "pageY": 100}}
            elif method == "Target.closeTarget":
                result = {"success": params["targetId"] not in self.close_failed}
                if result["success"]:
                    self.tabs.pop(params["targetId"], None)
                    self.event("Target.targetDestroyed", {"targetId": params["targetId"]})
            elif method == "Runtime.runIfWaitingForDebugger" and self.resume_after_detach and session == "worker":
                self.pending_resume[session] = msg
                continue
            elif method == "Target.detachFromTarget" and params["sessionId"] in self.pending_resume:
                self.reply(self.pending_resume.pop(params["sessionId"]))
            elif method == "Fixture.never":
                continue
            elif method == "Fixture.event":
                self.event("Fixture.callback", {})
            elif method == "Fixture.disconnect":
                ws.close()
                break
            self.reply(msg, result)

    def close(self):
        for timer in self.timers:
            timer.cancel()
            timer.join(2)
        if self.socket:
            self.socket.close()
        self.server.shutdown()
        self.thread.join(3)
