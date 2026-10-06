"""LIVE native async exercise, without a model. Creates one billable desktop."""

import asyncio
import base64
import re

from anthropic.tools.browser import BetaLocalFilePolicy
from anthropic.types.beta import BetaToolUseBlock
from e2b import AsyncSandbox
from e2b_desktop import Sandbox as Desktop

from e2b_claude_toolsets import AsyncE2BBrowserToolset, AsyncE2BComputerToolset, UploadFile, allow_hosts


def text(result):
    return "\n".join(block["text"] for block in result["content"] if block["type"] == "text")


async def call(toolset, name, **data):
    result = await toolset.tool_result(
        BetaToolUseBlock(id="async-exercise", type="tool_use", name=name, input=data, toolset_name=toolset.toolset_name)
    )
    assert not result.get("is_error"), f"{name}: {text(result)}"
    if name in {"screenshot", "zoom"}:
        image = next(block for block in result["content"] if block["type"] == "image")
        assert base64.b64decode(image["source"]["data"]).startswith(b"\x89PNG\r\n\x1a\n")
    print(f"PASS async {toolset.toolset_name}.{name}")
    return result


async def find(browser, query):
    match = re.search(r"ref_\d+", text(await call(browser, "find", query=query)))
    assert match, query
    return {"type": "ref", "ref": match.group()}


async def exercise(desktop_id):
    desktop = await AsyncSandbox.connect(desktop_id)
    await desktop.files.make_dir("/tmp/toolset-fixture")
    await desktop.files.write(
        "/tmp/toolset-fixture/index.html",
        """<!doctype html><title>Async fixture</title>
<input aria-label="Message"><input type="file" aria-label="Attachment">
<button onclick="document.querySelector('output').textContent='Submitted: '+document.querySelector('input').value">Submit</button>
<output></output><div style="height:2000px">Scroll fixture</div>""",
    )
    server = await desktop.commands.run(
        "python3 -m http.server 8000 --bind 127.0.0.1 --directory /tmp/toolset-fixture", background=True, timeout=0
    )
    await server.disconnect()
    await desktop.commands.run(
        "for i in $(seq 1 50); do curl -fsS http://localhost:8000/ >/dev/null && exit 0; sleep .1; done; exit 1",
        timeout=10,
    )
    # an AsyncSandbox from connect() carries no screen, so name it: Chrome must be visible for the computer toolset
    options = dict(sandbox=desktop, display=":0", url_policy=allow_hosts(["localhost:8000"]))
    async with await AsyncE2BBrowserToolset.create(
        **options,
        configs={
            name: {"enabled": True} for name in ["file_upload", "javascript_exec", "read_console", "read_network"]
        },
        confirm=lambda _: True,
        file_policy=BetaLocalFilePolicy(upload_document_ids=["fixture"]),
        upload_documents={"fixture": UploadFile("fixture.bin", b"\x00\xffhello")},
    ) as browser:
        await call(browser, "navigate", url="http://localhost:8000/")
        await call(browser, "form_input", target=await find(browser, "Message textbox"), value="ASYNC")
        await call(browser, "left_click", target=await find(browser, "Submit button"))
        assert "Submitted: ASYNC" in text(await call(browser, "get_page_text"))
        await call(
            browser, "file_upload", target=await find(browser, "Attachment file input"), document_ids=["fixture"]
        )
        uploaded = text(
            await call(
                browser,
                "javascript_exec",
                text=(
                    "Array.from(new Uint8Array(await document.querySelector('input[type=file]').files[0].arrayBuffer()))"
                ),
            )
        )
        assert "255" in uploaded and "104" in uploaded
        await call(browser, "javascript_exec", text="console.log('async-exercise'); await fetch('/index.html')")
        assert "async-exercise" in text(await call(browser, "read_console"))
        assert "200" in text(await call(browser, "read_network"))
        await call(browser, "screenshot")
        await call(browser, "zoom", region=[0, 0, 300, 200])
        async with await AsyncE2BComputerToolset.create(desktop, confirm=lambda _: True) as computer:
            await call(browser, "left_click", target=await find(browser, "Message textbox"))
            await call(computer, "key", text="ctrl+a")
            await call(computer, "type", text="COMPUTER")
            assert (
                text(await call(browser, "javascript_exec", text="document.querySelector('input').value")) == "COMPUTER"
            )
            await call(computer, "screenshot")
            pending = asyncio.create_task(call(computer, "hold_key", text="shift", duration=20))
            await asyncio.sleep(1)
            pending.cancel()
            try:
                await pending
            except asyncio.CancelledError:
                pass
            await call(computer, "wait", duration=0)  # The cancelled action leaves the toolset usable.
        try:
            await browser.detach()
        except ValueError:
            pass  # Staged uploads must be cleaned with close(), not transferred by detach().
        else:
            raise AssertionError("Detach accepted staged uploads")
    async with await AsyncE2BBrowserToolset.create(**options) as browser:
        await call(browser, "navigate", url="http://localhost:8000/?before-detach")
        await browser.detach()
    async with await AsyncE2BBrowserToolset.create(**options) as browser:
        await call(browser, "navigate", url="http://localhost:8000/?reattach")
        assert "Scroll fixture" in text(await call(browser, "get_page_text"))


if __name__ == "__main__":
    # Desktop startup is synchronous in SDK 2.6.0 and stays outside the event loop.
    desktop = Desktop.create(
        resolution=(1280, 800),
        timeout=600,
        network={"allow_public_traffic": False, "mask_request_host": "localhost:${PORT}", "deny_out": ["0.0.0.0/0"]},
    )
    try:
        asyncio.run(exercise(desktop.sandbox_id))
    finally:
        desktop.kill()
        print("Desktop cleanup completed")
