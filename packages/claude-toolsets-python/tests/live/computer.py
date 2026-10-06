"""Manual, billable E2B computer exercise: SDK dispatch, bounds and cleanup; no model."""

import base64
import time

from anthropic.types.beta import BetaToolUseBlock
from e2b_desktop import Sandbox

from e2b_claude_toolsets import E2BComputerToolset


def call(computer, name, **data):
    return computer.tool_result(
        BetaToolUseBlock(id="computer-check", type="tool_use", toolset_name="computer", name=name, input=data)
    )


def main():
    desktop = Sandbox.create(
        resolution=(1280, 800),
        timeout=300,
        network={"allow_public_traffic": False, "mask_request_host": "localhost:${PORT}"},
    )
    try:
        with E2BComputerToolset(desktop, confirm=lambda _: True) as computer:
            point = [640, 400]
            cases = {
                "screenshot": {},
                "cursor_position": {},
                "mouse_move": {"coordinate": [0, 0]},
                **{
                    name: {"coordinate": point}
                    for name in ("left_click", "right_click", "middle_click", "double_click", "triple_click")
                },
                "left_click_drag": {"start_coordinate": [600, 400], "coordinate": [700, 450]},
                "left_mouse_down": {},
                "left_mouse_up": {},
                "scroll": {"scroll_direction": "down", "scroll_amount": 50},
                "type": {"text": "hello"},
                "key": {"text": "Escape", "repeat": 5},
                "hold_key": {"text": "shift", "duration": 1},
                "wait": {"duration": 1},
            }
            for name, data in cases.items():
                started = time.monotonic()
                result = call(computer, name, **data)
                assert not result.get("is_error"), result
                if name in {"hold_key", "wait"}:
                    assert time.monotonic() - started >= 1
                if name == "screenshot":
                    image = next(block for block in result["content"] if block["type"] == "image")
                    assert base64.b64decode(image["source"]["data"]).startswith(b"\x89PNG\r\n\x1a\n")
                print(f"PASS computer.{name}")
            for name, data in [
                ("hold_key", {"text": "shift", "duration": 31}),
                ("wait", {"duration": 31}),
                ("scroll", {"scroll_direction": "down", "scroll_amount": 51}),
                ("scroll", {"scroll_direction": "down", "scroll_amount": 0}),
                ("key", {"text": "a", "repeat": 101}),
                ("left_click", {"coordinate": [1280, 0]}),
                ("key", {"text": "a;reboot"}),
                ("zoom", {"region": [0, 0, 100, 100]}),
            ]:
                assert call(computer, name, **data).get("is_error"), (name, data)
                print(f"PASS computer.{name} refuses {data}")
        assert desktop.is_running(), "Closing the borrowed toolset must preserve its desktop"
    finally:
        desktop.kill()
        assert not desktop.is_running(), "Desktop cleanup failed"


if __name__ == "__main__":
    main()
