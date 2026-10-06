"""Computer use on a private desktop. This demo explicitly approves unattended input."""

import os
import sys

from anthropic import Anthropic
from e2b_desktop import Sandbox

from e2b_claude_toolsets import E2BComputerToolset, live_view

task = " ".join(sys.argv[1:]) or "Open a text editor and write a short explanation of what E2B does."
desktop = Sandbox.create(resolution=(1280, 800), timeout=600, network={"allow_public_traffic": False})
try:
    with live_view(desktop) as view:
        print(f"Watch live: {view.url}")
        with E2BComputerToolset.create(desktop, confirm=lambda context: True) as computer:
            answer = (
                Anthropic()
                .beta.messages.tool_runner(
                    model=os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5-5"),
                    max_tokens=2048,
                    max_iterations=30,
                    tools=[computer],
                    messages=[{"role": "user", "content": task}],
                )
                .until_done()
            )
            print("\n".join(block.text for block in answer.content if block.type == "text"))
finally:
    desktop.kill()
