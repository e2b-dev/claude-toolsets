"""Native async E2B ownership; acquisition records survive cancellation."""

from __future__ import annotations

import asyncio
import json
import re
import time
from urllib.parse import urlsplit

from e2b import AsyncSandbox, CommandExitException
from e2b.sandbox.sandbox_api import SandboxNetworkOpts

from ._async import finish_cleanup
from ._sandbox import BrowserResources, chrome_command


class AsyncBrowserRuntime(BrowserResources):
    def __init__(self):
        super().__init__()
        self._cleanup = asyncio.Lock()

    async def _create(self, api_key, template, timeout, allow_out, metadata):
        network: SandboxNetworkOpts = {"allow_public_traffic": False, "mask_request_host": "localhost:${PORT}"}
        if allow_out is not None:
            network.update(allow_out=list(allow_out), deny_out=["0.0.0.0/0"])
        self.sandbox = await AsyncSandbox.create(
            template=template or "desktop",
            timeout=600 if timeout is None else timeout,
            api_key=api_key,
            metadata=metadata,
            network=network,
        )
        self.owned = True

    async def _prepare_directory(self):
        out = await self.sandbox.commands.run("mktemp -d /tmp/e2b-browser-XXXXXX", timeout=5)
        directory = out.stdout.strip()
        if not re.fullmatch(r"/tmp/e2b-browser-[A-Za-z0-9]+", directory):
            raise RuntimeError("Could not prepare the browser directory")
        self.directory = directory
        await self.sandbox.commands.run(f"mkdir -m 700 {directory}/downloads", timeout=5)

    async def _launch(self, viewport, display):
        handle = await self.sandbox.commands.run(
            chrome_command(self.directory, viewport, display), background=True, timeout=0
        )
        self.pid = handle.pid
        await handle.disconnect()

    async def start(self, *, sandbox, api_key, template, timeout, viewport, display, allow_out, metadata):
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
            await finish_cleanup(self._create(api_key, template, timeout, allow_out, metadata))
        else:
            self.stage = "sandbox attachment"
            self.sandbox = sandbox
        token = self.sandbox.traffic_access_token
        if not token:
            raise ValueError("A private sandbox with mask_request_host='localhost:${PORT}' is required")
        self.stage = "browser directory preparation"
        await finish_cleanup(self._prepare_directory())
        self.stage = "Chrome discovery"
        path = await self._endpoint()
        if path is None:
            self.stage = "Chrome startup"
            await finish_cleanup(self._launch(viewport, display))
            deadline = time.monotonic() + 60
            while path is None and time.monotonic() < deadline:
                await asyncio.sleep(0.25)
                path = await self._endpoint()
        if path is None:
            raise RuntimeError("Chrome did not start within 60 seconds")
        return f"wss://{self.sandbox.get_host(9222)}{path}", {"e2b-traffic-access-token": token}

    async def _endpoint(self):
        try:
            out = await self.sandbox.commands.run("curl -fsS -m 1 http://127.0.0.1:9222/json/version", timeout=5)
            path = urlsplit(json.loads(out.stdout)["webSocketDebuggerUrl"]).path
            return path if re.fullmatch(r"/devtools/browser/[A-Za-z0-9-]+", path) else None
        except (CommandExitException, ValueError, KeyError):
            return None

    async def _stop_process(self):
        if self.pid is not None:
            try:
                await self.sandbox.commands.kill(self.pid)
            except Exception:
                raise RuntimeError("Could not stop the owned Chrome process; retry close()") from None
            self.pid = None

    async def stop_chrome(self):
        async with self._cleanup:
            await self._stop_process()

    async def close(self):
        async with self._cleanup:
            if self.sandbox is None:
                return
            if self.owned:
                try:
                    await self.sandbox.kill()
                except Exception:
                    raise RuntimeError("Could not kill the owned browser sandbox; retry close()") from None
                self.owned = False
                self.pid = None
                self.directory = None
                return
            await self._stop_process()
            if self.directory is not None:
                try:
                    await self.sandbox.files.remove(self.directory)
                except Exception:
                    raise RuntimeError("Could not remove the browser directory; retry close()") from None
                self.directory = None
