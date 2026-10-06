"""LIVE: creates a paid E2B desktop and makes Anthropic calls. Run explicitly."""

import os
import subprocess
from pathlib import Path

from anthropic import Anthropic
from anthropic.types.beta import BetaToolUseBlock
from e2b_desktop import Sandbox

from e2b_claude_toolsets import E2BBrowserToolset, E2BComputerToolset, allow_hosts, live_view

# The noVNC framebuffer check is shared with the TypeScript live tests.
VIEWER_CHECK = Path(__file__).resolve().parents[3] / "claude-toolsets-js/tests/live/viewer.ts"


def trace(toolset):
    original = toolset.tool_result
    called = set()

    def traced(block, *args, **kwargs):
        called.add(block.name)
        print(f"{toolset.toolset_name} tool {block.name}", flush=True)
        return original(block, *args, **kwargs)

    toolset.tool_result = traced
    return original, called


desktop = Sandbox.create(
    resolution=(1280, 800),
    timeout=600,
    network={"allow_public_traffic": False, "mask_request_host": "localhost:${PORT}", "deny_out": ["0.0.0.0/0"]},
    metadata={"purpose": "shared-runtime-live-model-test"},
)
print("Created disposable Python test desktop", desktop.sandbox_id, flush=True)
try:
    desktop.files.make_dir("/tmp/runtime-model-fixture")
    desktop.files.write(
        "/tmp/runtime-model-fixture/index.html",
        """<!doctype html><title>Runtime verification</title>
<label>Message <input id="message"></label>
<button onclick="document.querySelector('output').textContent='Verified: '+document.querySelector('input').value">Verify</button>
<output></output>""",
    )
    server = desktop.commands.run(
        "python3 -m http.server 8000 --bind 127.0.0.1 --directory /tmp/runtime-model-fixture",
        background=True,
        timeout=0,
    )
    server.disconnect()
    desktop.commands.run(
        "for i in $(seq 1 50); do curl -fsS http://127.0.0.1:8000 >/dev/null && exit 0; sleep 0.1; done; exit 1"
    )
    with live_view(desktop) as view:
        viewer_check = subprocess.run(["bun", str(VIEWER_CHECK), view.url], check=False)
        client = Anthropic()
        model = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5-5")
        with E2BBrowserToolset(sandbox=desktop, display=":0", url_policy=allow_hosts(["localhost:8000"])) as browser:
            original, called = trace(browser)
            client.beta.messages.tool_runner(
                model=model,
                max_tokens=1024,
                max_iterations=15,
                tools=[browser],
                messages=[
                    {
                        "role": "user",
                        "content": "Test this disposable browser. Navigate to http://localhost:8000. Use read_page and find to locate Message. Use form_input with its element reference to set it to BROWSER_OK, then click Verify using its reference. Read the resulting page text and take a screenshot. Stop after verifying it says Verified: BROWSER_OK. Do not visit any other website.",
                    }
                ],
            ).until_done()
            result = original(
                BetaToolUseBlock(type="tool_use", id="verify", toolset_name="browser", name="get_page_text", input={})
            )
            assert not result.get("is_error") and "Verified: BROWSER_OK" in str(result["content"])
            assert {"read_page", "find", "form_input", "left_click", "screenshot"} <= called, called
            print("PASS Python model browser task verified from actual page state", flush=True)
        with E2BComputerToolset(desktop, confirm=lambda _: True) as computer:
            original, called = trace(computer)
            client.beta.messages.tool_runner(
                model=model,
                max_tokens=1024,
                max_iterations=15,
                tools=[computer],
                messages=[
                    {
                        "role": "user",
                        "content": "Test this disposable desktop using the computer tools. Take a screenshot, open a terminal (Ctrl+Alt+t should work), and type and execute: printf COMPUTER_OK > /tmp/runtime-computer-check.txt . Take another screenshot and stop. This file is the sole task; do not access the network.",
                    }
                ],
            ).until_done()
            assert desktop.commands.run("cat /tmp/runtime-computer-check.txt").stdout.strip() == "COMPUTER_OK"
            assert {"screenshot", "type", "key"} <= called, called
            print("PASS Python model computer task verified from sandbox file", flush=True)
        assert viewer_check.returncode == 0, "Live viewer did not receive the framebuffer"
finally:
    desktop.kill()
    print("Python test desktop cleanup completed", flush=True)
