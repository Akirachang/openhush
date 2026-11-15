"""Optional "Heavy repair" mode using Resemble Enhance.

It lives in its own Python environment (PyTorch etc. never touch the main app), installed on
first use into ~/Library/Application Support/OpenHush/heavy, and only on machines with a GPU it can use
(Apple Silicon via Metal/MPS). Audio is processed by a long-lived worker process that keeps the
model loaded; this module talks to it over stdin/stdout.
"""

from __future__ import annotations

import atexit
import hashlib
import json
import logging
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.request
from pathlib import Path
from typing import Callable

import numpy as np
import soundfile as sf

from .engine import SR, CancelToken
from .errors import CancelledError, EngineError, EngineMissingError, HushError
from .tools import APP_SUPPORT, LOG_DIR

log = logging.getLogger("openhush")

HEAVY_DIR = APP_SUPPORT / "heavy"
VENV = HEAVY_DIR / "venv"
PYTHON = VENV / "bin" / "python"
WEIGHTS = HEAVY_DIR / "weights" / "enhancer_stage2"
MARKER = HEAVY_DIR / "installed.json"
# In the packaged app the engine is frozen (PyInstaller); the worker script ships as a plain data file.
WORKER_SCRIPT = (Path(getattr(sys, "_MEIPASS", "")) / "openhush_engine" / "heavy_worker.py"
                 if getattr(sys, "frozen", False) else Path(__file__).with_name("heavy_worker.py"))

# Versions verified to run Resemble Enhance on Apple GPUs (its own pin, torch 2.1.1, fails on MPS).
PACKAGES = [
    "torch==2.8.0", "torchaudio==2.8.0", "numpy==1.26.4", "librosa==0.11.0", "omegaconf==2.4.0",
    "scipy==1.17.1", "soundfile==0.14.0", "matplotlib==3.11.2", "pandas==3.0.6", "celluloid==0.2.0",
    "ptflops==0.7.5", "rich==15.0.0", "tqdm==4.70.1", "resampy==0.4.3", "tabulate==0.10.0",
    "setuptools==84.2.1", "wheel==0.48.0",
]
RESEMBLE = "resemble-enhance==0.0.1"
DEEPSPEED = "deepspeed==0.20.0"  # imported by resemble even for inference; installed without CUDA ops
_HF = "https://huggingface.co/ResembleAI/resemble-enhance/resolve/main/enhancer_stage2"
WEIGHT_FILES = {
    "hparams.yaml": (717, "80c3f15bc5a5b2cacf2c698699a0f6599d62911c0d53e1d6dee895c0d7cbaeac"),
    "ds/G/latest": (7, "37a8eec1ce19687d132fe29051dca629d164e2c4958ba141d5f4133a33f0688f"),
    "ds/G/default/mp_rank_00_model_states.pt":
        (713_176_232, "f9d035f318de3e6d919bc70cf7ad7d32b4fe92ec5cbe0b30029a27f5db07d9d6"),
}
DOWNLOAD_GB = 1.6


def gpu_status() -> tuple[bool, str]:
    """(available, reason). Heavy repair is only offered with a GPU it can use."""
    if platform.system() == "Darwin" and platform.machine() == "arm64":
        return True, "Apple GPU (Metal)"
    return False, "Heavy repair needs a compatible GPU (an Apple Silicon Mac, M1 or newer)."


def installed() -> bool:
    return MARKER.exists() and PYTHON.exists() and all(
        (WEIGHTS / rel).is_file() and (WEIGHTS / rel).stat().st_size == size for rel, (size, _) in WEIGHT_FILES.items()
    )


def strength_to_lambd(strength_db: float) -> float:
    """Map the 6–100 dB Strength slider to Resemble's denoise strength (0.1–0.9)."""
    return round(0.1 + 0.8 * (min(100.0, max(6.0, strength_db)) - 6.0) / 94.0, 3)


# ------------------------------------------------------------------ installer


def _find_uv() -> str | None:
    for cand in (os.environ.get("UV"), shutil.which("uv"), str(Path.home() / ".local/bin/uv"),
                 "/opt/homebrew/bin/uv", "/usr/local/bin/uv"):
        if cand and Path(cand).is_file() and os.access(cand, os.X_OK):
            return cand
    return None


