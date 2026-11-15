"""Locate ffmpeg/ffprobe and the DeepFilterNet `deep-filter` binary (downloading it once)."""

from __future__ import annotations

import hashlib
import os
import platform
import shutil
import stat
import tempfile
import urllib.request
from functools import lru_cache
from pathlib import Path
from typing import Callable

from .errors import EngineMissingError, FfmpegMissingError

_APP_ROOT = Path.home() / "Library" / "Application Support" / "OpenHush"  # the desktop app's own folder
# Engine downloads live in their own subfolder, apart from the desktop shell's browser profile.
APP_SUPPORT = Path(os.environ.get("OPENHUSH_DATA_DIR") or _APP_ROOT / "engine")
LOG_DIR = Path.home() / "Library" / "Logs" / "OpenHush"
_PREVIOUS_APP_SUPPORT = Path.home() / "Library" / "Application Support" / "Hush"  # the earlier PySide6 "Hush" app


def migrate_previous_data() -> None:
    """Reuse earlier downloads (engine binary, Heavy repair) instead of downloading them again.

    Sources: the earlier "Hush" app's folder, and the first OpenHush layout that kept them at the top level.
    """
    if os.environ.get("OPENHUSH_DATA_DIR"):
        return
    try:
        for src in (_PREVIOUS_APP_SUPPORT, _APP_ROOT):
            for name in ("bin", "heavy"):
                old, new = src / name, APP_SUPPORT / name
                if old.is_dir() and not new.exists():
                    new.parent.mkdir(parents=True, exist_ok=True)
                    old.rename(new)
        if _PREVIOUS_APP_SUPPORT.is_dir():
            shutil.rmtree(_PREVIOUS_APP_SUPPORT, ignore_errors=True)  # only duplicates are left
    except OSError:
        pass

DF_VERSION = "0.5.6"
_RELEASE = f"https://github.com/Rikorose/DeepFilterNet/releases/download/v{DF_VERSION}"
# SHA-256 of the official release assets (recorded when first downloaded for this project).
_ASSETS = {
    "arm64": (f"deep-filter-{DF_VERSION}-aarch64-apple-darwin",
              "4601e7f4e4c03e59a4c5b5000216ef3add3e808799cfccd95e14e83ea4611081"),
    "x86_64": (f"deep-filter-{DF_VERSION}-x86_64-apple-darwin",
               "d3be84003acb7c23e738ad7f70a158ec779a8d233a82e7fa3e717d112eb5b50f"),
}

_EXTRA_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"]


def _which(name: str) -> str | None:
    found = shutil.which(name)
    if found:
        return found
    # Apps launched from Finder don't get the shell PATH, so check the usual spots.
    for d in _EXTRA_BIN_DIRS:
        p = Path(d) / name
        if p.is_file() and os.access(p, os.X_OK):
            return str(p)
    return None


@lru_cache(maxsize=1)
def ffmpeg_paths() -> tuple[str, str]:
    ffmpeg, ffprobe = _which("ffmpeg"), _which("ffprobe")
    if not ffmpeg or not ffprobe:
        raise FfmpegMissingError()
    return ffmpeg, ffprobe


def ffmpeg() -> str:
    return ffmpeg_paths()[0]


def ffprobe() -> str:
    return ffmpeg_paths()[1]


@lru_cache(maxsize=1)
def has_encoder(name: str) -> bool:
    import subprocess

    out = subprocess.run([ffmpeg(), "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
    return any(line.split()[1:2] == [name] for line in out.splitlines() if line.startswith(" "))


def engine_path() -> Path:
    override = os.environ.get("OPENHUSH_DEEP_FILTER")
    if override:
        return Path(override)
    return APP_SUPPORT / "bin" / f"deep-filter-{DF_VERSION}"


def engine_ready() -> bool:
    p = engine_path()
    return p.is_file() and os.access(p, os.X_OK)


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_engine(progress: Callable[[float], None] | None = None) -> Path:
    """Return the deep-filter binary, downloading and verifying it on first use."""
    target = engine_path()
    if engine_ready():
        return target
    if platform.system() != "Darwin" or platform.machine() not in _ASSETS:
        raise EngineMissingError(
            "The noise-removal engine isn't available for this computer.",
            f"Unsupported platform {platform.system()} {platform.machine()}.",
        )
    name, expected = _ASSETS[platform.machine()]
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=target.parent, suffix=".download")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as out, urllib.request.urlopen(f"{_RELEASE}/{name}", timeout=30) as resp:
            total = int(resp.headers.get("Content-Length") or 0)
            done = 0
            while chunk := resp.read(1 << 16):
                out.write(chunk)
                done += len(chunk)
                if progress and total:
                    progress(done / total)
        actual = _sha256(tmp)
        if actual != expected:
            raise EngineMissingError(
                "The downloaded noise-removal engine failed its integrity check.",
                f"Expected SHA-256 {expected}, got {actual}.",
            )
        tmp.chmod(tmp.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        os.replace(tmp, target)
    except EngineMissingError:
        raise
    except OSError as e:
        raise EngineMissingError(
            "Couldn't download the noise-removal engine (needed once, ~28 MB). "
            "Check your internet connection and try again.",
            str(e),
        ) from e
    finally:
        tmp.unlink(missing_ok=True)
    return target
