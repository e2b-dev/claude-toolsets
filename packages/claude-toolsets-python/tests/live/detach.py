"""LIVE native async detach/fork/pause check. Creates billable E2B resources; run explicitly."""

import asyncio
import os

from anthropic.types.beta import BetaToolUseBlock
from e2b import AsyncSandbox

from e2b_claude_toolsets import AsyncE2BBrowserToolset, allow_hosts


async def call(browser, name, **data):
    result = await browser.tool_result(
        BetaToolUseBlock(id="snapshot", type="tool_use", name=name, input=data, toolset_name="browser")
    )
    assert not result.get("is_error"), result
    return "\n".join(block["text"] for block in result["content"] if block["type"] == "text")


async def main():
    resources = []
    try:
        sandbox = await AsyncSandbox.create(
            template=os.environ.get("TEMPLATE", "desktop"),
            timeout=300,
            network={
                "allow_public_traffic": False,
                "mask_request_host": "localhost:${PORT}",
                "deny_out": ["0.0.0.0/0"],
            },
        )
        resources.append(sandbox)
        info = await sandbox.get_info()
        assert tuple(int(part) for part in info.envd_version.split(".")[:3]) >= (0, 5, 0), (
            "Snapshots require envd >=0.5.0"
        )
        await sandbox.files.write(
            "/tmp/index.html", '<!doctype html><title>Snapshot fixture</title><input id="state" value="initial">'
        )
        server = await sandbox.commands.run(
            "python3 -m http.server 8000 --bind 127.0.0.1 --directory /tmp", background=True, timeout=0
        )
        await server.disconnect()
        await sandbox.commands.run(
            "for i in $(seq 1 50); do curl -fsS http://localhost:8000/index.html >/dev/null && exit 0; sleep .1; done; exit 1",
            timeout=10,
        )
        options = dict(
            url_policy=allow_hosts(["localhost:8000"]),
            configs={"javascript_exec": {"enabled": True}},
            confirm=lambda _: True,
        )
        async with await AsyncE2BBrowserToolset.create(sandbox=sandbox, **options) as browser:
            await call(browser, "navigate", url="http://localhost:8000/index.html")
            await call(
                browser,
                "javascript_exec",
                text='document.querySelector("#state").value="snapshot-value";document.cookie="snapshot=cookie";window.snapshotValue=42',
            )
            await browser.detach()
        forks = await sandbox.fork(count=1, timeout=180)
        resources.extend(clone for clone in forks if not isinstance(clone, Exception))
        clone = forks[0]
        if isinstance(clone, Exception):
            raise clone
        async with await AsyncE2BBrowserToolset.create(sandbox=clone, **options) as browser:
            state = await call(
                browser,
                "javascript_exec",
                text='[document.querySelector("#state").value,document.cookie,window.snapshotValue]',
            )
            assert all(value in state for value in ("snapshot-value", "snapshot=cookie", "42"))
            await call(browser, "navigate", url="http://localhost:8000/index.html?fork")
        print("PASS fork preserves page memory and accepts new navigation")
        await clone.kill()
        await sandbox.pause(keep_memory=True)
        resumed = await sandbox.connect(timeout=180)
        async with await AsyncE2BBrowserToolset.create(sandbox=resumed, **options) as browser:
            state = await call(
                browser,
                "javascript_exec",
                text='[document.querySelector("#state").value,document.cookie,window.snapshotValue]',
            )
            assert all(value in state for value in ("snapshot-value", "snapshot=cookie", "42"))
            await call(browser, "navigate", url="http://localhost:8000/index.html?resumed")
        print("PASS pause/resume preserves page memory and accepts new navigation")
    finally:
        failures = []
        for resource in resources:
            try:
                await resource.kill()
            except Exception:
                failures.append(resource.sandbox_id)
        if failures:
            raise RuntimeError(f"Could not remove test resources; retry kill() for: {failures}")


if __name__ == "__main__":
    asyncio.run(main())