def _run(cmd: list[str], cancel: CancelToken, env: dict | None = None, what: str = "") -> None:
    log.info("heavy install: %s", " ".join(cmd))
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            env={**os.environ, **(env or {})})
    cancel.register(proc)
    try:
        out, _ = proc.communicate()
    finally:
        cancel.unregister(proc)
    cancel.check()
    if proc.returncode != 0:
        log.error("heavy install step failed: %s", out[-3000:])
        raise EngineMissingError(f"Installing Heavy repair failed while {what}.", out.strip()[-600:])


def _download(url: str, dest: Path, size: int, sha: str, cancel: CancelToken,
              progress: Callable[[int], None]) -> None:
    if dest.is_file() and dest.stat().st_size == size:
        progress(size)
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    h = hashlib.sha256()
    done = 0
    try:
        with urllib.request.urlopen(url, timeout=60) as resp, open(tmp, "wb") as f:
            while chunk := resp.read(1 << 20):
                cancel.check()
                f.write(chunk)
                h.update(chunk)
                done += len(chunk)
                progress(done)
        if h.hexdigest() != sha:
            raise EngineMissingError("The Heavy repair model download was corrupted. Please try again.",
                                     f"SHA-256 mismatch for {dest.name}")
        os.replace(tmp, dest)
    except OSError as e:
        raise EngineMissingError("Couldn't download the Heavy repair model. Check your internet connection.",
                                 str(e)) from e
    finally:
        tmp.unlink(missing_ok=True)


def install(progress: Callable[[float, str], None], cancel: CancelToken | None = None) -> None:
    """One-time setup (~1.6 GB): a Python 3.11 env with PyTorch + Resemble Enhance, and the model weights."""
    cancel = cancel or CancelToken()
    ok, reason = gpu_status()
    if not ok:
        raise EngineMissingError(reason)
    uv = _find_uv()
    if not uv:
        raise EngineMissingError("Installing Heavy repair needs 'uv'.",
                                 "Install it with:  curl -LsSf https://astral.sh/uv/install.sh | sh")
    HEAVY_DIR.mkdir(parents=True, exist_ok=True)
    MARKER.unlink(missing_ok=True)
    pip = [uv, "pip", "install", "--quiet", "--python", str(PYTHON)]

    progress(0.01, "Creating environment…")
    if not PYTHON.exists():
        _run([uv, "venv", "--quiet", "--python", "3.11", str(VENV)], cancel, what="creating its environment")
    progress(0.05, "Installing PyTorch (this takes a minute)…")
    _run(pip + PACKAGES, cancel, what="installing PyTorch")
    progress(0.30, "Installing Resemble Enhance…")
    _run(pip + ["--no-deps", RESEMBLE], cancel, what="installing Resemble Enhance")
    _run(pip + ["--no-build-isolation", DEEPSPEED], cancel, env={"DS_BUILD_OPS": "0"},
         what="installing DeepSpeed")

    total = sum(size for size, _ in WEIGHT_FILES.values())
    base = 0
    for rel, (size, sha) in WEIGHT_FILES.items():
        offset = base
        _download(f"{_HF}/{rel}?download=true", WEIGHTS / rel, size, sha, cancel,
                  lambda n: progress(0.35 + 0.6 * (offset + n) / total,
                                     f"Downloading model… {(offset + n) / 1e6:.0f} of {total / 1e6:.0f} MB"))
        base += size

    progress(0.97, "Checking it works…")
    res = subprocess.run([str(PYTHON), "-I", str(WORKER_SCRIPT), "--weights", str(WEIGHTS), "--selftest"],
                         capture_output=True, text=True)
    last = (res.stdout.strip().splitlines() or ["{}"])[-1]
    try:
        info = json.loads(last)
    except json.JSONDecodeError:
        info = {"error": last}
    if not info.get("ok"):
        raise EngineMissingError("Heavy repair was installed but couldn't start.",
                                 info.get("error", "") + "\n" + res.stderr[-400:])
    MARKER.write_text(json.dumps({"packages": PACKAGES + [RESEMBLE, DEEPSPEED], "device": info.get("device")}))
    progress(1.0, "Heavy repair is ready.")


