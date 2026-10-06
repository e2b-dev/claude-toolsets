"""Manual, billable E2B lifecycle regressions with injected failures; no model."""

import time
from concurrent.futures import Future
from unittest.mock import patch

from anthropic.tools import ToolError
from anthropic.types.beta import BetaToolUseBlock
from e2b_desktop import Sandbox

from e2b_claude_toolsets import E2BBrowserToolset, allow_hosts
from e2b_claude_toolsets._cdp import CdpClient


def call(browser, name, **data):
    result = browser.tool_result(
        BetaToolUseBlock(id="lifecycle-check", type="tool_use", toolset_name="browser", name=name, input=data)
    )
    assert not result.get("is_error"), result
    return "\n".join(block["text"] for block in result["content"] if block["type"] == "text")


def wait_for(predicate):
    deadline = time.monotonic() + 10
    while not predicate() and time.monotonic() < deadline:
        time.sleep(0.1)
    assert predicate(), "The lifecycle condition did not complete within 10 seconds"


def main():
    resources = []

    def desktop():
        value = Sandbox.create(
            resolution=(1280, 800),
            timeout=600,
            network={"allow_public_traffic": False, "mask_request_host": "localhost:${PORT}"},
        )
        resources.append(value)
        return value

    def chromes(value):
        return int(value.commands.run("pgrep -fc -- '[-]-user-data-dir=/tmp/e2b-browser-' || true").stdout.strip())

    try:
        # An owned sandbox remains available for a cleanup retry when its first kill fails.
        browser = E2BBrowserToolset()
        owned = browser.sandbox
        resources.append(owned)
        with patch.object(owned, "kill", side_effect=RuntimeError("injected kill failure")):
            try:
                browser.close()
                raise AssertionError("close must report failed cleanup")
            except RuntimeError as error:
                assert "retry close()" in str(error)
        assert owned.is_running()
        browser.close()
        assert not owned.is_running()
        print("PASS owned cleanup retry")

        borrowed = desktop()
        with patch("e2b_claude_toolsets._browser.CdpClient", side_effect=RuntimeError("injected connect failure")):
            try:
                E2BBrowserToolset(sandbox=borrowed)
                raise AssertionError("Initialization must fail")
            except RuntimeError as error:
                assert "browser connection" in str(error)
        wait_for(lambda: chromes(borrowed) == 0)
        assert borrowed.is_running()
        print("PASS partial startup cleans owned Chrome and preserves borrowed sandbox")

        # A failed iframe Fetch setup must close the target rather than leave an unprotected frame.
        borrowed.files.make_dir("/tmp/toolset-lifecycle")
        borrowed.files.write(
            "/tmp/toolset-lifecycle/outer.html", '<iframe src="http://127.0.0.1:8000/inner.html"></iframe>'
        )
        borrowed.files.write("/tmp/toolset-lifecycle/inner.html", "<p>inner</p>")
        server = borrowed.commands.run(
            "python3 -m http.server 8000 --bind 0.0.0.0 --directory /tmp/toolset-lifecycle", background=True, timeout=0
        )
        server.disconnect()
        borrowed.commands.run(
            "for i in $(seq 1 50); do curl -fsS http://localhost:8000/outer.html >/dev/null && exit 0; sleep .1; done; exit 1",
            timeout=10,
        )
        options = dict(url_policy=allow_hosts(["localhost:8000", "127.0.0.1:8000"]))
        with E2BBrowserToolset(sandbox=borrowed, **options) as browser:
            call(browser, "navigate", url="http://localhost:8000/outer.html")

            def iframes():
                return [t for t in browser._client().send("Target.getTargets")["targetInfos"] if t["type"] == "iframe"]

            wait_for(lambda: bool(iframes()))
        wait_for(lambda: chromes(borrowed) == 0)
        with E2BBrowserToolset(sandbox=borrowed, **options) as browser:
            request = CdpClient.request

            def failed_fetch(client, method, params=None, session=None):
                if method == "Fetch.enable" and session != browser._tab().session:
                    failure = Future()
                    failure.set_exception(ToolError("injected iframe Fetch setup failure"))
                    return -1, failure
                return request(client, method, params, session)

            with patch.object(CdpClient, "request", failed_fetch):
                call(browser, "navigate", url="http://localhost:8000/outer.html")
                # Give the cross-site target time to attach. It stays paused (never runs without interception)
                # rather than closed: closing an iframe target in a visible Chrome closes its tab, and Chrome with it.
                # tests/live/security.py proves it never sends a request.
                time.sleep(1.5)
                assert not browser._client().closed, "the browser connection must survive"
                call(browser, "list_tabs")  # asserts no error: the page and its tab are still there
        print("PASS iframe interception failure keeps the page and Chrome, iframe paused")
        wait_for(lambda: chromes(borrowed) == 0)

        # Borrowed Chrome stays alive, but the borrower must release its held mouse button.
        with E2BBrowserToolset(
            sandbox=borrowed, configs={"javascript_exec": {"enabled": True}}, confirm=lambda _: True
        ) as owner:
            call(owner, "navigate", url="about:blank")
            call(owner, "javascript_exec", text="window.ups=0;addEventListener('mouseup',()=>window.ups++);'ready'")
            with E2BBrowserToolset(sandbox=borrowed) as borrower:
                call(borrower, "left_mouse_down", target={"type": "coordinate", "x": 200, "y": 200})
            assert call(owner, "javascript_exec", text="window.ups").strip() == "1"
        print("PASS borrower releases mouse input")
    finally:
        failed = []
        for resource in resources:
            try:
                resource.kill()
                assert not resource.is_running()
            except Exception:
                failed.append(resource.sandbox_id)
        if failed:
            raise RuntimeError(f"Test cleanup failed; retry kill for sandbox IDs: {failed}")


if __name__ == "__main__":
    main()
