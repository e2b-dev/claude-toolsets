# @e2b/claude-toolsets-python

## 0.0.2

### Patch Changes

- 2764eb7: Depend on the published Claude SDKs with the toolset helpers: `@anthropic-ai/sdk` 0.132.0 or later (npm peer dependency) and `anthropic` 1.12.0 or later (PyPI). 0.0.1 pinned the Python package to `anthropic==1.9.0`, which has no toolset helpers on PyPI.
- 5433101: The Python live view sends `Connection: close` on its plain HTTP responses. The server closes the socket after each one, and without the header a client could reuse that closed socket and fail the next request.
