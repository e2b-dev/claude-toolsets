"""Native async tool runners. Billable: requires E2B and Anthropic credentials."""

import argparse
import asyncio
import os

from anthropic import AsyncAnthropic
from e2b import AsyncSandbox
from e2b_desktop import Sandbox as Desktop

from e2b_claude_toolsets import AsyncE2BBrowserToolset, AsyncE2BComputerToolset, allow_hosts


async def run(task, desktop_id=None):
    if desktop_id is None:
        domains = ["github.com", "githubassets.com", "githubusercontent.com"]
        toolset = await AsyncE2BBrowserToolset.create(
            allow_out=[host for domain in domains for host in (domain, f"*.{domain}")],
            url_policy=allow_hosts(domains),
        )
    else:
        desktop = await AsyncSandbox.connect(desktop_id)
        toolset = await AsyncE2BComputerToolset.create(desktop, confirm=lambda _: True)
    async with toolset, AsyncAnthropic() as client:
        answer = await client.beta.messages.tool_runner(
            model=os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5-5"),
            max_tokens=2048,
            max_iterations=30,
            tools=[toolset],
            messages=[{"role": "user", "content": task}],
        ).until_done()
        print("\n".join(block.text for block in answer.content if block.type == "text"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--computer", action="store_true")
    parser.add_argument("task", nargs="?")
    args = parser.parse_args()
    if args.computer:
        # Desktop 2.6.0 has sync startup helpers only. Bootstrap outside the event loop;
        # all toolset actions, screenshots and input use the native AsyncSandbox below.
        desktop = Desktop.create(resolution=(1280, 800), timeout=600, network={"allow_public_traffic": False})
        try:
            asyncio.run(run(args.task or "Open a text editor and write a short note about E2B.", desktop.sandbox_id))
        finally:
            desktop.kill()
    else:
        asyncio.run(run(args.task or "Read the latest release at github.com/e2b-dev/E2B and summarize it."))
