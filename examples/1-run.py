"""Browser use on a private E2B desktop. Requires E2B and Anthropic API credentials."""

import os
import sys

from anthropic import Anthropic
from e2b_desktop import Sandbox

from e2b_claude_toolsets import (
    E2BBrowserToolset,
    allow_hosts,
    live_view,
)

task = " ".join(sys.argv[1:]) or (
    "Go to github.com/e2b-dev/E2B, tell me how many stars the repo has, "
    "then open its releases and summarize the latest release in three bullets."
)
# GitHub serves its CSS, scripts and images from githubassets.com and githubusercontent.com.
domains = ["github.com", "githubassets.com", "githubusercontent.com"]

desktop = Sandbox.create(
    resolution=(1280, 800),
    timeout=600,
    network={
        "allow_public_traffic": False,  # required: keeps Chrome's DevTools port and the desktop stream private
        "mask_request_host": "localhost:${PORT}",
        "allow_out": [host for d in domains for host in (d, f"*.{d}")],  # enforced by E2B
        "deny_out": ["0.0.0.0/0"],
    },
)
try:
    with live_view(desktop) as view:
        print(f"Watch live: {view.url}")
        with E2BBrowserToolset.create(
            sandbox=desktop,
            url_policy=allow_hosts(domains),  # the model may only navigate to these hosts (enforced by the SDK)
        ) as browser:
            runner = Anthropic().beta.messages.tool_runner(
                model=os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5-5"),
                max_tokens=1024,
                tools=[browser],
                messages=[{"role": "user", "content": task}],
            )
            answer = runner.until_done()
            print(next(block.text for block in answer.content if block.type == "text"))
finally:
    desktop.kill()
