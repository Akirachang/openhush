"""Loudness overview of a whole file (for the waveform strip), computed in constant memory."""

from __future__ import annotations

import subprocess

import numpy as np

from . import tools
from .engine import CancelToken
from .errors import FfmpegError
from .probe import MediaInfo

PEAK_SR = 2_000  # speech energy is well represented at this rate, and decoding stays fast


def file_peaks(info: MediaInfo, buckets: int = 600, cancel: CancelToken | None = None) -> list[float]:
    """`buckets` values in 0..1 (RMS per slice of the file, normalised to the loudest slice)."""
    buckets = max(10, min(4000, int(buckets)))
    total = max(buckets, int(info.duration * PEAK_SR))
    per = -(-total // buckets)  # ceil
    cmd = [tools.ffmpeg(), "-hide_banner", "-nostdin", "-loglevel", "error", "-i", str(info.path),
           "-map", f"0:a:{info.audio.order}", "-vn", "-sn", "-dn", "-ac", "1", "-ar", str(PEAK_SR),
           "-f", "f32le", "pipe:1"]
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if cancel:
        cancel.register(proc)
    values: list[float] = []
    carry = np.zeros(0, dtype=np.float32)
    try:
        while True:
            data = proc.stdout.read(per * 4 * 64)
            if not data:
                break
            usable = len(data) - len(data) % 4
            x = np.concatenate([carry, np.frombuffer(data[:usable], dtype="<f4")])
            whole = len(x) // per * per
            if whole:
                values.extend(np.sqrt(np.mean(x[:whole].reshape(-1, per) ** 2, axis=1)).tolist())
            carry = x[whole:]
        if len(carry):
            values.append(float(np.sqrt(np.mean(carry**2))))
        proc.wait()
    finally:
        if cancel:
            cancel.unregister(proc)
        if proc.poll() is None:
            proc.kill()
    if cancel:
        cancel.check()
    if proc.returncode != 0 and not values:
        raise FfmpegError(f"Couldn't read the audio in “{info.path.name}”.",
                          proc.stderr.read().decode(errors="replace")[-400:])
    v = np.array(values[:buckets] + [0.0] * max(0, buckets - len(values)), dtype=np.float64)
    peak = v.max()
    if peak > 0:
        v = np.sqrt(v / peak)  # perceptual-ish scaling so quiet speech is still visible
    return [round(float(a), 3) for a in v]
