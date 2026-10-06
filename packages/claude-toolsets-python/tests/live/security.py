"""Manual, billable E2B check that an iframe whose interception fails never runs past the URL policy; no model.

The page's cross-site iframe loads a beacon from a port the URL policy refuses. With Fetch.enable failing for new
targets (and, in a second run, closing them failing too), the beacon must never arrive: the iframe stays paused
until its interception is confirmed. Covers the sync and the async driver.
"""

import asyncio
import time
from concurrent.futures import Future
from unittest.mock import patch

from anthropic.types.beta import BetaToolUseBlock
from e2b import AsyncSandbox
from e2b_desktop import Sandbox

from e2b_claude_toolsets import AsyncE2BBrowserToolset, E2BBrowserToolset, allow_hosts
from e2b_claude_toolsets._async_cdp import AsyncCdpClient
from e2b_claude_toolsets._cdp import CdpClient

POLICY = ["localhost:8000", "127.0.0.1:8000"]
OUTER = "http://localhost:8000/outer.html"
failures = []


def check(ok, what, detail=""):
    if not ok:
        failures.append(what)
    print(f"   {'PASS' if ok else 'FAIL'} {what}{' · ' + detail if detail else ''}")


def navigate_use():
    return BetaToolUseBlock(
        id="security", type="tool_use", toolset_name="browser", name="navigate", input={"url": OUTER}
    )


def failed_future():
    future = Future()
    future.set_exception(RuntimeError("injected failure"))
    return 0, future


def main():
    desktop = Sandbox.create(
        timeout=600, network={"allow_public_traffic": False, "mask_request_host": "localhost:${PORT}"}
    )
    try:
        desktop.files.write("/tmp/site/outer.html", '<iframe src="http://127.0.0.1:8000/inner.html"></iframe>')
        desktop.files.write("/tmp/site/inner.html", '<img src="http://127.0.0.1:8001/beacon.png">')
        desktop.commands.run("cd /tmp/site && python3 -m http.server 8000 --bind 0.0.0.0", background=True)
        desktop.commands.run("cd /tmp && python3 -m http.server 8001 --bind 0.0.0.0 2>/tmp/beacon.log", background=True)
        time.sleep(1)

        def beacons():
            return int(desktop.commands.run("grep -c beacon /tmp/beacon.log || true").stdout.strip())

        def reset():
            desktop.commands.run(": > /tmp/beacon.log")
            for _ in range(40):
                if int(desktop.commands.run("pgrep -fc -- '[-]-user-data-dir=/tmp/e2b-browser-' || true").stdout) == 0:
                    return
                time.sleep(0.25)

        print("Sync driver")
        with E2BBrowserToolset(sandbox=desktop, headless=True, url_policy=allow_hosts(POLICY)) as browser:
            browser.tool_result(navigate_use())
            time.sleep(2)
            check(beacons() == 0, "baseline: the beacon is refused by the URL policy")
        for close_fails in (False, True):
            reset()
            label = "closing fails too" if close_fails else "interception fails"
            original = CdpClient.request
            armed = {"on": False}

            def request(self, method, params=None, session=None, _original=original, _close=close_fails):
                if armed["on"] and (method == "Fetch.enable" or (_close and method == "Target.closeTarget")):
                    return failed_future()
                return _original(self, method, params, session)

            with patch.object(CdpClient, "request", request):
                browser = E2BBrowserToolset(sandbox=desktop, headless=True, url_policy=allow_hosts(POLICY))
                armed["on"] = True
                browser.tool_result(navigate_use())
                time.sleep(2)
                armed["on"] = False
                check(beacons() == 0, f"sync, {label}: the iframe never sent its beacon", f"{beacons()} request(s)")
                try:
                    browser.close()
                except Exception:
                    pass

        print("Async driver")

        async def run_async():
            sandbox = await AsyncSandbox.connect(desktop.sandbox_id)
            for close_fails in (False, True):
                reset()
                label = "closing fails too" if close_fails else "interception fails"
                original = AsyncCdpClient.request
                armed = {"on": False}

                async def request(self, method, params=None, session=None, _original=original, _close=close_fails):
                    if armed["on"] and (method == "Fetch.enable" or (_close and method == "Target.closeTarget")):
                        future = asyncio.get_running_loop().create_future()
                        future.set_exception(RuntimeError("injected failure"))
                        return 0, future
                    return await _original(self, method, params, session)

                with patch.object(AsyncCdpClient, "request", request):
                    browser = await AsyncE2BBrowserToolset.create(
                        sandbox=sandbox, headless=True, url_policy=allow_hosts(POLICY)
                    )
                    armed["on"] = True
                    await browser.tool_result(navigate_use())
                    await asyncio.sleep(2)
                    armed["on"] = False
                    check(
                        beacons() == 0, f"async, {label}: the iframe never sent its beacon", f"{beacons()} request(s)"
                    )
                    try:
                        await browser.close()
                    except Exception:
                        pass

        asyncio.run(run_async())
    finally:
        desktop.kill()
    print(f"\n{len(failures)} check(s) failed." if failures else "\nAll checks passed.")
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
