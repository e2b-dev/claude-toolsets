# Claude Toolsets - E2B

*Pre-release: built for the browser and computer use helpers coming to the Claude SDKs. Usage docs land with that release.*

Run Claude's browser use and computer use on [E2B](https://e2b.dev) sandboxes instead of your own machine. Each sandbox is an isolated cloud Linux desktop with Chrome, and you can watch it live while Claude works. Available for TypeScript and Python.

| | Package | Registry |
| --- | --- | --- |
| TypeScript | `@e2b/claude-toolsets` | [npm](https://www.npmjs.com/package/@e2b/claude-toolsets) |
| Python | `e2b-claude-toolsets` | PyPI (with the first release) |

## Setup

```bash
npm i @e2b/claude-toolsets @anthropic-ai/sdk
# or
pip install e2b-claude-toolsets anthropic
```

Set `E2B_API_KEY` ([get one](https://e2b.dev/dashboard)) and `ANTHROPIC_API_KEY`.

## Usage

<!-- TODO(SDK release): TypeScript and Python quickstarts for browser and computer use, once the Claude SDK helpers are public. -->

Coming with the Claude SDK release.

## Good to know

- Runs on the standard E2B desktop sandbox: nothing to build or configure first.
- The sandbox stays private. Its ports are not exposed; the live view is proxied through your machine on a random local URL, so only you can watch.
- Two layers of network control: an egress allowlist that E2B enforces outside the browser, and a host allowlist checked before every navigation. Use both.
- Screens up to 2560×1440 pixels in total (default 1280×800); larger sizes are refused rather than silently scaled.
- You close what you create: a sandbox the driver created is killed on close, one you pass in keeps running.
- Python has both sync and native asyncio drivers.

## Examples

- [`1-run.ts`](https://github.com/e2b-dev/claude-toolsets/blob/main/examples/1-run.ts) / [`1-run.py`](https://github.com/e2b-dev/claude-toolsets/blob/main/examples/1-run.py): Claude drives Chrome on an E2B desktop while you watch live
- [`2-exercise.ts`](https://github.com/e2b-dev/claude-toolsets/blob/main/examples/2-exercise.ts) / [`2-exercise.py`](https://github.com/e2b-dev/claude-toolsets/blob/main/examples/2-exercise.py): no model, just E2B: a smoke test of the package
- [`3-advanced.ts`](https://github.com/e2b-dev/claude-toolsets/blob/main/examples/3-advanced.ts): SDK options passed through unchanged
- [`4-computer.ts`](https://github.com/e2b-dev/claude-toolsets/blob/main/examples/4-computer.ts) / [`4-computer.py`](https://github.com/e2b-dev/claude-toolsets/blob/main/examples/4-computer.py): computer use, Claude works the whole desktop (a terminal, then the file manager)
- [`5-async-run.py`](https://github.com/e2b-dev/claude-toolsets/blob/main/examples/5-async-run.py) / [`6-async-exercise.py`](https://github.com/e2b-dev/claude-toolsets/blob/main/examples/6-async-exercise.py): the same with Python asyncio

## License

[Apache-2.0](https://github.com/e2b-dev/claude-toolsets/blob/main/LICENSE)
