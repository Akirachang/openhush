from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MEDIA = ROOT / "test_media"


def ffprobe_json(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    return json.loads(out)


def audio_stream(path: Path) -> dict:
    return next(s for s in ffprobe_json(path)["streams"] if s["codec_type"] == "audio")


def decode(path: Path, sr: int = 48_000, mono: bool = True, timeline: bool = False) -> np.ndarray:
    """Decode the first audio track to float32. `timeline=True` pads/trims so sample 0 = time 0."""
    cmd = ["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0"]
    if timeline:
        cmd += ["-af", "aresample=async=1:first_pts=0"]
    cmd += ["-ar", str(sr)] + (["-ac", "1"] if mono else []) + ["-f", "f32le", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype="<f4").copy()


def frames(path: Path) -> int:
    """Exact decoded sample count at the file's native rate."""
    st = audio_stream(path)
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0", "-ac", "1", "-f", "f32le", "-"],
        capture_output=True, check=True,
    ).stdout
    return len(raw) // 4 if st else 0


def lag(ref: np.ndarray, sig: np.ndarray, max_lag: int = 48_000) -> int:
    """Samples by which `sig` lags `ref` (positive = sig is late)."""
    n = min(len(ref), len(sig))
    a, b = ref[:n], sig[:n]
    size = 1 << int(np.ceil(np.log2(2 * n)))
    c = np.fft.irfft(np.fft.rfft(b, size) * np.conj(np.fft.rfft(a, size)), size)
    c = np.concatenate([c[-max_lag:], c[: max_lag + 1]])
    return int(np.argmax(c)) - max_lag


def si_sdr(ref: np.ndarray, est: np.ndarray) -> float:
    n = min(len(ref), len(est))
    ref, est = ref[:n].astype(np.float64), est[:n].astype(np.float64)
    alpha = np.dot(est, ref) / np.dot(ref, ref)
    target = alpha * ref
    noise = est - target
    return 10 * np.log10(np.sum(target**2) / np.sum(noise**2))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def stream_md5(path: Path, spec: str = "0:v:0") -> str:
    """MD5 of a stream's packets as stored, without decoding. Identical iff the stream was copied."""
    return subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-map", spec, "-c", "copy", "-f", "md5", "-"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
