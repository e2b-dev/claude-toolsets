"""Host bridge to the same generated browser runtime shipped by the TypeScript driver."""

import json
from pathlib import Path
from typing import Any, Literal

_ASSETS = Path(__file__).with_name("_runtime")
RUNTIME_SOURCE = _ASSETS.joinpath("runtime.js").read_text(encoding="utf-8")
_MANIFEST = json.loads(_ASSETS.joinpath("manifest.json").read_text(encoding="utf-8"))
REF_BLOCK_SIZE = _MANIFEST["refBlockSize"]
Operation = Literal["read_page", "find", "page_text", "resolve", "form_input", "scroll_to", "file_input"]


def expression(name: Operation, args: dict[str, Any]) -> str:
    request = json.dumps({"operation": name, "args": args}, ensure_ascii=True, allow_nan=False)
    return f"globalThis[{json.dumps(_MANIFEST['key'])}].call({request})"


def file_input_expression(ref: str, count: int, base: int) -> str:
    return expression("file_input", dict(ref=ref, count=count, base=base)) + (
        ".then(result => result.ok ? result.value : {error: result.error.message})"
    )


def file_input_validation(ref: str, count: int, base: int) -> str:
    return (
        "function(){return "
        + expression("file_input", dict(ref=ref, count=count, base=base))
        + (".then(result => result.ok && result.value === this)}")
    )


def runtime_result(value: Any) -> dict[str, Any]:
    """Check the envelope before the adapter uses its value or reference counter."""
    if not isinstance(value, dict):
        raise ValueError("The page did not answer")
    counter = value.get("nextRef")
    if type(counter) is not int or not 1 <= counter <= 2**53 - 1:
        raise ValueError("Invalid page reference counter")
    if value.get("ok") is True and "value" in value:
        return value
    error = value.get("error")
    if (
        value.get("ok") is False
        and isinstance(error, dict)
        and isinstance(error.get("code"), str)
        and isinstance(error.get("message"), str)
    ):
        return value
    raise ValueError("Invalid page result")
