# E2B Claude Toolsets

E2B drivers for the browser and computer use toolsets in the Claude SDKs. Compatible with Claude.

- npm: `@e2b/claude-toolsets`
- PyPI: `e2b-claude-toolsets`

## Repository structure

```
e2b-dev/claude-toolsets/
├── .changeset/
│   └── config.json
├── .github/workflows/
│   ├── claude_toolsets_js_tests.yml
│   ├── claude_toolsets_python_tests.yml
│   ├── release.yml
│   └── publish_packages.yml          # changesets: npm + PyPI, one flow
├── packages/
│   ├── claude-toolsets-runtime/      # private, shared page-side bundle
│   │   ├── src/
│   │   ├── tests/
│   │   └── package.json              # "private": true
│   ├── claude-toolsets-js/           # npm: @e2b/claude-toolsets
│   │   ├── src/
│   │   ├── tests/
│   │   ├── package.json              # repository.directory = packages/claude-toolsets-js
│   │   ├── CHANGELOG.md
│   │   ├── LICENSE
│   │   └── README.md
│   └── claude-toolsets-python/       # PyPI: e2b-claude-toolsets
│       ├── e2b_claude_toolsets/
│       ├── tests/
│       ├── package.json              # private, version + postPublish uv publish
│       ├── pyproject.toml
│       ├── uv.lock
│       ├── Makefile
│       ├── CHANGELOG.md
│       ├── LICENSE
│       └── README.md
├── examples/
├── package.json
├── pnpm-workspace.yaml               # packages/*
├── LICENSE
└── README.md
```
