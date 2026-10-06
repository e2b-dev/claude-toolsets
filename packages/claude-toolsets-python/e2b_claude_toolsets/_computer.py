"""Synchronous computer input on a caller-owned E2B desktop."""

from __future__ import annotations

import base64
import math
import re
import threading
import time
from typing import Any

from anthropic.tools import ToolError
from anthropic.tools.computer import (
    BetaAbstractComputerToolset20260801,
    BetaComputerCursorPositionResult,
    BetaScreenshotResult,
)

_ALIASES = {
    "control": "ctrl",
    "cmd": "super",
    "meta": "super",
    "win": "super",
    "enter": "Return",
    "return": "Return",
    "esc": "Escape",
    "escape": "Escape",
    "backspace": "BackSpace",
    "delete": "Delete",
    "tab": "Tab",
    "space": "space",
    "pageup": "Page_Up",
    "pagedown": "Page_Down",
}


def chord(text: str) -> str:
    parts = text.split("+")
    if not parts or any(not re.fullmatch(r"[A-Za-z0-9_]+", p.strip()) for p in parts):
        raise ToolError("Expected plain key names joined with +")
    return "+".join(_ALIASES.get(p.strip().lower(), p.strip()) for p in parts)


def duration(seconds: float) -> float:
    if (
        isinstance(seconds, bool)
        or not isinstance(seconds, (int, float))
        or not math.isfinite(seconds)
        or not 0 <= seconds <= 30
    ):
        raise ToolError("duration must be between 0 and 30 seconds")
    return seconds


def integer(value, name, maximum):
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or int(value) != value
        or not 1 <= value <= maximum
    ):
        raise ToolError(f"{name} must be an integer between 1 and {maximum}")
    return int(value)


# Above this many pixels the API shrinks a screenshot, and the model's click coordinates no longer match the screen.
MAX_SCREEN_PIXELS = 2560 * 1440


def screen_size(width, height, what="desktop resolution"):
    if (
        any(isinstance(value, bool) or not isinstance(value, int) for value in (width, height))
        or min(width, height) < 200
    ):
        raise ValueError(f"{what}: width and height must be integers of at least 200")
    if width * height > MAX_SCREEN_PIXELS:
        raise ValueError(
            f"{what} {width}x{height} is too large: the API shrinks larger screenshots and clicks miss; "
            "use at most 2560x1440 pixels in total, e.g. 1920x1200"
        )
    return width, height


def move(coordinate, width, height):
    if (
        coordinate is None
        or len(coordinate) != 2
        or any(isinstance(x, bool) or not isinstance(x, int) for x in coordinate)
    ):
        raise ToolError("coordinate must contain two integers")
    x, y = coordinate
    if not (0 <= x < width and 0 <= y < height):
        raise ToolError("coordinate is outside the screen")
    return f"mousemove {x} {y}"


