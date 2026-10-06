# E2B Claude Toolsets

E2B drivers for the browser and computer use toolsets in the Claude SDKs. Compatible with Claude.

- npm: `@e2b/claude-toolsets` ([TypeScript guide](packages/claude-toolsets-js/README.md))
- PyPI: `e2b-claude-toolsets` ([Python guide](packages/claude-toolsets-python/README.md))
- [Examples](examples/README.md) for both languages

## Repository structure

```text
e2b-dev/claude-toolsets/
├── packages/
│   ├── claude-toolsets-runtime/      # private: shared page-side bundle, built into both packages
│   │   ├── src/
│   │   ├── tests/                    # both language bridges against local Chromium
│   │   └── build.ts
│   ├── claude-toolsets-js/           # npm: @e2b/claude-toolsets
│   │   ├── src/
│   │   └── tests/                    # unit tests (*.test.ts), live exercises (*.ts), live/
│   └── claude-toolsets-python/       # PyPI: e2b-claude-toolsets
│       ├── e2b_claude_toolsets/
│       ├── tests/                    # unit tests (test_*.py), live/
│       ├── pyproject.toml
│       └── uv.lock
├── examples/
├── package.json
└── pnpm-workspace.yaml               # packages/*
```

## Development

Requires pnpm 11, Bun 1.3.14 (runtime build and TypeScript tests), uv and Python 3.10+.

```sh
pnpm install           # dependencies, then builds the browser runtime into both packages
pnpm check             # lint, format, types, npm build, runtime drift, Python, Markdown
pnpm build             # npm package: compiled JS + .d.ts in packages/claude-toolsets-js/dist (pack and publish run it too)
pnpm test:all          # TypeScript, runtime (local Chromium: pnpm setup:browsers) and Python unit tests
```

Live checks create billable E2B desktops; the model checks also call Anthropic. Put `E2B_API_KEY` and `ANTHROPIC_API_KEY` in `.env` at the repo root (see `.env.example`):

```sh
pnpm example                                   # TypeScript examples: example, example:exercise, example:advanced, example:computer
pnpm -F @e2b/claude-toolsets exercise          # every browser member, no model; also exercise:computer, :lifecycle, :security, ...
pnpm -F @e2b/claude-toolsets test:live         # model-driven browser and computer checks
pnpm -F @e2b/claude-toolsets-python test:live  # the same from Python
```

## Releasing

Describe each change with `pnpm changeset` and commit the file with it. After merging, run `gh workflow run release.yml --ref main`: it bumps both packages to the same version, publishes `@e2b/claude-toolsets` to npm and `e2b-claude-toolsets` to PyPI over trusted publishing (no tokens), and tags the release on GitHub. Don't run `changeset version` locally; the workflow does.

## Before the SDK release

The toolset helpers are not on npm or PyPI yet, so until they are, the manifests point `@anthropic-ai/sdk` and `anthropic` at local builds in `vendor/` (gitignored). The code already imports the final names, so the swap is one line per language:

1. Check the release has the helpers. npm: `npm pack @anthropic-ai/sdk@<version>` contains `package/helpers/beta/toolsets/`. PyPI: the wheel contains `anthropic/tools/browser.py` and `anthropic/tools/computer.py`.
2. TypeScript: replace both `file:` values of `@anthropic-ai/sdk` (root and `packages/claude-toolsets-js/package.json`) with the version, set the peer range, then `pnpm install` once with the 7-day `minimumReleaseAge` lifted.
3. Python: in `packages/claude-toolsets-python/pyproject.toml` set `anthropic==<version>` and delete `[tool.uv.sources]`, then `uv lock --exclude-newer-package anthropic=<now, RFC 3339>`.
4. Delete this section, then run `pnpm check`, `pnpm test:all` and the live checks.
