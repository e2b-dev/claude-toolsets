# Examples: the package API

What a customer writes with `@e2b/claude-toolsets` (npm) and `e2b-claude-toolsets` (PyPI). The packages themselves live in [`../packages`](../packages).

Same layout as Anthropic's browser-toolset quickstart, with the browser in an E2B sandbox instead of on your machine:

| File | What it is |
| --- | --- |
| [`1-run.ts`](1-run.ts) | **Hello world.** Claude does a task in Chrome on an E2B desktop; the live view opens in your browser so you can watch. Start here. |
| [`1-run.py`](1-run.py) | Python browser example using the sync driver and private live view. See [Python installation](../packages/claude-toolsets-python/README.md). |
| [`2-exercise.ts`](2-exercise.ts) | The toolset without a model: the calls a model would send, checked. A smoke test that needs no Anthropic key. |
| [`2-exercise.py`](2-exercise.py) | Python live exercise: all 31 browser and 16 computer members without a model, with sandbox cleanup. |
| [`3-advanced.ts`](3-advanced.ts) | SDK options pass through: `javascript_exec` enabled, with the `confirm: () => true` the SDK requires for unattended runs. |
| [`4-computer.ts`](4-computer.ts) | **Computer use.** Claude works the whole desktop through screenshots, mouse and keyboard (`E2BComputerToolset`): it opens a terminal, clones E2B's infra repo into a folder on the Desktop, and shows it in the file manager while you watch live. |
| [`4-computer.py`](4-computer.py) | Python computer example using screenshots, mouse and keyboard on a private desktop. |
| [`5-async-run.py`](5-async-run.py) | Python async: the same browser and computer tasks with `AsyncE2BBrowserToolset` / `AsyncE2BComputerToolset`. |
| [`6-async-exercise.py`](6-async-exercise.py) | Python async live exercise without a model. |
| [`tui.ts`](tui.ts) | Helper, not an example: the terminal output, injected with `tui.trace(browser)` and `tui.done(answer)` so the examples stay plain package usage. |

```sh
pnpm example                                                        # E2B's GitHub stars + latest release
pnpm example "Find the most starred repo in github.com/e2b-dev"     # the whole command line is the task
pnpm example:exercise                                               # no model
pnpm example:advanced                                               # javascript_exec
pnpm example:computer                                               # computer use: clone infra onto the Desktop
```

Every example imports `@e2b/claude-toolsets`, exactly as a customer will. It is not published yet: the root `package.json` depends on it as `workspace:*`, so pnpm links [`packages/claude-toolsets-js`](../packages/claude-toolsets-js) into `node_modules` and Bun runs its TypeScript source. Once the package ships, nothing in the examples changes. The Anthropic SDK is imported as `@anthropic-ai/sdk`, but `package.json` resolves that name to the vendored early-access build in `../vendor`: the npm release does not have the toolset helpers yet. Copying an example into another project needs that tarball too, until the release.

`1-run.ts`, `3-advanced.ts` and `4-computer.ts` need `ANTHROPIC_API_KEY` and `E2B_API_KEY` in `.env` at the repo root; `2-exercise.ts` needs only `E2B_API_KEY`. The Python examples run with the Python package's environment: `uv run --project packages/claude-toolsets-python python examples/1-run.py`.

## Names

| | npm | PyPI (import) |
| --- | --- | --- |
| This package | `@e2b/claude-toolsets` | `e2b-claude-toolsets` (`e2b_claude_toolsets`) |
| E2B precedent | `@e2b/desktop`, `@e2b/code-interpreter` | `e2b-desktop`, `e2b-code-interpreter` |

Anthropic's guide recommends no package name. It says the SDK ships the abstract class and third parties ship drivers. "toolsets" in the name, not "browser", leaves room for an `E2BComputerToolset` over the same desktop later (`computer_toolset_20260801`).

## The shape follows Anthropic's guide

- **The driver instance is the `tools[]` entry.** No wrapper, no factory for the runner: `tools: [browser]`.
- **The customer closes it.** The tool runner never closes a toolset. TypeScript: `try/finally` + `close()`. Python: `with` / `async with`.
- **SDK options pass through unchanged**: `urlPolicy`, `configs`, `filePolicy`, `confirm`. Only E2B's own options are added: `allowOut`, `sandbox`, `headless`, `display`, `template`, `timeoutMs`, `uploadDocuments`. On a desktop sandbox Chrome is visible by default; `headless: true` hides it.
- **Sync and async in Python**, as in the SDK and E2B: `E2BBrowserToolset.create(...)` and `await AsyncE2BBrowserToolset.create(...)` (the computer toolsets likewise). See [Python](../packages/claude-toolsets-python/README.md).
- **Screens up to 2560x1440 pixels in total** (browser viewport and desktop resolution), in both languages. Above that the API shrinks screenshots and clicks miss; larger sizes are refused. 1280x800 keeps each screenshot near 1,400 tokens.
- **Two layers of network control.** `allowOut` is E2B's egress firewall, enforced outside the browser; `urlPolicy` is the SDK's check on what the model asks for. The guide's "hosted browsers" section says to keep both.
