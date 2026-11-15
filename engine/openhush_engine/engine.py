"""Thin wrapper around the DeepFilterNet3 `deep-filter` binary."""

from __future__ import annotations

import subprocess
import tempfile
import threading
from pathlib import Path

import numpy as np
import soundfile as sf

from . import tools
from .errors import CancelledError, EngineError, EngineMissingError

SR = 48_000
# deep-filter with --compensate-delay drops ~30 ms (fft_size - hop + lookahead) from the end;
# pad generously so the output always covers the whole block.
_TAIL_PAD = 4_800


class CancelToken:
    """Cooperative cancellation that also kills any registered subprocesses."""

    def __init__(self, parent: "CancelToken | None" = None) -> None:
        self._event = threading.Event()
        self._lock = threading.Lock()
        self._procs: set[subprocess.Popen] = set()
        self._children: set[CancelToken] = set()
        self._parent = parent

    def child(self) -> "CancelToken":
        """A token that is cancelled with this one, but can also be cancelled on its own."""
        c = CancelToken(parent=self)
        with self._lock:
            self._children.add(c)
        if self.cancelled:
            c.cancel()
        return c

    def detach(self) -> None:
        if self._parent is not None:
            with self._parent._lock:
                self._parent._children.discard(self)

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def cancel(self) -> None:
        self._event.set()
        with self._lock:
            procs = list(self._procs)
            children = list(self._children)
        for p in procs:
            if p.poll() is None:
                p.kill()
        for c in children:
            c.cancel()

    def check(self) -> None:
        if self._event.is_set():
            raise CancelledError()

    def register(self, proc: subprocess.Popen) -> None:
        with self._lock:
            self._procs.add(proc)
        if self._event.is_set() and proc.poll() is None:
            proc.kill()

    def unregister(self, proc: subprocess.Popen) -> None:
        with self._lock:
            self._procs.discard(proc)


class DeepFilter:
    def __init__(self, binary: Path | None = None, work_dir: Path | None = None):
        self.binary = Path(binary) if binary else tools.engine_path()
        if not self.binary.is_file():
            raise EngineMissingError(
                "The noise-removal engine isn't installed yet.",
                f"Expected it at {self.binary}. Launch the app once with internet access to download it.",
            )
        self.work_dir = work_dir

    def process(self, block: np.ndarray, strength_db: float, cancel: CancelToken | None = None) -> np.ndarray:
        """Denoise a (frames, channels) float32 block at 48 kHz. Output has the same shape, sample-aligned."""
        if block.ndim == 1:
            block = block[:, None]
        n, ch = block.shape
        if cancel:
            cancel.check()
        with tempfile.TemporaryDirectory(prefix="blk-", dir=self.work_dir) as td:
            src = Path(td) / "in.wav"
            out_dir = Path(td) / "out"
            with sf.SoundFile(src, "w", SR, ch, subtype="FLOAT") as f:  # block + zero tail, no extra copy
                f.write(block)
                f.write(np.zeros((_TAIL_PAD, ch), dtype=np.float32))
            cmd = [str(self.binary), "-D", "-a", f"{float(strength_db):g}", "-o", str(out_dir), str(src)]
            proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            if cancel:
                cancel.register(proc)
            try:
                _, err = proc.communicate()
            finally:
                if cancel:
                    cancel.unregister(proc)
            if cancel:
                cancel.check()
            out_file = out_dir / "in.wav"
            if proc.returncode != 0 or not out_file.exists():
                raise EngineError(
                    "The noise-removal engine failed on this file.",
                    err.decode("utf-8", "replace").strip()[-800:],
                )
            wet, sr = sf.read(out_file, dtype="float32", always_2d=True)
        if sr != SR or wet.shape[1] != ch:
            raise EngineError("The noise-removal engine returned unexpected audio.", f"sr={sr} ch={wet.shape[1]}")
        if len(wet) < n:
            wet = np.concatenate([wet, np.zeros((n - len(wet), ch), dtype=np.float32)])
        return wet[:n]
