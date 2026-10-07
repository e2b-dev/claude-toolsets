# Shared browser runtime

The TypeScript and Python drivers ship the same generated JavaScript. Edit `src/`
here, then run `pnpm build:runtime` from the repo root. Both output directories are gitignored; never edit either generated copy.

```text
packages/claude-toolsets-runtime/src/   typed DOM implementation and operation contract
          |
       Bun build             pinned to 1.3.14; no SDK imports
          |
          +--> packages/claude-toolsets-js/src/generated/runtime.js
          |    manifest.json + runtime-contract.ts
          |
          +--> packages/claude-toolsets-python/e2b_claude_toolsets/_runtime/runtime.js
               manifest.json
```

Both adapters install the bundle once through CDP `Runtime.evaluate` in an isolated
world, then send small JSON operation requests with `awaitPromise: true`.
Only a successful installation is cached. Navigation or context destruction
invalidates it; a generation counter also rejects installations whose context
changes while CDP replies are pending. Failed operations are never replayed.
Navigation creates a new context and reference store.

The host owns the CDP connection, tab lifecycle, confirmation, policies, screenshots,
native input, and uploads. The runtime owns DOM reading, reference lookup,
visibility/hit testing, and form interaction. Existing limitations for cross-origin
frames and transformed iframe coordinates remain; this refactor does not expand
frame support.

## Contract and reference lifetime

`src/contract.ts` defines the closed operation set and plain argument/result types.
The dispatcher returns either `{ok: true, value, nextRef}` or
`{ok: false, error: {code, message}, nextRef}`. Unexpected exceptions return a
sanitized message. Expected errors preserve actionable explanations.

Before sending a call, the host reserves a disjoint block of one million reference
numbers and passes its start as `base`. That block is consumed even if transport
fails, the response is lost, or the envelope is invalid. The runtime cannot allocate
past the block boundary, so another tab cannot reuse numbers allocated by a call
whose result never reached the host. Existing element references remain stable.
The result still reports `nextRef` for validation and diagnostics, but it does not
control future reservations.

Detached elements and references from a replaced document are refused. The SDK
serializes actions; the host must preserve that serialization across tabs.

The TypeScript upload bridge is the one remote-object exception: it unwraps
`file_input` to a DOM node for CDP to pin before staging bytes. It does not allocate
new references. Before assigning files, the host revalidates the pinned node through
the same runtime operation, including composed-tree disabled/inert checks. Python still leaves uploads disabled.

A lost execution context or uncertain action result is returned to the caller;
actions are not automatically replayed.

## Build and test

```sh
pnpm build:runtime
pnpm check:runtime
pnpm setup:browsers
pnpm test:runtime
pnpm test:py
cd packages/claude-toolsets-python && uv build
```

Browser tests run the expressions produced by both real bridges in Chromium
against local HTML fixtures. The Python expression helper loads only `_scripts.py`
and needs Python 3.10+, without importing the Anthropic SDK. Set `PYTHON` if that
interpreter is not `python3`. Adapter tests separately use the actual Anthropic SDK
and local protocol fixtures. These tests create no E2B sandboxes or model calls.

Quality tooling applies to handwritten source, not generated bundles:

```sh
pnpm fmt:runtime   # ESLint fixes and Prettier formatting
pnpm fmt:py        # Ruff fixes and formatting
pnpm build:runtime
pnpm check         # lint, format, types, asset drift, Python, Markdown
pnpm test:all      # offline suites plus local Chromium/protocol tests
```

ESLint checks the runtime and TypeScript bridge for unused code, unhandled
promises, mixed declarations, loose equality, and missing braces. Prettier owns
formatting; strict TypeScript checks DOM types and unused declarations. Python
uses Ruff and ty. These checks keep the runtime readable as ordinary source
modules; Python contains only the JSON bridge, not JavaScript fragments.

Generated assets are local build output, not committed source. `pnpm install`
builds them (the root `prepare` script); `pnpm check`, `pnpm test:runtime`, and
`pnpm test:all` also build before using them. `check:runtime` rebuilds in memory
and checks existing outputs for drift. Manifests include the runtime version,
global key, SHA-256, and bundler version.

