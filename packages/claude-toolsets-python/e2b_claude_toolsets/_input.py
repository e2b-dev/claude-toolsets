"""CDP keyboard definitions for US layout. Input release is attempted even on failure."""

from __future__ import annotations

import asyncio
import re
import time

from anthropic.tools import ToolError

from ._async import finish_cleanup

_MODS = {
    "alt": 1,
    "option": 1,
    "ctrl": 2,
    "control": 2,
    "meta": 4,
    "cmd": 4,
    "command": 4,
    "super": 4,
    "win": 4,
    "shift": 8,
}
_KEYS: dict[str, dict] = {}
_ALIASES: dict[str, str] = {}


def _define(key, code, keycode, aliases=(), **extra):
    _KEYS[key] = {"key": key, "code": code, "windowsVirtualKeyCode": keycode, **extra}
    for alias in (key, *aliases):
        _ALIASES[alias.lower()] = key


for _i in range(26):
    _lower, _upper = chr(97 + _i), chr(65 + _i)
    _define(_lower, "Key" + _upper, 65 + _i, text=_lower, shift_key=_upper)
    _define(_upper, "Key" + _upper, 65 + _i, text=_upper, shift=True)
for _i, _shifted in enumerate(")!@#$%^&*("):
    _define(str(_i), "Digit" + str(_i), 48 + _i, text=str(_i), shift_key=_shifted)
    _define(_shifted, "Digit" + str(_i), 48 + _i, text=_shifted, shift=True)
for _base, _shifted, _code, _number in [
    ("-", "_", "Minus", 189),
    ("=", "+", "Equal", 187),
    ("[", "{", "BracketLeft", 219),
    ("]", "}", "BracketRight", 221),
    ("\\", "|", "Backslash", 220),
    (";", ":", "Semicolon", 186),
    ("'", '"', "Quote", 222),
    (",", "<", "Comma", 188),
    (".", ">", "Period", 190),
    ("/", "?", "Slash", 191),
    ("`", "~", "Backquote", 192),
]:
    _define(_base, _code, _number, text=_base, shift_key=_shifted)
    _define(_shifted, _code, _number, text=_shifted, shift=True)
for _key, _code, _number, _aliases in [
    ("Enter", "Enter", 13, ("Return",)),
    ("Tab", "Tab", 9, ()),
    ("Backspace", "Backspace", 8, ()),
    ("Delete", "Delete", 46, ("Del",)),
    ("Escape", "Escape", 27, ("Esc",)),
    ("Insert", "Insert", 45, ()),
    ("Home", "Home", 36, ()),
    ("End", "End", 35, ()),
    ("PageUp", "PageUp", 33, ("Page_Up", "Prior")),
    ("PageDown", "PageDown", 34, ("Page_Down", "Next")),
    ("ArrowLeft", "ArrowLeft", 37, ("Left",)),
    ("ArrowUp", "ArrowUp", 38, ("Up",)),
    ("ArrowRight", "ArrowRight", 39, ("Right",)),
    ("ArrowDown", "ArrowDown", 40, ("Down",)),
    (" ", "Space", 32, ("space",)),
    ("CapsLock", "CapsLock", 20, ("Caps_Lock",)),
    ("ContextMenu", "ContextMenu", 93, ("Menu",)),
    ("Pause", "Pause", 19, ()),
    ("PrintScreen", "PrintScreen", 44, ("Print",)),
]:
    _define(_key, _code, _number, _aliases)
for _i in range(1, 25):
    _define("F" + str(_i), "F" + str(_i), 111 + _i)
for _key, _code, _number, _bit, _aliases in [
    ("Shift", "ShiftLeft", 16, 8, ("Shift_L",)),
    ("Control", "ControlLeft", 17, 2, ("ctrl", "Control_L")),
    ("Alt", "AltLeft", 18, 1, ("Alt_L", "option")),
    ("Meta", "MetaLeft", 91, 4, ("cmd", "super", "win", "command", "Super_L")),
]:
    _define(_key, _code, _number, _aliases, modifier=_bit, location=1)
_KEYS["Enter"]["text"] = "\r"
_KEYS[" "]["text"] = " "
_ALIASES["plus"] = "+"
_ALIASES["iso_left_tab"] = "Tab"


def modifiers(text) -> int:
    bits = 0
    for part in (text or "").split("+"):
        if not part.strip():
            continue
        if part.strip().lower() not in _MODS:
            raise ToolError("Unknown modifier key")
        bits |= _MODS[part.strip().lower()]
    return bits


