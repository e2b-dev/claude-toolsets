"""LIVE E2B exercise without a model. Creates one billable desktop; run only when authorized."""

import base64
import re

from anthropic.tools.browser import BetaLocalFilePolicy
from anthropic.types.beta import BetaToolUseBlock
from e2b_desktop import Sandbox

from e2b_claude_toolsets import E2BBrowserToolset, E2BComputerToolset, UploadFile, allow_hosts


def call(toolset, name, **data):
    result = toolset.tool_result(
        BetaToolUseBlock(
            id="exercise",
            type="tool_use",
            name=name,
            input=data,
            toolset_name=toolset.toolset_name,
        )
    )
    assert not result.get("is_error"), f"{name}: {result}"
    if name in {"screenshot", "zoom"}:
        image = next(block for block in result["content"] if block["type"] == "image")
        assert base64.b64decode(image["source"]["data"]).startswith(b"\x89PNG\r\n\x1a\n")
    print(f"PASS {toolset.toolset_name}.{name}")
    return result


def text(result):
    return "\n".join(block["text"] for block in result["content"] if block["type"] == "text")


desktop = Sandbox.create(
    resolution=(1280, 800),
    timeout=600,
    network={
        "allow_public_traffic": False,
        "mask_request_host": "localhost:${PORT}",
        "deny_out": ["0.0.0.0/0"],
    },
)
try:
    desktop.files.make_dir("/tmp/toolset-fixture")
    desktop.files.write(
        "/tmp/toolset-fixture/index.html",
        """<!doctype html><title>Toolset fixture</title>
<input aria-label="Message"><button onclick="document.querySelector('output').textContent='Clicked'">Submit</button>
<input type="file" aria-label="Attachment"><script>console.log("fixture-ready");fetch("/index.html");</script>
<output></output><div style="height:2000px">Scroll fixture</div>""",
    )
    server = desktop.commands.run(
        "python3 -m http.server 8000 --bind 127.0.0.1 --directory /tmp/toolset-fixture", background=True, timeout=0
    )
    server.disconnect()
    desktop.commands.run(
        "for i in $(seq 1 50); do curl -fsS http://127.0.0.1:8000 >/dev/null && exit 0; sleep 0.1; done; exit 1",
        timeout=10,
    )
    with E2BBrowserToolset.create(
        sandbox=desktop,
        url_policy=allow_hosts(["localhost:8000"]),
        confirm=lambda _: True,
        configs={
            name: {"enabled": True} for name in ["file_upload", "javascript_exec", "read_console", "read_network"]
        },
        file_policy=BetaLocalFilePolicy(upload_document_ids=["fixture"]),
        upload_documents={"fixture": UploadFile("fixture.bin", b"\x00\xffhello")},
    ) as browser:
        call(browser, "navigate", url="http://localhost:8000")
        call(browser, "navigate", url="reload")
        call(browser, "read_page", filter="all")
        field = re.search(r"ref_\d+", text(call(browser, "find", query="Message textbox")))
        assert field
        call(browser, "form_input", target={"type": "ref", "ref": field.group()}, value="Hello")
        assert "Hello" in text(call(browser, "read_page", filter="all"))
        button = re.search(r"ref_\d+", text(call(browser, "find", query="Submit button")))
        assert button
        call(browser, "left_click", target={"type": "ref", "ref": button.group()})
        assert "Clicked" in text(call(browser, "get_page_text"))
        attachment = re.search(r"ref_\d+", text(call(browser, "find", query="Attachment file input")))
        assert attachment
        call(browser, "file_upload", target={"type": "ref", "ref": attachment.group()}, document_ids=["fixture"])
        uploaded = text(
            call(
                browser,
                "javascript_exec",
                text=(
                    "Array.from(new Uint8Array(await document.querySelector('input[type=file]').files[0].arrayBuffer()))"
                ),
            )
        )
        assert "255" in uploaded and "104" in uploaded
        call(browser, "javascript_exec", text="console.log('exercise-console'); await fetch('/index.html')")
        assert "exercise-console" in text(call(browser, "read_console"))
        assert "200" in text(call(browser, "read_network"))
        point = {"type": "coordinate", "x": 400, "y": 300}
        for name in [
            "hover",
            "right_click",
            "middle_click",
            "double_click",
            "triple_click",
            "mouse_move",
            "left_mouse_down",
            "left_mouse_up",
        ]:
            call(browser, name, target=point)
        call(browser, "left_click_drag", **{"from": point, "target": {"type": "coordinate", "x": 500, "y": 350}})
        call(browser, "scroll", target=point, scroll_direction="down", scroll_amount=1)
        call(browser, "scroll_to", target={"type": "ref", "ref": field.group()})
        call(browser, "left_click", target={"type": "ref", "ref": field.group()})
        call(browser, "key", text="ctrl+a")
        call(browser, "type", text="Typed")
        call(browser, "hold_key", text="shift", duration=1)
        call(browser, "wait", duration=0)
        call(browser, "screenshot")
        call(browser, "zoom", region=[0, 0, 300, 200])
        call(browser, "list_tabs")
        call(browser, "new_tab")
        state = next(block for block in call(browser, "list_tabs")["content"] if block["type"] == "browser_state")
        tab_ids = [tab["tab_id"] for tab in state["tabs"]]
        call(browser, "switch_tab", tab_id=tab_ids[0])
        call(browser, "close_tab", tab_id=tab_ids[-1])
        call(browser, "navigate", url="about:blank")
        call(browser, "navigate", url="back")
        call(browser, "navigate", url="forward")
    with E2BComputerToolset.create(desktop, confirm=lambda _: True) as computer:
        call(computer, "cursor_position")
        call(computer, "mouse_move", coordinate=[0, 0])
        for name in ["left_click", "right_click", "middle_click", "double_click", "triple_click"]:
            call(computer, name, coordinate=[400, 300])
        call(computer, "left_mouse_down")
        call(computer, "left_mouse_up")
        call(computer, "left_click_drag", start_coordinate=[400, 300], coordinate=[500, 350])
        call(computer, "scroll", scroll_direction="down", scroll_amount=1)
        call(computer, "key", text="Escape")
        call(computer, "hold_key", text="shift", duration=1)
        call(computer, "type", text="E2B exercise")
        call(computer, "wait", duration=0)
        call(computer, "screenshot")
finally:
    desktop.kill()
    print("Desktop cleanup completed")
