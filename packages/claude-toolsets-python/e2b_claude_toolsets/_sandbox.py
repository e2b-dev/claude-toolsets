"""Explicit sandbox/Chrome ownership, including partially completed startup."""

from __future__ import annotations

import json
import re
import shlex
import threading
import time
from typing import Any
from urllib.parse import urlsplit

from e2b import CommandExitException, Sandbox
from e2b.sandbox.sandbox_api import SandboxNetworkOpts


def resolve_display(sandbox, headless, display):
    """The X display Chrome opens a window on, or None to run it headless.

    Default: visible on the screen of an e2b_desktop sandbox (usually ":0"), so the live view and the computer toolset
    see it; headless everywhere else. headless=True hides it on a desktop too; display picks a screen explicitly.
    """
    if headless is not None and not isinstance(headless, bool):
        raise ValueError("headless must be True, False or None")
    if headless:
        if display is not None:
            raise ValueError("headless=True and display contradict each other; pass one")
        return None
    # e2b_desktop keeps the screen in the private _display; a public display is used first if a release adds one
    screen = getattr(sandbox, "display", None)
    if not isinstance(screen, str):
        screen = getattr(sandbox, "_display", None)
    chosen = display if display is not None else (screen if isinstance(screen, str) else None)
    if headless is False and chosen is None:
        raise ValueError("headless=False needs a screen: attach an e2b_desktop sandbox or pass display")
    return chosen


def chrome_command(directory, viewport, display):
    flags = [
        "google-chrome",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=9222",
        f"--user-data-dir={directory}/profile",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-extensions",
        "--disable-sync",
        "--disable-dev-shm-usage",
        f"--window-size={viewport[0]},{viewport[1]}",
        "--enable-features=LocalNetworkAccessChecks",
        *(["--headless=new"] if display is None else ["--window-position=0,0", "--test-type"]),
        "about:blank",
    ]
    env = "" if display is None else " DISPLAY=" + shlex.quote(display)
    return f'exec env -i HOME="$HOME" PATH="$PATH" LANG=C.UTF-8{env} {shlex.join(flags)} >{directory}/chrome.log 2>&1'


class BrowserResources:
    def __init__(self) -> None:
        self.sandbox: Any = None
        self.owned = False
        self.pid: int | None = None
        self.directory: str | None = None
        self.stage = "sandbox creation"

    @staticmethod
    def validate_options(*, sandbox, api_key, display, allow_out, metadata, template=None, timeout=None):
        if display is not None and (not isinstance(display, str) or not re.fullmatch(r":\d{1,3}", display)):
            raise ValueError("display must look like :0")
        creation = dict(api_key=api_key, template=template, timeout=timeout, allow_out=allow_out, metadata=metadata)
        refused = [name for name, value in creation.items() if value is not None]
        if sandbox is not None and refused:
            raise ValueError(", ".join(refused) + " apply only when creating a sandbox")
        if sandbox is not None and not sandbox.traffic_access_token:
            raise ValueError("A private sandbox with mask_request_host='localhost:${PORT}' is required")


class BrowserRuntime(BrowserResources):
    def __init__(self):
        super().__init__()
        self._lock = threading.RLock()

    def start(self, *, sandbox, api_key, template, timeout, viewport, display, allow_out, metadata):
        self.validate_options(
            sandbox=sandbox,
            api_key=api_key,
            display=display,
            allow_out=allow_out,
            metadata=metadata,
            template=template,
            timeout=timeout,
        )
        if sandbox is None:
            network: SandboxNetworkOpts = {"allow_public_traffic": False, "mask_request_host": "localhost:${PORT}"}
            if allow_out is not None:
                network.update(allow_out=list(allow_out), deny_out=["0.0.0.0/0"])
            self.sandbox = Sandbox.create(
                template=template or "desktop",
                timeout=600 if timeout is None else timeout,
                api_key=api_key,
                metadata=metadata,
                network=network,
            )
            self.owned = True
        else:
            self.stage = "sandbox attachment"
            self.sandbox = sandbox
        token = self.sandbox.traffic_access_token
        if not token:
            raise ValueError("A private sandbox with mask_request_host='localhost:${PORT}' is required")
        self.stage = "browser directory preparation"
        out = self.sandbox.commands.run("mktemp -d /tmp/e2b-browser-XXXXXX", timeout=5)
        directory = out.stdout.strip()
        if not re.fullmatch(r"/tmp/e2b-browser-[A-Za-z0-9]+", directory):
            raise RuntimeError("Could not prepare the browser directory")
        self.directory = directory
        self.sandbox.commands.run(f"mkdir -m 700 {directory}/downloads", timeout=5)
        self.stage = "Chrome discovery"
        path = self._endpoint()
        if path is None:
            self.stage = "Chrome startup"
            command = chrome_command(directory, viewport, display)
            handle = self.sandbox.commands.run(command, background=True, timeout=0)
            self.pid = handle.pid
            handle.disconnect()
            deadline = time.monotonic() + 60
            while path is None and time.monotonic() < deadline:
                time.sleep(0.25)
                path = self._endpoint()
        if path is None:
            raise RuntimeError("Chrome did not start within 60 seconds")
        return f"wss://{self.sandbox.get_host(9222)}{path}", {"e2b-traffic-access-token": token}

    def _endpoint(self) -> str | None:
        try:
            out = self.sandbox.commands.run("curl -fsS -m 1 http://127.0.0.1:9222/json/version", timeout=5)
            path = urlsplit(json.loads(out.stdout)["webSocketDebuggerUrl"]).path
            return path if re.fullmatch(r"/devtools/browser/[A-Za-z0-9-]+", path) else None
        except (CommandExitException, ValueError, KeyError):
            return None

    def stop_chrome(self) -> None:
        with self._lock:
            if self.pid is not None:
                try:
                    self.sandbox.commands.kill(self.pid)
                except Exception:
                    raise RuntimeError("Could not stop the owned Chrome process; retry close()") from None
                self.pid = None

    def close(self) -> None:
        with self._lock:
            if self.sandbox is None:
                return
            if self.owned:
                try:
                    self.sandbox.kill()  # False means it was already absent (404), also successful cleanup.
                except Exception:
                    raise RuntimeError("Could not kill the owned browser sandbox; retry close()") from None
                self.owned = False
                self.pid = None
                self.directory = None
                return
            self.stop_chrome()
            if self.directory is not None:
                try:
                    self.sandbox.files.remove(self.directory)
                except Exception:
                    raise RuntimeError("Could not remove the browser directory; retry close()") from None
                self.directory = None
