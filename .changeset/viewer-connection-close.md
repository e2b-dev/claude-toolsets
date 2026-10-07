---
'@e2b/claude-toolsets-python': patch
---

The Python live view sends `Connection: close` on its plain HTTP responses. The server closes the socket after each one, and without the header a client could reuse that closed socket and fail the next request.
