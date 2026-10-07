---
'@e2b/claude-toolsets': patch
'@e2b/claude-toolsets-python': patch
---

Depend on the published Claude SDKs with the toolset helpers: `@anthropic-ai/sdk` 0.132.0 or later (npm peer dependency) and `anthropic` 1.12.0 or later (PyPI). 0.0.1 pinned the Python package to `anthropic==1.9.0`, which has no toolset helpers on PyPI.
