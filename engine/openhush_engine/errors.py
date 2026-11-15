"""User-facing errors. Every message here is meant to be shown as-is in the UI."""

from __future__ import annotations

import errno


class HushError(Exception):
    """An error with a plain-English message and optional technical details."""

    def __init__(self, message: str, details: str = ""):
        super().__init__(message)
        self.message = message
        self.details = details


class UnsupportedFileError(HushError):
    pass


class NoAudioError(HushError):
    pass


class FfmpegMissingError(HushError):
    def __init__(self) -> None:
        super().__init__(
            "ffmpeg is not installed.",
            "OpenHush uses ffmpeg to read and write audio/video. Install it with:  brew install ffmpeg",
        )


class EngineMissingError(HushError):
    pass


class EngineError(HushError):
    pass


class FfmpegError(HushError):
    pass


class OutputError(HushError):
    pass


class CancelledError(HushError):
    def __init__(self) -> None:
        super().__init__("Cancelled.")


def friendly(exc: BaseException) -> HushError:
    """Turn any exception into a HushError with a readable message."""
    if isinstance(exc, HushError):
        return exc
    if isinstance(exc, OSError):
        if exc.errno == errno.ENOSPC:
            return OutputError("Not enough disk space to save the cleaned file.", str(exc))
        if exc.errno in (errno.EACCES, errno.EPERM, errno.EROFS):
            return OutputError(
                "Can't save next to the original. The folder is read-only or not accessible.",
                str(exc),
            )
        if exc.errno == errno.ENOENT:
            return HushError("File not found. It may have been moved or deleted.", str(exc))
    return HushError("Something went wrong while processing this file.", f"{type(exc).__name__}: {exc}")