class E2BComputerToolset(BetaAbstractComputerToolset20260801):
    @classmethod
    def create(cls, desktop, **options):
        """Attach to a desktop, as AsyncE2BComputerToolset.create() does; the same as calling the class."""
        return cls(desktop, **options)

    """Attach to a desktop. Closing this toolset never kills the caller's sandbox."""

    def __init__(self, desktop: Any, *, configs=None, confirm=None, tool_configs=None) -> None:
        super().__init__(configs=configs, confirm=confirm, tool_configs=tool_configs)
        self.desktop = desktop
        self._held_keys: set[str] = set()
        self._mouse_down = False
        self._cleanup_lock = threading.Lock()
        try:
            self.width, self.height = desktop.get_screen_size()
        except Exception:
            raise RuntimeError("Could not read the desktop screen size") from None
        screen_size(self.width, self.height)

    def _run(self, command: str) -> None:
        try:
            self.desktop.commands.run("xdotool " + command, timeout=15)
        except Exception:
            raise ToolError("Desktop input failed; its remote outcome may be unknown") from None

    def _move(self, coordinate) -> str:
        return move(coordinate, self.width, self.height)

    def _release_keys(self) -> None:
        failed = False
        for key in tuple(self._held_keys):
            try:
                self._run("keyup " + key)
                self._held_keys.remove(key)
            except Exception:
                failed = True
        if failed:
            raise ToolError("Could not release desktop keys; retry close()")

    def _modified(self, text, command):
        keys = chord(text) if text else None
        try:
            if keys:
                self._held_keys.add(keys)  # also release when keydown's acknowledgment is lost
                self._run("keydown " + keys)
            self._run(command)
        finally:
            self._release_keys()

    def close(self) -> None:
        super().close()
        with self._cleanup_lock:
            failed = False
            try:
                self._release_keys()
            except Exception:
                failed = True
            if self._mouse_down:
                try:
                    self._run("mouseup 1")
                    self._mouse_down = False
                except Exception:
                    failed = True
            if failed:
                raise ToolError("Could not release desktop input; retry close()")

    def screenshot(self, context, input) -> BetaScreenshotResult:
        time.sleep(0.3)
        try:
            if self.desktop.get_screen_size() != (self.width, self.height):
                raise ToolError("The desktop resolution changed; create a new toolset")
            data = self.desktop.screenshot()
        except Exception:
            raise ToolError("Could not capture the desktop") from None
        return BetaScreenshotResult(data=base64.b64encode(data).decode(), media_type="image/png")

    def cursor_position(self, context, input) -> BetaComputerCursorPositionResult:
        try:
            x, y = self.desktop.get_cursor_position()
        except Exception:
            raise ToolError("Could not read the desktop cursor") from None
        return BetaComputerCursorPositionResult(x=x, y=y)

    def mouse_move(self, context, input) -> None:
        self._run(self._move(input.coordinate))

    def _click(self, input, button, count):
        move = self._move(input.coordinate) + " " if input.coordinate is not None else ""
        self._modified(input.text, f"{move}click --repeat {count} --delay 80 {button}")

    def left_click(self, context, input) -> None:
        self._click(input, 1, 1)

    def right_click(self, context, input) -> None:
        self._click(input, 3, 1)

    def middle_click(self, context, input) -> None:
        self._click(input, 2, 1)

    def double_click(self, context, input) -> None:
        self._click(input, 1, 2)

    def triple_click(self, context, input) -> None:
        self._click(input, 1, 3)

    def left_mouse_down(self, context, input) -> None:
        self._mouse_down = True
        try:
            self._run("mousedown 1")
        except BaseException:
            self._run("mouseup 1")
            self._mouse_down = False
            raise

    def left_mouse_up(self, context, input) -> None:
        self._run("mouseup 1")
        self._mouse_down = False

    def left_click_drag(self, context, input) -> None:
        start, end = self._move(input.start_coordinate), self._move(input.coordinate)
        if input.text:
            chord(input.text)
        try:
            self._mouse_down = True
            self._modified(input.text, f"{start} mousedown 1 {end} mouseup 1")
        finally:
            self._run("mouseup 1")
            self._mouse_down = False

    def scroll(self, context, input) -> None:
        button = {"up": 4, "down": 5, "left": 6, "right": 7}[input.scroll_direction]
        amount = integer(input.scroll_amount, "scroll_amount", 50)
        move = self._move(input.coordinate) + " " if input.coordinate is not None else ""
        self._modified(input.text, f"{move}click --repeat {amount} --delay 20 {button}")

    def key(self, context, input) -> None:
        keys = chord(input.text)
        repeat = integer(1 if input.repeat is None else input.repeat, "repeat", 100)
        try:
            self._held_keys.add(keys)
            self._run(f"key --clearmodifiers --repeat {repeat} --delay 50 {keys}")
        finally:
            self._release_keys()

    def hold_key(self, context, input) -> None:
        seconds, keys = duration(input.duration), chord(input.text)
        try:
            self._held_keys.add(keys)
            self._run("keydown " + keys)
            time.sleep(seconds)
        finally:
            self._release_keys()

    def type(self, context, input) -> None:
        try:
            self.desktop.write(input.text, chunk_size=50, delay_in_ms=12)
        except Exception:
            raise ToolError("Could not type on the desktop; the remote outcome may be unknown") from None

    def wait(self, context, input) -> None:
        time.sleep(duration(input.duration))
