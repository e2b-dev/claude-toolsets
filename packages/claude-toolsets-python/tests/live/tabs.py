"""LIVE: stress Python tab creation on a disposable E2B desktop."""

import time

from anthropic.types.beta import BetaToolUseBlock
from e2b_desktop import Sandbox

from e2b_claude_toolsets import E2BBrowserToolset


def call(browser, name, **data):
    result = browser.tool_result(
        BetaToolUseBlock(type="tool_use", id="tabs", toolset_name="browser", name=name, input=data)
    )
    assert not result.get("is_error"), f"{name}: {result}"
    return result


desktop = Sandbox.create(
    timeout=600,
    network={"allow_public_traffic": False, "mask_request_host": "localhost:${PORT}", "deny_out": ["0.0.0.0/0"]},
    metadata={"purpose": "shared-runtime-live-tabs"},
)
try:
    with E2BBrowserToolset(sandbox=desktop, display=":0") as browser:
        for iteration in range(100):
            start = time.monotonic()
            call(browser, "new_tab")
            state = next(b for b in call(browser, "list_tabs")["content"] if b["type"] == "browser_state")
            assert len(state["tabs"]) == 2
            call(browser, "read_page", filter="all")
            call(browser, "close_tab", tab_id=state["tabs"][-1]["tab_id"])
            print(f"PASS tab cycle {iteration + 1}: {time.monotonic() - start:.2f}s", flush=True)
finally:
    desktop.kill()
    assert not desktop.is_running()
    print("Tab test desktop cleanup verified", flush=True)
