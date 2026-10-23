# @e2b/claude-toolsets-python

## 0.0.4

### Patch Changes

- 5acb53d: Lock certifi 2026.10.19 in the Python package's development and build environment, the release that drops the compromised eMudhra intermediates. This updates the locked build and test environment; installed packages still use whatever certifi and certificate stores the user's environment provides.

## 0.0.3

### Patch Changes

- d3cfdc3: Build the shared browser runtime with Bun 1.4.4, which includes certificate-trust fixes for the eMudhra intermediate CA compromise. This updates the build and release toolchain; it does not update certificate stores in users' Python, Node.js, or operating-system installations.

## 0.0.2

### Patch Changes

- 2764eb7: Depend on the published Claude SDKs with the toolset helpers: `@anthropic-ai/sdk` 0.132.0 or later (npm peer dependency) and `anthropic` 1.12.0 or later (PyPI). 0.0.1 pinned the Python package to `anthropic==1.9.0`, which has no toolset helpers on PyPI.
- 5433101: The Python live view sends `Connection: close` on its plain HTTP responses. The server closes the socket after each one, and without the header a client could reuse that closed socket and fail the next request.
