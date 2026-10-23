---
"@e2b/claude-toolsets": patch
"@e2b/claude-toolsets-python": patch
---

Lock certifi 2026.10.19 in the Python package's development and build environment, the release that drops the compromised eMudhra intermediates. This updates the locked build and test environment; installed packages still use whatever certifi and certificate stores the user's environment provides.
