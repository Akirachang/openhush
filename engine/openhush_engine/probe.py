"""Inspect media files with ffprobe."""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

from . import tools
from .errors import NoAudioError, UnsupportedFileError

AUDIO_EXTS = {".wav", ".mp3", ".m4a", ".flac"}
VIDEO_EXTS = {".mp4", ".mov", ".mkv"}
SUPPORTED_EXTS = AUDIO_EXTS | VIDEO_EXTS


@dataclass
class AudioStream:
    index: int  # ffprobe stream index
    order: int  # position among audio streams (for -map 0:a:N)
    codec: str
    sample_rate: int
    channels: int
    bit_rate: int | None
    bits: int | None  # bits per raw sample for lossless/PCM
    start_time: float
    tags: dict  # language/title/handler_name to carry over to the cleaned track


@dataclass
class MediaInfo:
    path: Path
    kind: str  # "audio" or "video"
    duration: float
    audio: AudioStream
    n_audio_streams: int
    has_cover: bool  # audio file with embedded cover art
    container_start: float  # format start_time; ffmpeg shifts copied streams by -this


def _f(v, default=0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _i(v) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def probe(path: str | Path) -> MediaInfo:
    path = Path(path)
    ext = path.suffix.lower()
    if not path.exists():
        raise UnsupportedFileError(f"“{path.name}” doesn't exist (was it moved?).")
    if path.is_dir():
        raise UnsupportedFileError(f"“{path.name}” is a folder, not a file.")
    if ext not in SUPPORTED_EXTS:
        raise UnsupportedFileError(
            f"“{path.name}” isn't a supported file type.",
            "Supported: " + ", ".join(sorted(e[1:] for e in SUPPORTED_EXTS)),
        )

    proc = subprocess.run(
        [tools.ffprobe(), "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise UnsupportedFileError(
            f"Couldn't read “{path.name}”. It may be damaged or not a real {ext[1:].upper()} file.",
            proc.stderr.replace(str(path), path.name).strip()[-500:],
        )
    data = json.loads(proc.stdout or "{}")
    streams = data.get("streams", [])
    fmt = data.get("format", {})

    audio_streams = [s for s in streams if s.get("codec_type") == "audio"]
    videos = [
        s for s in streams
        if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")
    ]
    covers = [s for s in streams if s.get("codec_type") == "video" and s.get("disposition", {}).get("attached_pic")]

    if not audio_streams:
        raise NoAudioError(f"“{path.name}” has no audio track, so there's nothing to clean.")

    # Prefer the stream marked "default", otherwise the first.
    order = next((i for i, s in enumerate(audio_streams) if s.get("disposition", {}).get("default")), 0)
    a = audio_streams[order]
    sr = _i(a.get("sample_rate")) or 0
    ch = _i(a.get("channels")) or 0
    if sr <= 0 or ch <= 0:
        raise UnsupportedFileError(f"The audio in “{path.name}” couldn't be decoded.")

    kind = "video" if ext in VIDEO_EXTS else "audio"
    if kind == "video" and not videos:
        kind = "audio"  # e.g. an .mp4 that only holds audio: treat as audio

    bit_rate = _i(a.get("bit_rate"))
    if bit_rate is None and kind == "audio" and len(streams) == 1:
        bit_rate = _i(fmt.get("bit_rate"))  # e.g. some mp3s only report it at container level

    duration = _f(fmt.get("duration")) or _f(a.get("duration"))
    if duration <= 0:
        raise UnsupportedFileError(f"Couldn't determine the length of “{path.name}”.")

    return MediaInfo(
        path=path,
        kind=kind,
        duration=duration,
        audio=AudioStream(
            index=int(a["index"]),
            order=order,
            codec=a.get("codec_name", ""),
            sample_rate=sr,
            channels=ch,
            bit_rate=bit_rate,
            bits=_i(a.get("bits_per_raw_sample")) or _i(a.get("bits_per_sample")) or None,
            start_time=_f(a.get("start_time")),
            tags={k.lower(): v for k, v in a.get("tags", {}).items()
                  if k.lower() in ("language", "title", "handler_name")},
        ),
        n_audio_streams=len(audio_streams),
        has_cover=bool(covers),
        container_start=_f(fmt.get("start_time")),
    )
