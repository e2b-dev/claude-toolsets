"""Native asyncio CDP: one reader, one bounded event worker, acknowledged event replies."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from anthropic.tools import ToolError
from websockets.asyncio.client import connect

from ._cdp import _LOG, DIAGNOSTIC_QUEUE_BUDGET, CdpProtocolError, diagnostic_event, settle_detached_session


class AsyncCdpClient:
    @classmethod
    async def connect(cls, url: str, headers: dict[str, str], *, on_disconnect=None):
        try:
            socket = await connect(
                url,
                additional_headers=headers,
                proxy=None,
                compression=None,
                open_timeout=20,
                close_timeout=2,
                max_size=16 * 1024 * 1024,
                max_queue=16,
                logger=_LOG,
            )
        except Exception:
            raise ToolError("Could not connect to the browser") from None
        return cls(socket, on_disconnect)

    def __init__(self, socket, on_disconnect):
        self._socket = socket
        self._send_lock = asyncio.Lock()
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._commands: dict[int, tuple[str, str | None]] = {}
        self._submitted: dict[int, float] = {}
        self._handlers: dict[str, list] = {}
        self._events: asyncio.Queue = asyncio.Queue(256)
        self._capacity = asyncio.Event()
        self._capacity.set()
        self.closed = False
        self._closing = False
        self.capture_network = False
        self._next_id = 0
        self._on_disconnect = on_disconnect
        self._failure_worker: asyncio.Task | None = None
        self._socket_closer: asyncio.Task | None = None
        self._reader = asyncio.create_task(self._read(), name="e2b-cdp-reader")
        self._worker = asyncio.create_task(self._dispatch(), name="e2b-cdp-events")

    def on(self, method, handler):
        self._handlers.setdefault(method, []).append(handler)

    async def request(self, method, params=None, session=None):
        async with self._send_lock:
            if self.closed:
                raise ToolError("The browser connection is closed")
            if len(self._pending) >= 128:
                raise ToolError("Too many browser commands are pending")
            self._next_id += 1
            ident = self._next_id
            future = asyncio.get_running_loop().create_future()
            future.add_done_callback(lambda reply: None if reply.cancelled() else reply.exception())
            self._pending[ident] = future
            self._commands[ident] = (method, session)
            message = dict(id=ident, method=method, params=params or {})
            if session is not None:
                message["sessionId"] = session
            try:
                await self._socket.send(json.dumps(message))
            except asyncio.CancelledError:
                self._pending.pop(ident, None)
                self._commands.pop(ident, None)
                future.cancel()
                self._capacity.set()
                raise
            except Exception:
                self._fail("The browser connection failed")
            return ident, future

    async def result(self, request, timeout=30):
        ident, future = request
        method = self._commands.get(ident, ("unknown", None))[0]
        try:
            return await asyncio.wait_for(future, timeout)
        except asyncio.TimeoutError:
            raise ToolError(f"Browser command {method} timed out; its remote outcome is unknown") from None
        finally:
            self._pending.pop(ident, None)
            self._submitted.pop(ident, None)
            self._commands.pop(ident, None)
            self._capacity.set()

    async def send(self, method, params=None, session=None, timeout=30):
        return await self.result(await self.request(method, params, session), timeout)

    async def submit(self, method, params, session=None):
        deadline = time.monotonic() + 30
        while len(self._pending) >= 96 and not self.closed:
            self._capacity.clear()
            try:
                await asyncio.wait_for(self._capacity.wait(), max(0, deadline - time.monotonic()))
            except asyncio.TimeoutError:
                raise ToolError("Browser event commands did not complete within 30 seconds") from None
        ident, future = await self.request(method, params, session)
        if ident in self._pending:
            self._submitted[ident] = deadline

        def completed(reply):
            if reply.cancelled():
                return
            try:
                reply.result()
            except CdpProtocolError as error:
                if not error.stale:
                    self._fail("The browser rejected an event command")
            except Exception:
                self._fail("The browser event command failed")

        future.add_done_callback(completed)

    def _fail(self, message):
        first = not self.closed
        self.closed = True
        pending, self._pending = self._pending, {}
        self._submitted.clear()
        self._commands.clear()
        self._capacity.set()
        for future in pending.values():
            if not future.done():
                future.set_exception(ToolError(message))
        if first and not self._closing:
            self._socket_closer = asyncio.create_task(self._socket.close(), name="e2b-cdp-disconnect")
            if self._on_disconnect is not None:
                self._failure_worker = asyncio.create_task(self._on_disconnect(), name="e2b-browser-failure-cleanup")

    async def _read(self):
        try:
            while not self.closed:
                expired = next(
                    (ident for ident, deadline in self._submitted.items() if deadline <= time.monotonic()), None
                )
                if expired is not None:
                    method = self._commands.get(expired, ("unknown", None))[0]
                    raise ToolError(f"Browser event command {method} timed out; its remote outcome is unknown")
                try:
                    raw = await asyncio.wait_for(self._socket.recv(), 0.1)
                except asyncio.TimeoutError:
                    continue
                try:
                    message = json.loads(raw)
                    if not isinstance(message, dict):
                        raise ValueError
                except (ValueError, TypeError):
                    raise ToolError("Invalid browser protocol message") from None
                if "id" in message:
                    future = self._pending.pop(message["id"], None)
                    self._submitted.pop(message["id"], None)
                    self._commands.pop(message["id"], None)
                    self._capacity.set()
                    if future is not None and not future.done():
                        if "error" in message:
                            future.set_exception(CdpProtocolError(message["error"]))
                        else:
                            future.set_result(message.get("result", {}))
                elif "method" in message:
                    if message["method"] == "Target.detachedFromTarget":
                        settle_detached_session(
                            self._pending, self._submitted, self._commands, message.get("params", {}).get("sessionId")
                        )
                        self._capacity.set()
                    if message["method"] not in self._handlers:
                        continue
                    if (
                        message["method"] == "Network.responseReceived"
                        and message.get("params", {}).get("type") != "Document"
                        and not self.capture_network
                    ):
                        continue
                    if diagnostic_event(message) and self._events.qsize() >= DIAGNOSTIC_QUEUE_BUDGET:
                        continue
                    self._events.put_nowait(message)  # Essential overflow fails closed; never drop decisions.
        except ToolError as error:
            self._fail(str(error))
        except Exception:
            self._fail("The browser connection closed or exceeded its event limit")
        finally:
            self._fail("The browser connection is closed")
            await self._socket.close()

    async def _dispatch(self):
        while not self.closed:
            event = await self._events.get()
            try:
                for handler in tuple(self._handlers.get(event["method"], ())):
                    await handler(event.get("params", {}), event.get("sessionId"))
            except Exception:
                self._fail("The browser event handler failed")
            finally:
                self._events.task_done()

    async def drain(self, timeout=5):
        deadline = time.monotonic() + timeout
        try:
            await asyncio.wait_for(self._events.join(), timeout)
            while self._submitted and not self.closed:
                self._capacity.clear()
                await asyncio.wait_for(self._capacity.wait(), max(0, deadline - time.monotonic()))
        except asyncio.TimeoutError:
            raise RuntimeError("Browser events did not settle; retry detach() or close()") from None

    async def close(self):
        self._closing = True
        self._fail("The browser connection is closed")
        await self._socket.close()
        for task in (self._reader, self._worker, self._socket_closer, self._failure_worker):
            if task is None or task is asyncio.current_task():
                continue
            if task is self._worker:
                task.cancel()
            try:
                await asyncio.wait_for(asyncio.shield(task), 30)
            except asyncio.CancelledError:
                if not task.cancelled():
                    raise
            except asyncio.TimeoutError:
                raise RuntimeError("Could not stop the browser connection worker; retry close()") from None
