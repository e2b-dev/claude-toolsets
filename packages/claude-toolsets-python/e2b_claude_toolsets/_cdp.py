"""One reader owns the socket; an event worker may issue commands without deadlocking it."""

from __future__ import annotations

import json
import logging
import queue
import threading
import time
from concurrent.futures import Future
from concurrent.futures import TimeoutError as FutureTimeout
from typing import Any, Callable

from anthropic.tools import ToolError
from websockets.sync.client import connect

_LOG = logging.getLogger(__name__)
_LOG.addHandler(logging.NullHandler())
_LOG.propagate = False


class CdpProtocolError(ToolError):
    """Classify vanished resources without exposing Chrome's page-controlled error text."""

    def __init__(self, error: dict[str, Any]) -> None:
        super().__init__("The browser rejected the command")
        message = str(error.get("message", "")).lower()
        self.stale = any(
            message.startswith(reason)
            for reason in (
                "invalid interceptionid",
                "no dialog is showing",
                "no session with given id",
                "session with given id not found",
                "no target with given id",
                "target closed",
            )
        )


# Leave queue capacity for paused requests while their replies are in flight.
DIAGNOSTIC_QUEUE_BUDGET = 32


def settle_detached_session(pending, submitted, commands, session):
    """A detached session cannot answer; retire its calls in the reader, not the event worker."""
    if session is None:
        return
    for ident, (_, owner) in list(commands.items()):
        if owner != session:
            continue
        commands.pop(ident)
        submitted.pop(ident, None)
        future = pending.pop(ident, None)
        if future is not None and not future.done():
            future.set_exception(CdpProtocolError({"message": "No session with given id"}))


def diagnostic_event(message):
    method = message["method"]
    return method in {
        "Runtime.consoleAPICalled",
        "Runtime.exceptionThrown",
        "Network.loadingFinished",
        "Network.loadingFailed",
    } or (
        method in {"Network.requestWillBeSent", "Network.responseReceived"}
        and message.get("params", {}).get("type") != "Document"
    )


