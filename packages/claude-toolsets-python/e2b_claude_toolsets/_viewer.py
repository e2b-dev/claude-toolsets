"""Private noVNC reverse proxy on loopback. Remote credentials never enter browser responses."""

from __future__ import annotations

import logging
import secrets
import socket
import threading
from urllib.parse import unquote, urlencode, urlsplit

import httpx
from e2b import CommandExitException
from websockets.datastructures import Headers
from websockets.http11 import Response
from websockets.sync.client import connect
from websockets.sync.server import serve

_LOG = logging.getLogger(__name__)
_LOG.addHandler(logging.NullHandler())
_LOG.propagate = False


class ViewerInitializationError(RuntimeError):
    """Retry partial-startup cleanup with error.view.stop()."""

    def __init__(self, view):
        super().__init__("Viewer startup and cleanup failed; retry error.view.stop()")
        self.view = view


class LiveView:
    """A local capability URL. Use one exclusive desktop; an existing VNC stream is refused."""

    def __init__(self, desktop):
        self._desktop = desktop
        self._owned_stream = False
        self._server = None
        self._thread = None
        self._peers = set()
        self._relays = set()
        self._workers = set()
        self._lock = threading.RLock()
        self._stopped = False
        self._prefix = "/s/" + secrets.token_urlsafe(32) + "/"
        token = desktop.traffic_access_token
        if not token:
            raise ValueError("live_view requires a private desktop")
        self._headers = {"e2b-traffic-access-token": token}
        self._host = desktop.get_host(6080)
        self._http = httpx.Client(timeout=10, trust_env=False, follow_redirects=False)
        sock = socket.socket()
        try:
            # The SDK's stop() is sandbox-wide: do not attach to or stop somebody else's stream.
            try:
                desktop.commands.run("pgrep -x x11vnc", timeout=5)
            except CommandExitException:
                pass
            else:
                raise ValueError("The desktop already has a VNC stream; use a fresh exclusive desktop")
            self._owned_stream = True  # cleanup also covers a partially completed SDK start()
            desktop.stream.start(port=6080, require_auth=False)
            sock.bind(("127.0.0.1", 0))
            sock.listen()
            port = sock.getsockname()[1]
            self._origin = f"http://127.0.0.1:{port}"
            self.url = (
                self._origin
                + self._prefix
                + "vnc.html?"
                + urlencode(
                    {
                        "autoconnect": "true",
                        "resize": "scale",
                        "path": self._prefix + "websockify",
                    }
                )
            )
            self._server = serve(
                self._handle,
                sock=sock,
                process_request=self._request,
                compression=None,
                max_size=8 * 1024 * 1024,
                max_queue=2,
                open_timeout=10,
                close_timeout=2,
                logger=_LOG,
            )
            self._thread = threading.Thread(target=self._server.serve_forever, name="e2b-viewer", daemon=True)
            self._thread.start()
        except BaseException as error:
            sock.close()
            try:
                self.stop()
            except BaseException:
                # from None: the startup error can carry the sandbox host or traffic token
                raise ViewerInitializationError(self) from None
            # ValueError is this function's own precondition message; anything else may carry the host or token
            if isinstance(error, (KeyboardInterrupt, SystemExit, ValueError)):
                raise
            raise RuntimeError("Could not start the live view") from None

    def _response(self, status, body=b"", headers=None):
        return Response(
            status,
            {200: "OK", 403: "Forbidden", 502: "Bad Gateway"}.get(status, "Response"),
            Headers(
                {
                    "Content-Length": str(len(body)),
                    "Cache-Control": "no-store",
                    "Referrer-Policy": "no-referrer",
                    **(headers or {}),
                }
            ),
            body,
        )

    def _request(self, connection, request):
        with self._lock:
            self._workers = {t for t in self._workers if t.is_alive()}
            if self._stopped or len(self._workers) >= 8:
                return self._response(403)
            self._workers.add(threading.current_thread())
        parsed = urlsplit(request.path)
        path = unquote(parsed.path)
        origin = request.headers.get("Origin")
        host = request.headers.get("Host")
        if (
            host != urlsplit(self._origin).netloc
            or not path.startswith(self._prefix)
            or any(p in {".", ".."} for p in path.split("/"))
            or "\\" in path
            or "%" in path
            or (origin is not None and origin != self._origin)
            or self._stopped
        ):
            return self._response(403)
        route = path[len(self._prefix) :]
        if request.headers.get("Upgrade", "").lower() == "websocket":
            with self._lock:
                if route != "websockify" or origin != self._origin or len(self._peers) >= 8:
                    return self._response(403)
                self._peers.add(connection)
            return None
        if route == "websockify":
            return self._response(403)
        try:
            target = f"https://{self._host}/{route}" + ("?" + parsed.query if parsed.query else "")
            with self._http.stream("GET", target, headers=self._headers) as upstream:
                if upstream.status_code != 200:
                    return self._response(502)
                body = bytearray()
                for chunk in upstream.iter_bytes(65536):
                    if len(body) + len(chunk) > 8 * 1024 * 1024:
                        return self._response(502)
                    body.extend(chunk)
                return self._response(
                    200, bytes(body), {"Content-Type": upstream.headers.get("Content-Type", "application/octet-stream")}
                )
        except Exception:
            return self._response(502)

    def _handle(self, downstream):
        upstream = None
        relay = None
        try:
            upstream = connect(
                f"wss://{self._host}/websockify",
                additional_headers=self._headers,
                proxy=None,
                compression=None,
                max_size=8 * 1024 * 1024,
                max_queue=2,
                open_timeout=10,
                close_timeout=2,
                logger=_LOG,
            )
            with self._lock:
                if self._stopped:
                    return
                self._peers.add(upstream)
            relay = threading.Thread(target=self._relay, args=(upstream, downstream), name="e2b-vnc-relay", daemon=True)
            with self._lock:
                self._relays.add(relay)
            relay.start()
            self._relay(downstream, upstream)
        except Exception:
            downstream.close()
        finally:
            if upstream is not None:
                upstream.close()
            downstream.close()
            if relay is not None:
                relay.join(5)
            with self._lock:
                self._peers.discard(downstream)
                self._peers.discard(upstream)
                if relay is not None and not relay.is_alive():
                    self._relays.discard(relay)

    def _relay(self, source, destination):
        try:
            for message in source:
                destination.send(message)  # blocking send applies backpressure; queues are bounded above
        except Exception:
            pass
        finally:
            source.close()
            destination.close()

    def stop(self):
        with self._lock:
            self._stopped = True
            if self._server is not None:
                self._server.shutdown()
            peers, relays = tuple(self._peers), tuple(self._relays | self._workers)
        for peer in peers:
            peer.close()
        for thread in (*relays, self._thread):
            if thread is not None and thread is not threading.current_thread():
                thread.join(15)
                if thread.is_alive():
                    raise RuntimeError("Could not stop the viewer worker; retry stop()")
        self._http.close()
        if self._owned_stream:
            try:
                self._desktop.stream.stop()
            except Exception:
                raise RuntimeError("Could not stop the owned desktop stream; retry stop()") from None
            self._owned_stream = False

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.stop()


def live_view(desktop) -> LiveView:
    """Start a private live view; do not share its capability URL."""
    return LiveView(desktop)
