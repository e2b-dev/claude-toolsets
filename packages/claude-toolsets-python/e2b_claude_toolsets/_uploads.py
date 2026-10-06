"""Bounded local reads after the Anthropic file policy has approved the sources."""

from __future__ import annotations

import os
import stat
from dataclasses import dataclass
from pathlib import Path

from anthropic.tools import ToolError

MAX_UPLOAD_BYTES = 10 * 1024 * 1024


def upload_name(name: str) -> str:
    if (
        not name
        or name in {".", ".."}
        or len(name.encode()) > 255
        or any(char in "/\\" or ord(char) < 32 or ord(char) == 127 for char in name)
    ):
        raise ToolError("file_upload: invalid file name")
    return name


@dataclass(frozen=True)
class UploadFile:
    """Application-provided document bytes; the SDK must also allowlist its document ID."""

    name: str
    data: bytes

    def __post_init__(self):
        upload_name(self.name)
        if not isinstance(self.data, bytes):
            raise ValueError("UploadFile.data must be immutable bytes")


def _fingerprint(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


def read_upload(path: str, budget: int) -> UploadFile:
    try:
        if not os.path.isabs(path) or "\0" in path:
            raise ToolError("file_upload: expected a policy-resolved absolute path")
        before = os.lstat(path)
        if not stat.S_ISREG(before.st_mode) or os.path.realpath(path) != path:
            raise ToolError("file_upload: source must be a resolved regular file")
        if before.st_size > budget:
            raise ToolError("file_upload: total size exceeds 10 MiB")
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as source:
            opened = os.fstat(source.fileno())
            if not stat.S_ISREG(opened.st_mode) or _fingerprint(opened) != _fingerprint(before):
                raise ToolError("file_upload: source changed while opening")
            data = source.read(opened.st_size + 1)
            after = os.fstat(source.fileno())
            if (
                len(data) != opened.st_size
                or _fingerprint(after) != _fingerprint(opened)
                or os.path.realpath(path) != path
            ):
                raise ToolError("file_upload: source changed while reading")
        return UploadFile(Path(path).name, data)
    except ToolError:
        raise
    except (OSError, ValueError):
        raise ToolError("file_upload: could not read the approved file") from None


def prepare_uploads(paths, document_ids, documents) -> list[UploadFile]:
    if not 1 <= len(paths) + len(document_ids) <= 20:
        raise ToolError("file_upload: provide between 1 and 20 files")
    files = []
    remaining = MAX_UPLOAD_BYTES
    for path in paths:
        file = read_upload(path, remaining)
        remaining -= len(file.data)
        files.append(file)
    for ident in document_ids:
        file = documents.get(ident)
        if not isinstance(file, UploadFile):
            raise ToolError("file_upload: document has not been staged by the application")
        if len(file.data) > remaining:
            raise ToolError("file_upload: total size exceeds 10 MiB")
        remaining -= len(file.data)
        files.append(file)
    return files
