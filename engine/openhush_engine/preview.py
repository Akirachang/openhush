"""Render a short original/cleaned pair for A/B listening."""

from __future__ import annotations

import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .engine import SR, CancelToken
from .errors import FfmpegError
from .pipeline import PREROLL_S, Settings, decoder_command, make_engine
from .probe import MediaInfo

PREVIEW_S = 15.0


@dataclass
class Section:
    path: Path
    start: float  # seconds into the file
    original: np.ndarray  # (frames, channels) float32 @ 48 kHz
    cleaned: np.ndarray | None = None
    strength_db: float | None = None


def decode_section(info: MediaInfo, start: float, length: float = PREVIEW_S,
                   cancel: CancelToken | None = None) -> tuple[np.ndarray, int]:
    """Decode [start - preroll, start + length). Returns (audio, preroll_frames)."""
    pre_start = max(0.0, start - PREROLL_S)
    cmd = decoder_command(info, start=pre_start, duration=(start - pre_start) + length)
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if cancel:
        cancel.register(proc)
    try:
        raw, err = proc.communicate()
    finally:
        if cancel:
            cancel.unregister(proc)
    if cancel:
        cancel.check()
    if proc.returncode != 0:
        raise FfmpegError(f"Couldn't read audio from “{info.path.name}”.", err.decode(errors="replace")[-500:])
    audio = np.frombuffer(raw, dtype="<f4").reshape(-1, info.audio.channels).copy()
    if len(audio) == 0:
        raise FfmpegError(f"No audio found at {start:.1f}s in “{info.path.name}”.")
    return audio, int(round((start - pre_start) * SR))


class PreviewRenderer:
    """Keeps the decoded section so a strength change only re-runs the engine."""

    def __init__(self) -> None:
        self._key: tuple | None = None
        self._audio: np.ndarray | None = None
        self._preroll = 0

    def render(self, info: MediaInfo, start: float, strength_db: float,
               cancel: CancelToken | None = None, heavy: bool = False) -> Section:
        key = (str(info.path), round(start, 3))
        if key != self._key:
            self._audio, self._preroll = decode_section(info, start, cancel=cancel)
            self._key = key
        audio, pre = self._audio, self._preroll
        with tempfile.TemporaryDirectory(prefix="hush-preview-") as td:
            engine = make_engine(Settings(strength_db=strength_db, heavy=heavy), Path(td))
            wet = engine.process(audio, strength_db, cancel)
        return Section(info.path, start, audio[pre:], wet[pre:], strength_db)
