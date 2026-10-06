# E2B Claude Toolsets for Python

Synchronous and native asyncio browser and computer drivers for Anthropic toolsets, on the standard E2B desktop. Both browser drivers implement all 31 browser actions; the four optional actions stay disabled by default. Both computer drivers implement 16 actions; computer zoom is unavailable.

## Development

Developing from Git requires Python 3.10+, uv, pnpm and Bun 1.3.14; see the [repo README](../../README.md#development).

```sh
pnpm install                      # repo root: JS dependencies and the browser runtime
cd packages/claude-toolsets-python
uv sync --python 3.10
uv run python -m unittest discover -s tests -v
uv run ruff check
uv run ruff format --check
uv run ty check
uv build
```

The Python build hook generates runtime assets from a Git checkout and includes them in both the wheel and sdist. Installing either built archive does not require Bun or Node.

The tests use the Anthropic SDK, local protocol fixtures and mocked E2B calls. They never create sandboxes or call a model. The protocol fixture does not execute DOM scripts. Run `pnpm setup:browsers` and `pnpm test:runtime` to execute both bridges against real local Chromium fixtures. Live E2B/model validation remains a separate step.

## Examples

These commands create billable resources. They are manual examples, not offline tests. Set `E2B_API_KEY`; model examples also require `ANTHROPIC_API_KEY`. Set `ANTHROPIC_MODEL` to a model available to your account (the reference default is `claude-sonnet-5-5`). CLI login alone does not supply SDK credentials.

Run them from the repo root with this package's environment; the live tests run from this folder.

```sh
uv run --project packages/claude-toolsets-python python examples/1-run.py "Read the latest E2B release"
uv run --project packages/claude-toolsets-python python examples/4-computer.py "Open a text editor and write a short note"
uv run --project packages/claude-toolsets-python python examples/2-exercise.py
uv run --project packages/claude-toolsets-python python examples/5-async-run.py
uv run --project packages/claude-toolsets-python python examples/5-async-run.py --computer
uv run --project packages/claude-toolsets-python python examples/6-async-exercise.py
cd packages/claude-toolsets-python
uv run python tests/live/detach.py  # requires a snapshot-capable template; optional TEMPLATE override
uv run python tests/live/lifecycle.py  # injected cleanup/interception failures; no model
uv run python tests/live/computer.py  # all computer actions and input refusals; no model
```

The exercise creates one desktop and a local HTML fixture, calls all 31 browser and 16 computer members through SDK dispatch, and cleans up the desktop. It uses no model API. An acknowledgment proves dispatch completed; only its explicit assertions check page behavior. The async exercise checks the form/upload/diagnostic workflow, native desktop text and screenshots, cancellation recovery and detach/reattach. It is a focused behavior check; the sync exercise dispatches every implemented action. The examples use a 600-second sandbox lifetime and explicit cleanup. Use a fresh, exclusive desktop for live view.

## API and ownership

```python
from e2b_claude_toolsets import E2BBrowserToolset, E2BComputerToolset, allow_hosts, live_view

with E2BBrowserToolset.create(allow_out=["example.com"], url_policy=allow_hosts(["example.com"])) as browser:
    # Pass browser directly in Anthropic().beta.messages.tool_runner(tools=[browser], ...).
    # The toolset owns this sandbox. Exiting closes Chrome and kills the sandbox.
    sandbox = browser.sandbox
```

`E2BBrowserToolset.create(sandbox=desktop, ...)` borrows the sandbox. On an `e2b_desktop` sandbox Chrome opens visibly on its screen, so it shows in the live view; pass `headless=True` to hide it, or `display=":1"` for another screen. An `AsyncSandbox` from `AsyncSandbox.connect()` carries no screen information, so pass `display=":0"` there to show Chrome on the desktop. It stops only Chrome it started, removes its own temporary directory, and closes its CDP connection. A pre-existing Chrome process stays running. Attach to one Chrome session exclusively; its caller remains responsible for the profile, egress and sandbox lifetime. When creating a sandbox, options include `api_key`, `template` (default `desktop`), `timeout` in seconds, `allow_out`, and `metadata`. Attached sandboxes must already have `allow_public_traffic=False` and `mask_request_host="localhost:${PORT}"`; creation-only options are refused when attaching.

`E2BComputerToolset.create(desktop, confirm=...)` borrows the desktop. It uses native screenshots/text and validated xdotool input. The SDK requires confirmation while `type`, `key` or `hold_key` is enabled. The computer example explicitly approves unattended input; an application should provide its intended approval behavior.

Sync and async toolsets preserve SDK `configs`, `confirm` and `tool_configs`; browser additionally accepts `url_policy` and `file_policy`. Omitted URL policy and explicit `None` have different SDK semantics. Unimplemented members are disabled by the SDK. The SDK owns input parsing, confirmation, action serialization and tool-result rendering. A toolset can serve multiple runner invocations; runners never close it. Use context managers or `finally: toolset.close()`.

`close()` marks a toolset closed, waits for accepted calls, then releases resources. Failed release keeps its resource record for retry. Startup failures clean up partial resources; `BrowserInitializationError.close()` and `ViewerInitializationError.view.stop()` allow retry after failed startup cleanup. Lost connections or expired sandboxes produce errors; sessions are never silently replaced and state-changing actions are never automatically replayed. A command timeout leaves the remote outcome uncertain. Sync interruption does not prove an already submitted remote operation stopped. On unexpected CDP loss, a separate cleanup thread attempts to stop Chrome started by this toolset through E2B's command API; the sandbox stays available until `close()`. A failed stop is reported and can be retried. Caller-owned Chrome stays running and its URL policy is no longer enforced after disconnection.

`live_view(desktop)` returns a context manager with `.url` and `.stop()`. It binds to loopback, uses a random capability path, validates host/origin, and proxies HTTP and WebSocket traffic with the traffic token kept in Python. Bodies and queues are bounded. Stopping closes local connections and the VNC stream it started; it never kills the desktop. Existing VNC streams are refused because Desktop SDK stream teardown is sandbox-wide. If stream teardown fails, retry `stop()`. Do not share the capability URL.

## Async usage

```python
from anthropic import AsyncAnthropic
from e2b_claude_toolsets import AsyncE2BBrowserToolset, allow_hosts

async def browse():
    async with await AsyncE2BBrowserToolset.create(
        allow_out=["example.com"], url_policy=allow_hosts(["example.com"]),
    ) as browser, AsyncAnthropic() as client:
        return await client.beta.messages.tool_runner(
            model="claude-sonnet-5-5", max_tokens=1024, tools=[browser],
            messages=[{"role": "user", "content": "Read https://example.com"}],
        ).until_done()
```

Use `await AsyncE2BBrowserToolset.create(...)` for asynchronous initialization, `await close()` and `await detach()`. It accepts the same options as the sync browser but requires `e2b.AsyncSandbox` when borrowing. URL policies and confirmation hooks can be plain or async callables. CDP, sandbox operations and waits use native async I/O; remote drivers are not sync calls wrapped in executor threads. Only bounded reads of host upload files use a thread to avoid blocking the event loop.

`await AsyncE2BComputerToolset.create(desktop, confirm=...)` borrows an `e2b.AsyncSandbox` with a running desktop, `DISPLAY=:0` and a fixed screen size. Desktop SDK 2.6.0 supplies only sync desktop startup/screenshot helpers. The async driver uses native async E2B commands/files for X11 input and screenshots. `examples/5-async-run.py --computer` boots the desktop with the sync helper before starting the event loop, then connects with `AsyncSandbox`; startup and final sandbox deletion stay outside that loop. It does not present a sync helper as an async API. `live_view` also remains a sync Desktop SDK helper; manage it outside the event loop if combining it with async actions.

Calls on one toolset are serialized by Anthropic SDK to preserve browser/desktop state; independent toolsets can overlap I/O in one event loop. Cancellation exits waits promptly and finishes key/button release before returning. An in-flight desktop input command is awaited up to its command timeout before release; local cancellation cannot establish that remote work stopped. Accepted actions are drained by `close()`, and cleanup completes even if the caller is cancelled again. Never automatically retry a state-changing operation after an uncertain outcome.

## Optional browser actions

```python
from anthropic.tools.browser import BetaLocalFilePolicy
from e2b_claude_toolsets import E2BBrowserToolset, UploadFile

with E2BBrowserToolset.create(
    configs={name: {"enabled": True} for name in (
        "file_upload", "javascript_exec", "read_console", "read_network",
    )},
    confirm=lambda context: True,  # explicitly approves unattended execution in this demo
    file_policy=BetaLocalFilePolicy(upload_document_ids=["report"]),
    upload_documents={"report": UploadFile("report.txt", b"Hello")},
) as browser:
    pass  # Hand browser to the runner; document_ids=["report"] uploads this file.
```

The same configuration works on `AsyncE2BBrowserToolset.create`. The SDK validates file policy and asks for confirmation before upload or JavaScript execution. An application should provide its intended approval behavior. Host-path uploads require an explicitly allowed absolute path under `BetaLocalFilePolicy(upload_roots=[...])`; document IDs refer only to caller-provided `UploadFile` objects. Approved host files are opened without following the final symlink and their identity is checked again while reading. Files are bounded to 20 items/10 MiB per call and 50 MiB/100 staging directories per toolset. Staging stays until close after file selection because the page may read the bytes later; cleanup failure remains retryable. A timed-out or cancelled selection may have succeeded and is never repeated automatically.

`javascript_exec` evaluates in the page's main world and awaits promises; text is capped at 50,000 characters. Console and network readers consume the latest 100 records per tab since their last read. They may omit older/flooded diagnostics; network records include available status, duration and failure information, not response bodies. Page script execution has the page's authority and is not a trusted host-code executor. Upload path checks currently use POSIX file-open protections.

## Detach before pause or fork

`detach()` / `await detach()` drains accepted calls, releases input, resolves queued interception commands, disables interception/auto-attach and closes CDP. It preserves the sandbox, Chrome, tabs, cookies and page state. Chrome/profile/download-directory ownership transfers to the caller; `close()` on the detached toolset is a no-op. A new toolset can attach to that Chrome. Give the model fresh browser state and references after attachment; old toolset refs/tab IDs are not a cross-instance identity contract.

Detach requires a borrowed sandbox, no active downloads and no staged uploads. Failed detach keeps cleanup handles so it can be retried or closed. Use `close()` when staged files are present. While detached, the toolset no longer applies URL policy; sandbox egress remains active. Pause/fork needs an E2B template with envd 0.5.0 or newer. Detach before taking a snapshot to avoid carrying paused Fetch requests into the resumed browser. Snapshot support is a template prerequisite, not a toolset guarantee.

## Member coverage

| Driver | Implemented |
| --- | --- |
| Browser: navigation/capture | `navigate` (URL, back, forward, reload), `screenshot`, `zoom` |
| Browser: mouse | `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `hover`, `left_click_drag`, `left_mouse_down`, `left_mouse_up`, `mouse_move`, `scroll`, `scroll_to` |
| Browser: input/reading | `type`, `key`, `hold_key`, `form_input`, `read_page`, `find`, `get_page_text`, `wait` |
| Browser: optional | `file_upload`, `javascript_exec`, `read_console`, `read_network` (explicit opt-in) |
| Browser: tabs | `new_tab`, `list_tabs`, `switch_tab`, `close_tab` |
| Computer | `screenshot`, `cursor_position`, `mouse_move`, `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `left_mouse_down`, `left_mouse_up`, `left_click_drag`, `scroll`, `key`, `hold_key`, `type`, `wait` |

## Boundaries and limits

- Browser viewport and computer screen: at least 200 a side and at most 2560×1440 pixels in total (larger screenshots are shrunk by the API and clicks miss), default 1280×800. Keep the desktop resolution fixed. Images are not resized. Coordinates are screenshot pixels; browser zoom returns a cropped/scaled region within the viewport size.
- Wait/hold operations are limited to 30 seconds. Computer and browser key repeats are limited to 100. Computer scroll accepts integers from 1 through 50 and refuses larger values before input; values are never silently rounded or capped. Browser scroll uses 1–10 wheel ticks. Input assumes a US keyboard layout.
- Browser DOM operations use the shared generated runtime from `packages/claude-toolsets-runtime/`, installed idempotently in an isolated world with JSON-encoded arguments. References are unique across documents/tabs and stale refs are refused. Cross-origin iframe contents and transformed iframe coordinates remain limitations. Dedicated workers are resumed and detached because their CDP targets do not support Fetch interception; URL-policy coverage of worker-originated requests is not guaranteed. Page text/images/titles are untrusted model input.
- Private CDP access, a fresh profile and scrubbed Chrome environment apply when the driver starts Chrome. Renderer sandboxing stays enabled. Egress is fixed at sandbox creation: a URL policy does not configure network egress.
- `allow_hosts` permits HTTP(S) hosts/subdomains and optional ports. Documents, redirects and selected local requests are intercepted; reserved local control ports are refused. This sample policy is not a DNS firewall. DNS aliases/rebinding and browser-internal/history edge cases need security review before sensitive browsing. Use restrictive sandbox egress too.
- Command replies and registered events have bounded storage. Interception decisions pipeline up to 96 pending commands, reserving capacity for actions and target setup; replies and 30-second timeouts are still checked. Errors for already canceled requests or vanished dialogs/targets are tolerated; unexpected errors or overflow of essential events close the connection and trigger the owned-Chrome stop attempt described above. Keep URL-policy callbacks fast. The latest 256 browser-state notifications and 100 download records are retained; older notifications/tracking records may be omitted under floods, but interception decisions are never dropped. Input sends use acknowledged round trips in both drivers. Optional console/network events have a 32-event queue budget so diagnostic floods leave room for URL protection; they may be dropped under pressure; these readers are bounded diagnostics, not complete audit logs.
- Downloads stay in the sandbox; the SDK controls whether their paths are disclosed. No download bytes are automatically added to the conversation or executed.
- If a borrowed Chrome disconnects with input held, release cannot be confirmed. Cleanup still releases independent local resources and reports that uncertainty instead of killing a caller-owned process or claiming success; release input manually or retry while the connection is usable.