def key_def(name):
    key = name if name in _KEYS else _ALIASES.get(name.lower())
    if key is None:
        raise ToolError("Unknown key; use a supported US-layout key name")
    definition = _KEYS[key].copy()
    if name.lower() == "iso_left_tab":
        definition["shift"] = True
    return definition


def _event(definition, bits, up=False):
    d = definition.copy()
    d.pop("modifier", None)
    d.pop("shift", None)
    shifted = d.pop("shift_key", None)
    if shifted and bits & 8:
        d["key"] = shifted
        d["text"] = shifted
    if bits & (1 | 2 | 4) or up:
        d.pop("text", None)
    d["type"] = "keyUp" if up else "keyDown" if "text" in d else "rawKeyDown"
    d["modifiers"] = bits
    if "text" in d:
        d["unmodifiedText"] = d["text"]
    return d


def _down_event(definition, bits):
    event = _event(definition, bits)
    if bits & (2 | 4) and not bits & 1:
        command = {"a": "selectAll", "c": "copy", "v": "paste", "x": "cut", "z": "undo", "y": "redo"}.get(
            definition["key"].lower()
        )
        if command:
            event["commands"] = ["redo" if command == "undo" and bits & 8 else command]
    return event


def chords(text):
    chords = []
    for token in text.strip().split():
        definitions = [key_def(p) for p in re.split(r"\+(?=.)", token)]
        if any("modifier" not in d for d in definitions[:-1]):
            raise ToolError("Only modifier keys may precede a chord's main key")
        if definitions[-1].get("shift") and not any(d.get("modifier") == 8 for d in definitions):
            definitions.insert(0, key_def("Shift"))
        chords.append(definitions)
    if not chords:
        raise ToolError("Expected at least one key")
    return chords


def press(send, text, repeat=1, hold=0, held=None):
    held = [] if held is None else held
    parsed = chords(text)
    for _ in range(repeat):
        bits = 0
        try:
            for definitions in parsed:
                for d in definitions:
                    bits |= d.get("modifier", 0)
                    held.append(d)
                    event = _down_event(d, bits)
                    send("Input.dispatchKeyEvent", event)
                if not hold:
                    _release(send, held, bits)
                    held.clear()
                    bits = 0
            if hold:
                time.sleep(hold)
        finally:
            _release(send, held, bits)


def _release(send, held, bits):
    failed = False
    for d in reversed(tuple(held)):
        bits &= ~d.get("modifier", 0)
        try:
            send("Input.dispatchKeyEvent", _event(d, bits, True))
        except Exception:
            failed = True
        else:
            held.remove(d)
    if failed:
        raise ToolError("Could not release browser input")


def type_text(send, text, held=None):
    for piece in re.split(r"([\n\t])", text.replace("\r\n", "\n").replace("\r", "\n")):
        if piece in {"\n", "\t"}:
            press(send, "Return" if piece == "\n" else "Tab", held=held)
        elif piece:
            send("Input.insertText", {"text": piece})


async def release_async(send, held, bits):
    failed = False
    for definition in reversed(tuple(held)):
        bits &= ~definition.get("modifier", 0)
        try:
            await send("Input.dispatchKeyEvent", _event(definition, bits, True))
        except Exception:
            failed = True
        else:
            held.remove(definition)
    if failed:
        raise ToolError("Could not release browser input")


async def press_async(send, text, repeat=1, hold=0, held=None):
    held = [] if held is None else held
    parsed = chords(text)
    for _ in range(repeat):
        bits = 0
        try:
            for definitions in parsed:
                for definition in definitions:
                    bits |= definition.get("modifier", 0)
                    held.append(definition)
                    event = _down_event(definition, bits)
                    await send("Input.dispatchKeyEvent", event)
                if not hold:
                    await finish_cleanup(release_async(send, held, bits))
                    held.clear()
                    bits = 0
            if hold:
                await asyncio.sleep(hold)
        finally:
            await finish_cleanup(release_async(send, held, bits))


async def type_text_async(send, text, held=None):
    for piece in re.split(r"([\n\t])", text.replace("\r\n", "\n").replace("\r", "\n")):
        if piece in {"\n", "\t"}:
            await press_async(send, "Return" if piece == "\n" else "Tab", held=held)
        elif piece:
            await send("Input.insertText", {"text": piece})
