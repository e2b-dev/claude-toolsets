"""Async computer input on e2b.AsyncSandbox running the standard desktop template."""

from __future__ import annotations

import asyncio
import base64
import inspect
import re
import secrets
import shlex

from anthropic.tools import ToolError
from anthropic.tools.computer import (
    BetaAsyncAbstractComputerToolset20260801,
    BetaComputerCursorPositionResult,
    BetaScreenshotResult,
)

from ._async import finish_cleanup
from ._computer import chord, duration, integer, move, screen_size


class AsyncE2BComputerToolset(BetaAsyncAbstractComputerToolset20260801):
    """Borrow an AsyncSandbox; await create() and close(). The caller keeps sandbox ownership."""

    def __init__(self, desktop, *, configs=None, confirm=None, tool_configs=None):
        super().__init__(configs=configs, confirm=confirm, tool_configs=tool_configs)
        if not inspect.iscoroutinefunction(desktop.commands.run):
            raise ValueError("AsyncE2BComputerToolset requires e2b.AsyncSandbox on a desktop template")
        self.desktop = desktop
        self.width = self.height = 0
        self._held_keys: set[str] = set()
        self._mouse_down = False
        self._screenshots: set[str] = set()
        self._cleanup_lock = asyncio.Lock()

    @classmethod
    async def create(cls, desktop, **options):
        computer = cls(desktop, **options)
        computer.width, computer.height = screen_size(*(await computer._screen_size()))
        return computer

    async def _raw(self, command):
        try:
            # Wait for the acknowledgment before cleanup sends keyup/mouseup. Cancelling
            # local I/O cannot stop an already submitted remote xdotool process.
            return await finish_cleanup(self.desktop.commands.run(command, timeout=15))
        except Exception:
            raise ToolError("Desktop input failed; its remote outcome may be unknown") from None

    async def _run(self, command):
        await self._raw("xdotool " + command)

    def _move(self, coordinate):
        return move(coordinate, self.width, self.height)

    async def _screen_size(self):
        output = await self._raw("xrandr")
        match = re.search(r"current\s+(\d+)\s*x\s*(\d+)", output.stdout)
        if match is None:
            raise ToolError("Could not read the desktop screen size")
        return int(match[1]), int(match[2])

    async def _release_keys(self):
        failed = False
        for key in tuple(self._held_keys):
            try:
                await self._run("keyup " + key)
            except Exception:
                failed = True
            else:
                self._held_keys.remove(key)
        if failed:
            raise ToolError("Could not release desktop keys; retry close()")

    async def _release_mouse(self):
        await self._run("mouseup 1")
        self._mouse_down = False

    async def _modified(self, text, command):
        keys = chord(text) if text else None
        try:
            if keys:
                self._held_keys.add(keys)
                await self._run("keydown " + keys)
            await self._run(command)
        finally:
            await finish_cleanup(self._release_keys())

    async def close(self):
        sdk_close = super().close
        try:
            await sdk_close()
        except asyncio.CancelledError:

            async def finish():
                await sdk_close()
                await self._cleanup()

            await finish_cleanup(finish())
            raise
        await finish_cleanup(self._cleanup())

    async def _cleanup(self):
        async with self._cleanup_lock:
            failed = False
            try:
                await self._release_keys()
            except Exception:
                failed = True
            if self._mouse_down:
                try:
                    await self._release_mouse()
                except Exception:
                    failed = True
            for path in tuple(self._screenshots):
                try:
                    await self.desktop.files.remove(path)
                except Exception:
                    failed = True
                else:
                    self._screenshots.remove(path)
            if failed:
                raise ToolError("Could not release desktop resources; retry close()")

    async def _capture(self):
        path = "/tmp/e2b-computer-" + secrets.token_hex(12) + ".png"
        self._screenshots.add(path)
        try:
            await self._raw("scrot --pointer " + path)
            data = await self.desktop.files.read(path, format="bytes")
            return BetaScreenshotResult(data=base64.b64encode(data).decode(), media_type="image/png")
        except Exception:
            raise ToolError("Could not capture the desktop") from None
        finally:
            try:
                await self.desktop.files.remove(path)
            except Exception:
                raise ToolError("Could not remove the desktop screenshot; retry close()") from None
            self._screenshots.remove(path)

    async def screenshot(self, context, input):
        await asyncio.sleep(0.3)
        if await self._screen_size() != (self.width, self.height):
            raise ToolError("The desktop resolution changed; create a new toolset")
        return await finish_cleanup(self._capture())

    async def cursor_position(self, context, input):
        output = await self._raw("xdotool getmouselocation")
        match = re.search(r"x:(-?\d+)\s+y:(-?\d+)", output.stdout)
        if match is None:
            raise ToolError("Could not read the desktop cursor")
        return BetaComputerCursorPositionResult(x=int(match[1]), y=int(match[2]))

    async def mouse_move(self, context, input):
        await self._run(self._move(input.coordinate))

    async def _click(self, input, button, count):
        point = self._move(input.coordinate) + " " if input.coordinate is not None else ""
        await self._modified(input.text, f"{point}click --repeat {count} --delay 80 {button}")

    async def left_click(self, context, input):
        await self._click(input, 1, 1)

    async def right_click(self, context, input):
        await self._click(input, 3, 1)

    async def middle_click(self, context, input):
        await self._click(input, 2, 1)

    async def double_click(self, context, input):
        await self._click(input, 1, 2)

    async def triple_click(self, context, input):
        await self._click(input, 1, 3)

    async def left_mouse_down(self, context, input):
        self._mouse_down = True
        try:
            await self._run("mousedown 1")
        except BaseException:
            await finish_cleanup(self._release_mouse())
            raise

    async def left_mouse_up(self, context, input):
        await self._release_mouse()

    async def left_click_drag(self, context, input):
        start, end = self._move(input.start_coordinate), self._move(input.coordinate)
        if input.text:
            chord(input.text)
        try:
            self._mouse_down = True
            await self._modified(input.text, f"{start} mousedown 1 {end} mouseup 1")
        finally:
            await finish_cleanup(self._release_mouse())

    async def scroll(self, context, input):
        button = {"up": 4, "down": 5, "left": 6, "right": 7}[input.scroll_direction]
        amount = integer(input.scroll_amount, "scroll_amount", 50)
        point = self._move(input.coordinate) + " " if input.coordinate is not None else ""
        await self._modified(input.text, f"{point}click --repeat {amount} --delay 20 {button}")

    async def key(self, context, input):
        keys = chord(input.text)
        repeat = integer(1 if input.repeat is None else input.repeat, "repeat", 100)
        try:
            self._held_keys.add(keys)
            await self._run(f"key --clearmodifiers --repeat {repeat} --delay 50 {keys}")
        finally:
            await finish_cleanup(self._release_keys())

    async def hold_key(self, context, input):
        seconds, keys = duration(input.duration), chord(input.text)
        try:
            self._held_keys.add(keys)
            await self._run("keydown " + keys)
            await asyncio.sleep(seconds)
        finally:
            await finish_cleanup(self._release_keys())

    async def type(self, context, input):
        for offset in range(0, len(input.text), 50):
            await self._run("type --delay 12 -- " + shlex.quote(input.text[offset : offset + 50]))

    async def wait(self, context, input):
        await asyncio.sleep(duration(input.duration))
