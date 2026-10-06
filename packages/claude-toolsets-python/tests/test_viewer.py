import threading
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urljoin, urlsplit

import httpx
from e2b import CommandExitException
from support import Desktop
from websockets.exceptions import InvalidStatus
from websockets.sync.client import connect
from websockets.sync.server import serve
from websockets.typing import Origin

from e2b_claude_toolsets import live_view


class ViewerTests(unittest.TestCase):
    def setUp(self):
        self.desktop = Desktop()
        original = self.desktop.run

        def run(command, **kw):
            if command == "pgrep -x x11vnc":
                raise CommandExitException("", "", 1, None)
            return original(command, **kw)

        self.desktop.commands.run = run
        self.view = live_view(self.desktop)
        self.addCleanup(self.view.stop)
        self.requests = []

        def transport(request):
            self.requests.append(request)
            return httpx.Response(200, content=b"noVNC fixture", headers={"Content-Type": "text/html"})

        self.view._http.close()
        self.view._http = httpx.Client(transport=httpx.MockTransport(transport), timeout=1)

    def test_http_capability_origin_and_redaction(self):
        with httpx.Client(trust_env=False) as client:
            response = client.get(self.view.url)
            self.assertEqual(response.status_code, 200)
            self.assertNotIn("PRIVATE-TRAFFIC-TOKEN", response.text + str(response.headers))
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            self.assertEqual(self.requests[0].headers["e2b-traffic-access-token"], "PRIVATE-TRAFFIC-TOKEN")
            for url, headers in [
                (self.view._origin + "/vnc.html", {}),
                (self.view.url, {"Origin": "https://evil.test"}),
                (self.view._origin + self.view._prefix + "%2e%2e/private", {}),
                (self.view.url, {"Host": "evil.test"}),
            ]:
                with self.subTest(url=url):
                    self.assertEqual(client.get(url, headers=headers).status_code, 403)

    def test_client_websocket_path_resolves_from_nested_viewer_url(self):
        # noVNC resolves its path query parameter against the viewer document.
        path = parse_qs(urlsplit(self.view.url).query)["path"][0]
        endpoint = urljoin(self.view.url, path)
        self.assertEqual(endpoint, self.view._origin + self.view._prefix + "websockify")

    def test_websocket_routes_relay_and_cleanup(self):
        def echo(ws):
            self.assertEqual(ws.request.headers["e2b-traffic-access-token"], "PRIVATE-TRAFFIC-TOKEN")
            for message in ws:
                ws.send(message)

        upstream = serve(echo, "127.0.0.1", 0, close_timeout=1)
        worker = threading.Thread(target=upstream.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(worker.join, 3)
        self.addCleanup(upstream.shutdown)
        upstream_url = f"ws://127.0.0.1:{upstream.socket.getsockname()[1]}"
        route = self.view.url.split("?")[0].replace("http:", "ws:").replace("vnc.html", "websockify")
        real_connect = connect

        def dial(_url, **kw):
            return real_connect(upstream_url, **kw)

        with patch("e2b_claude_toolsets._viewer.connect", dial):
            with connect(route, origin=Origin(self.view._origin), proxy=None, close_timeout=1) as ws:
                ws.send(b"frame")
                self.assertEqual(ws.recv(timeout=2), b"frame")
            for origin in [None, "https://evil.test"]:
                with self.assertRaises(InvalidStatus):
                    connect(route, origin=Origin(origin) if origin else None, proxy=None, close_timeout=1)
        self.view.stop()
        self.view.stop()
        self.assertEqual(self.desktop.calls.count(("stop-stream",)), 1)
        assert self.view._thread is not None
        self.assertFalse(self.view._thread.is_alive())
        self.assertTrue(all(not t.is_alive() for t in self.view._relays))
        self.assertNotIn("kill-sandbox", self.desktop.calls)

    def test_body_limit_and_upstream_error_do_not_leak(self):
        self.view._http.close()
        self.view._http = httpx.Client(
            transport=httpx.MockTransport(lambda _: httpx.Response(200, content=b"x" * (8 * 1024 * 1024 + 1)))
        )
        self.assertEqual(httpx.get(self.view.url, trust_env=False).status_code, 502)
        self.view._http.close()

        def error(_):
            raise RuntimeError("PRIVATE-TRAFFIC-TOKEN")

        self.view._http = httpx.Client(transport=httpx.MockTransport(error))
        response = httpx.get(self.view.url, trust_env=False)
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("PRIVATE-TRAFFIC-TOKEN", response.text)

    def test_failed_stream_cleanup_retries(self):
        stop = self.desktop.stream.stop
        self.desktop.stream.stop = lambda: (_ for _ in ()).throw(RuntimeError("private"))
        with self.assertRaises(RuntimeError):
            self.view.stop()
        self.assertTrue(self.view._owned_stream)
        self.desktop.stream.stop = stop
        self.view.stop()
        self.assertFalse(self.view._owned_stream)

    def test_failed_start_does_not_leak_the_raw_error(self):
        import traceback

        desktop = Desktop()
        original = desktop.run

        def run(command, **kw):
            if command == "pgrep -x x11vnc":
                raise CommandExitException("", "", 1, None)
            return original(command, **kw)

        desktop.commands.run = run
        desktop.stream.start = lambda **kw: (_ for _ in ()).throw(RuntimeError("token=e2b_SECRET_TOKEN_sentinel"))
        with self.assertRaises(RuntimeError) as raised:
            live_view(desktop)
        self.assertNotIn("SECRET", "".join(traceback.format_exception(raised.exception)))

    def test_borrowed_stream_is_not_stopped(self):
        desktop = Desktop()
        with self.assertRaises(ValueError):
            live_view(desktop)
        self.assertNotIn(("stop-stream",), desktop.calls)
        self.assertFalse(any(isinstance(c, tuple) and c[0] == "start-stream" for c in desktop.calls))


if __name__ == "__main__":
    unittest.main()