# ------------------------------------------------------------------ worker


class _Worker:
    """A long-lived process with the model loaded (loading takes several seconds)."""

    def __init__(self) -> None:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        self._err = open(LOG_DIR / "heavy-worker.log", "ab")
        self.proc = subprocess.Popen(
            [str(PYTHON), "-I", str(WORKER_SCRIPT), "--weights", str(WEIGHTS)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self._err, text=True, bufsize=1,
            env={**os.environ, "PYTORCH_ENABLE_MPS_FALLBACK": "1"},
        )
        first = self._read()
        if not first.get("ready"):
            self.close()
            raise EngineError("Heavy repair couldn't start.", first.get("error", ""))
        self.device = first.get("device")

    def _read(self) -> dict:
        line = self.proc.stdout.readline()
        if not line:
            return {"error": "worker exited", "dead": True}
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            return {"error": line.strip()}

    @property
    def alive(self) -> bool:
        return self.proc.poll() is None

    def request(self, req: dict) -> dict:
        self.proc.stdin.write(json.dumps(req) + "\n")
        self.proc.stdin.flush()
        return self._read()

    def close(self) -> None:
        if self.proc.poll() is None:
            try:
                self.proc.stdin.close()
                self.proc.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                self.proc.kill()
        self._err.close()


_lock = threading.Lock()
_worker: _Worker | None = None


def shutdown() -> None:
    global _worker
    with _lock:
        if _worker is not None:
            _worker.close()
            _worker = None


atexit.register(shutdown)


class ResembleEngine:
    """Same interface as engine.DeepFilter. Output is the enhanced voice on every channel."""

    coherent = False  # regenerated waveform: phase doesn't match the input

    def __init__(self, work_dir: Path | None = None):
        ok, reason = gpu_status()
        if not ok:
            raise EngineMissingError(reason)
        if not installed():
            raise EngineMissingError("Heavy repair isn't installed yet.",
                                     "Turn on Heavy repair in the app once to install it (~1.6 GB).")
        self.work_dir = work_dir

    def process(self, block: np.ndarray, strength_db: float, cancel: CancelToken | None = None) -> np.ndarray:
        global _worker
        if block.ndim == 1:
            block = block[:, None]
        n, ch = block.shape
        if cancel:
            cancel.check()
        with tempfile.TemporaryDirectory(prefix="heavy-", dir=self.work_dir) as td:
            src, dst = Path(td) / "in.wav", Path(td) / "out.wav"
            sf.write(src, block, SR, subtype="FLOAT")
            with _lock:  # one GPU job at a time
                if _worker is None or not _worker.alive:
                    _worker = _Worker()
                w = _worker
                if cancel:
                    cancel.register(w.proc)  # cancelling kills the worker; it restarts next time
                try:
                    res = w.request({"in": str(src), "out": str(dst), "lambd": strength_to_lambd(strength_db)})
                except (BrokenPipeError, OSError):
                    res = {"error": "worker exited", "dead": True}
                finally:
                    if cancel:
                        cancel.unregister(w.proc)
                if res.get("dead"):
                    _worker = None
            if cancel:
                cancel.check()
            if not res.get("ok"):
                raise EngineError("Heavy repair failed on this file.", res.get("error", ""))
            voice, sr = sf.read(dst, dtype="float32")
        if sr != SR:
            raise EngineError("Heavy repair returned unexpected audio.", f"sr={sr}")
        voice = voice[:n] if len(voice) >= n else np.concatenate([voice, np.zeros(n - len(voice), np.float32)])
        return np.repeat(voice[:, None], ch, axis=1)


def check_ready() -> None:
    """Raise a friendly error if Heavy repair can't be used right now."""
    ok, reason = gpu_status()
    if not ok:
        raise EngineMissingError(reason)
    if not installed():
        raise HushError("Heavy repair isn't installed yet.",
                        "Turn on Heavy repair in the app once to install it (~1.6 GB).")


__all__ = ["CancelledError", "ResembleEngine", "check_ready", "gpu_status", "install", "installed",
           "shutdown", "strength_to_lambd"]