class CdpClient:
    def __init__(self, url: str, headers: dict[str, str], *, on_disconnect: Callable[[], None] | None = None) -> None:
        try:
            self._socket = connect(
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
        self._lock = threading.RLock()
        self._capacity = threading.Condition(self._lock)
        self._pending: dict[int, Future[Any]] = {}
        self._commands: dict[int, tuple[str, str | None]] = {}
        self._submitted: dict[int, float] = {}
        self._handlers: dict[str, list[Callable[..., None]]] = {}
        self._events: queue.Queue[Any] = queue.Queue(256)
        self._closed = threading.Event()
        self._closing = False
        self._on_disconnect = on_disconnect
        self._failure_worker: threading.Thread | None = None
        self._next_id = 0
        self.capture_network = False
        self._reader = threading.Thread(target=self._read, name="e2b-cdp-reader", daemon=True)
        self._worker = threading.Thread(target=self._dispatch, name="e2b-cdp-events", daemon=True)
        self._reader.start()
        self._worker.start()

    @property
    def closed(self) -> bool:
        return self._closed.is_set()

    def on(self, method: str, handler: Callable[..., None]) -> None:
        with self._lock:
            self._handlers.setdefault(method, []).append(handler)

    def request(
        self, method: str, params: dict[str, Any] | None = None, session: str | None = None
    ) -> tuple[int, Future[Any]]:
        with self._lock:
            if self.closed:
                raise ToolError("The browser connection is closed")
            if len(self._pending) >= 128:
                raise ToolError("Too many browser commands are pending")
            self._next_id += 1
            ident = self._next_id
            future: Future[Any] = Future()
            self._pending[ident] = future
            self._commands[ident] = (method, session)
            message = {"id": ident, "method": method, "params": params or {}}
            if session is not None:
                message["sessionId"] = session
            try:
                self._socket.send(json.dumps(message))
            except Exception:
                self._fail("The browser connection failed")
            return ident, future

    def result(self, request: tuple[int, Future[Any]], timeout: float = 30) -> dict[str, Any]:
        ident, future = request
        with self._lock:
            method = self._commands.get(ident, ("unknown", None))[0]
        try:
            return future.result(timeout)
        except FutureTimeout:
            raise ToolError(f"Browser command {method} timed out; its remote outcome is unknown") from None
        finally:
            with self._lock:
                self._pending.pop(ident, None)
                self._submitted.pop(ident, None)
                self._commands.pop(ident, None)
                self._capacity.notify_all()

    def send(
        self, method: str, params: dict[str, Any] | None = None, session: str | None = None, timeout: float = 30
    ) -> dict[str, Any]:
        return self.result(self.request(method, params, session), timeout)

    def submit(self, method: str, params: dict[str, Any], session: str | None = None) -> None:
        """Pipeline event replies; reserve capacity for foreground commands and target setup."""
        deadline = time.monotonic() + 30
        with self._capacity:
            while len(self._pending) >= 96 and not self.closed:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ToolError("Browser event commands did not complete within 30 seconds")
                self._capacity.wait(remaining)
            ident, future = self.request(method, params, session)
            if ident in self._pending:
                self._submitted[ident] = deadline

        def completed(reply):
            try:
                reply.result()
            except CdpProtocolError as error:
                if not error.stale:
                    self._fail("The browser rejected an event command")
                    self._socket.close()
            except Exception:
                self._fail("The browser event command failed")
                self._socket.close()

        future.add_done_callback(completed)

    def _fail(self, message: str) -> None:
        with self._lock:
            first = not self.closed
            self._closed.set()
            pending, self._pending = self._pending, {}
            self._submitted.clear()
            self._commands.clear()
            self._capacity.notify_all()
            if first and not self._closing and self._on_disconnect is not None:
                # Remote process cleanup must not wait for an event handler or block socket replies.
                self._failure_worker = threading.Thread(
                    target=self._on_disconnect, name="e2b-browser-failure-cleanup", daemon=True
                )
                self._failure_worker.start()
            for future in pending.values():
                if not future.done():
                    future.set_exception(ToolError(message))

    def _read(self) -> None:
        try:
            while not self.closed:
                with self._lock:
                    expired = next(
                        (ident for ident, deadline in self._submitted.items() if deadline <= time.monotonic()), None
                    )
                    method = self._commands.get(expired, ("unknown", None))[0]
                if expired is not None:
                    raise ToolError(f"Browser event command {method} timed out; its remote outcome is unknown")
                try:
                    raw = self._socket.recv(timeout=0.1)
                except TimeoutError:
                    continue
                try:
                    message = json.loads(raw)
                    if not isinstance(message, dict):
                        raise ValueError
                except (ValueError, TypeError):
                    raise ToolError("Invalid browser protocol message") from None
                if "id" in message:
                    with self._lock:
                        future = self._pending.pop(message["id"], None)
                        self._submitted.pop(message["id"], None)
                        self._commands.pop(message["id"], None)
                        self._capacity.notify_all()
                        if future is not None and not future.done():
                            if "error" in message:
                                # Chrome errors may contain private endpoint URLs or page-controlled text.
                                future.set_exception(CdpProtocolError(message["error"]))
                            else:
                                future.set_result(message.get("result", {}))
                elif "method" in message:
                    if message["method"] == "Target.detachedFromTarget":
                        with self._lock:
                            settle_detached_session(
                                self._pending,
                                self._submitted,
                                self._commands,
                                message.get("params", {}).get("sessionId"),
                            )
                            self._capacity.notify_all()
                    if (
                        message["method"] == "Network.responseReceived"
                        and message.get("params", {}).get("type") != "Document"
                        and not self.capture_network
                    ):
                        continue
                    with self._lock:
                        registered = message["method"] in self._handlers
                    if registered:
                        if diagnostic_event(message) and self._events.qsize() >= DIAGNOSTIC_QUEUE_BUDGET:
                            continue
                        self._events.put_nowait(message)  # Essential overflow fails closed; never drop decisions.
        except ToolError as error:
            self._fail(str(error))
        except Exception:
            self._fail("The browser connection closed or exceeded its event limit")
        finally:
            self._fail("The browser connection is closed")
            self._socket.close()

    def _dispatch(self) -> None:
        while not self.closed:
            try:
                event = self._events.get(timeout=0.1)
            except queue.Empty:
                continue
            with self._lock:
                handlers = tuple(self._handlers.get(event["method"], ()))
            try:
                for handler in handlers:
                    handler(event.get("params", {}), event.get("sessionId"))
            except Exception:
                # Unknown failures stop dispatch; the owner handles remote process cleanup separately.
                self._fail("The browser event handler failed")
                self._socket.close()
            finally:
                self._events.task_done()

    def drain(self, timeout: float = 5) -> None:
        """Finish queued policy checks and their acknowledged replies before handing Chrome off."""
        deadline = time.monotonic() + timeout
        with self._events.all_tasks_done:
            while self._events.unfinished_tasks:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RuntimeError("Browser events did not settle; retry detach() or close()")
                self._events.all_tasks_done.wait(remaining)
        with self._capacity:
            while self._submitted and not self.closed:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RuntimeError("Browser event replies did not settle; retry detach() or close()")
                self._capacity.wait(remaining)

    def close(self) -> None:
        with self._lock:
            self._closing = True
        self._fail("The browser connection is closed")
        self._socket.close()
        for thread in (self._reader, self._worker, self._failure_worker):
            if thread is not None and thread is not threading.current_thread():
                thread.join(5)
                if thread.is_alive():
                    raise RuntimeError("Could not stop the browser connection worker")
