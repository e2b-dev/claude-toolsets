"""Finish bounded resource cleanup even if its caller is cancelled again."""

import asyncio
from collections.abc import Awaitable
from typing import TypeVar

T = TypeVar("T")


async def finish_cleanup(operation: Awaitable[T]) -> T:
    task = asyncio.ensure_future(operation)
    cancelled = None
    while True:
        try:
            result = await asyncio.shield(task)
            break
        except asyncio.CancelledError as error:
            if task.cancelled():
                raise
            cancelled = error
            if task.done():
                result = task.result()
                break
    if cancelled is not None:
        raise cancelled
    return result