Packaging generates the assets before collecting files. The root `prepare` script
builds the runtime, and the `files` allowlist of `@e2b/claude-toolsets` includes
`src/`, so the generated copy ships in the npm package.

The Python Hatch hook builds from Git using Bun 1.3.14 and installed JS dependencies,
then explicitly includes ignored assets and licenses in the wheel and sdist.
Building a wheel from that sdist uses its bundled assets and verifies the checksum;
it does not require Bun or Node. A missing bundle fails packaging rather than
producing an unusable package.

## Live verification

These commands create billable E2B desktops. The model checks also call Anthropic.
Configure `E2B_API_KEY` and `ANTHROPIC_API_KEY` in the process environment.
`ANTHROPIC_MODEL` can override the model used by the two model checks.

```sh
pnpm -F @e2b/claude-toolsets exercise
uv run --project packages/claude-toolsets-python python examples/2-exercise.py
pnpm -F @e2b/claude-toolsets test:live:computer
pnpm -F @e2b/claude-toolsets-python test:live:tabs
pnpm -F @e2b/claude-toolsets test:live
pnpm -F @e2b/claude-toolsets-python test:live
```

The exercises cover supported tool members without a model. The tab stress test
runs 100 create/read/close cycles. The model checks
verify a form submission through browser tools, a file written through desktop
keyboard interaction, and a real noVNC framebuffer in local Chromium. Python's
viewer check also needs Bun and Playwright. Each script kills its disposable
desktop in a `finally` block; tab and computer checks additionally confirm that
the desktop stopped. Live tests are deliberately separate from the default suite.

## Splitting the repositories later

Keep source ownership in one repository. Publish the built JavaScript, manifest,
and contract as an immutable artifact; update each SDK through an explicit pinned
upgrade. Preserve the same checksum in both packages when they adopt the same
runtime. Bump the runtime version and its global key before distributing changed
runtime behavior. The embedded adapter and asset ship together, so there is no
separate negotiated protocol version yet.

A dedicated runtime repository or generated language bindings can follow if
ownership or contract maintenance warrants it. Consumers must never download
runtime code when an application starts.

## Element search

`find` uses pinned Fuse.js 7.5.0, bundled into both SDKs with its license.
It runs locally in the browser: no model calls, network service, or extra Python
runtime dependency. Fuse handles token matching, typo tolerance, and ranking over
accessible names, roles, and nonsecret attributes. We retain a small stop-word
filter, candidate extraction, result deduplication, and a 20-result cap.
All remaining query words must match. Custom role synonyms and viewport bonuses
are removed, so ordering and synonym-only queries can differ from earlier versions.
The library increases generated bundle size while reducing handwritten search code.

## Alternative browser implementations

The injected runtime is DOM-only JavaScript. Playwright, Stagehand, and e2e's web
engine are host-side libraries and cannot be loaded as replacement runtime bundles.
A different executor belongs behind Anthropic's browser toolset interface; it must
own its references, action semantics, and lifecycle while preserving confirmations
and policies. The existing SDK abstract browser toolset already provides that
extension point; this package does not currently expose a runtime-provider option.

Playwright MCP is a candidate backend, with result/schema translation and secret
masking still required. Stagehand's deterministic APIs are usable without a model;
its natural-language methods may invoke one. TesterArmy e2e supports remote CDP
browsers through its Playwright web engine and can be used as a separate test runner.
These integrations have not been implemented or end-to-end validated here.

## Responsibilities kept simple

Anthropic's SDK owns dispatch, call serialization, confirmation, callbacks, and
result orchestration. The drivers retain checks that depend on browser state or
transport: URL interception, viewport bounds, context lifetime, and runtime result
validation. Those checks are not replacements for the SDK's tool validation.

`read_page` and `find` already share `tree.ts` extraction, accessible names/states,
secret filtering, `lineOf` formatting, and the same `ReferenceStore`. They rebuild
the tree for each observation so DOM changes are visible immediately; only the
runtime installation and element references persist. Rendering and search remain
separate consumers of that tree. No second page model or plugin registry is needed.
