---
"@e2b/claude-toolsets": patch
"@e2b/claude-toolsets-python": patch
---

Build the shared browser runtime with Bun 1.4.4, which includes certificate-trust fixes for the eMudhra intermediate CA compromise. This updates the build and release toolchain; it does not update certificate stores in users' Python, Node.js, or operating-system installations.
