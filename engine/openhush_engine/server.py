"""OpenHush engine server — spawned by the desktop app, speaks newline-delimited JSON on stdin/stdout.

    request  {"id": 1, "method": "probe", "params": {"path": "/a/b.mp4"}}
    reply    {"id": 1, "result": {...}}   or   {"id": 1, "error": {"message": "...", "details": "..."}}
    event    {"event": "jobProgress", "data": {...}}

No network port is opened. When the app quits (stdin closes) every running job is cancelled and
all child processes are stopped.
"""

from __future__ import annotations

import itertools
import json
import logging
import os
import shutil
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import soundfile as sf

from . import __version__, heavy, tools
from .applog import setup_logging
from .engine import SR, CancelToken
from .errors import CancelledError, HushError, friendly
from .peaks import file_peaks
from .pipeline import Settings, clean_file, default_workers
from .preview import PREVIEW_S, PreviewRenderer
from .probe import SUPPORTED_EXTS, probe

log = logging.getLogger("openhush")
INLINE = {"hello", "cancelBatch", "cancelPreview", "shutdown"}


def _label(info) -> str:
    a = info.audio
    ch = {1: "mono", 2: "stereo"}.get(a.channels, f"{a.channels} ch")
    rate = f"{a.sample_rate / 1000:g} kHz"
    return " · ".join([info.path.suffix[1:].upper(), rate, ch])


class Server:
    def __init__(self, out) -> None:
        self.out = out
        self.running = True
        self._out_lock = threading.Lock()
        self._pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix="request")
        self._batch_cancel: CancelToken | None = None
        self._batch_thread: threading.Thread | None = None
        self._preview_cancel: CancelToken | None = None
        self._preview_lock = threading.Lock()
        self._renderer = PreviewRenderer()
        self.preview_dir = Path(tempfile.mkdtemp(prefix="openhush-preview-"))
        self._preview_seq = itertools.count(1)
        self._peaks_cache: dict[tuple, list[float]] = {}

    # ---------------------------------------------------------------- protocol

    def send(self, obj: dict) -> None:
        line = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
        with self._out_lock:
            self.out.write(line + "\n")
            self.out.flush()

    def event(self, name: str, **data) -> None:
        self.send({"event": name, "data": data})

    def dispatch(self, line: str) -> None:
        try:
            msg = json.loads(line)
            mid, method, params = msg.get("id"), str(msg.get("method")), msg.get("params") or {}
            if not isinstance(params, dict):
                raise ValueError("params must be an object")
        except (ValueError, AttributeError) as e:
            self.send({"id": None, "error": {"message": "Malformed request.", "details": str(e)}})
            return
        handler = getattr(self, f"m_{method}", None)
        if handler is None:
            self.send({"id": mid, "error": {"message": f"Unknown method {method!r}.", "details": ""}})
            return
        if method in INLINE:
            self._call(mid, handler, params)
        else:
            self._pool.submit(self._call, mid, handler, params)

    def _call(self, mid, handler, params: dict) -> None:
        try:
            self.send({"id": mid, "result": handler(**params)})
        except CancelledError:
            self.send({"id": mid, "error": {"message": "Cancelled.", "details": "", "cancelled": True}})
        except TypeError as e:  # wrong/missing params
            self.send({"id": mid, "error": {"message": "Bad request.", "details": str(e)}})
        except Exception as e:  # noqa: BLE001
            if not isinstance(e, HushError):
                log.exception("request failed")
            err = friendly(e)
            self.send({"id": mid, "error": {"message": err.message, "details": err.details}})

    # ---------------------------------------------------------------- methods

    def m_hello(self) -> dict:
        try:
            tools.ffmpeg_paths.cache_clear()
            tools.ffmpeg_paths()
            ffmpeg = {"ok": True, "message": "", "details": ""}
        except HushError as e:
            ffmpeg = {"ok": False, "message": e.message, "details": e.details}
        return {
            "version": __version__,
            "ffmpeg": ffmpeg,
            "engineReady": tools.engine_ready(),
            "heavy": self.m_heavyStatus(),
            "workers": default_workers(),
            "previewSeconds": PREVIEW_S,
            "previewDir": str(self.preview_dir),
            "supported": sorted(e[1:] for e in SUPPORTED_EXTS),
        }

    def m_heavyStatus(self) -> dict:
        gpu, reason = heavy.gpu_status()
        return {"gpu": gpu, "reason": reason, "installed": heavy.installed(), "downloadGB": heavy.DOWNLOAD_GB}

    def m_setupEngine(self) -> dict:
        tools.ensure_engine(lambda f: self.event("engineProgress", fraction=round(f, 3)))
        return {"engineReady": True}

    def m_installHeavy(self) -> dict:
        heavy.install(lambda f, m: self.event("heavyProgress", fraction=round(f, 3), message=m))
        return self.m_heavyStatus()

    def m_expandPaths(self, paths: list[str]) -> list[str]:
        """Folders become the supported media files inside them; plain files are kept as given."""
        out: list[str] = []
        for p in map(Path, paths):
            if p.is_dir():
                out += sorted(str(f) for f in p.rglob("*") if f.is_file() and not f.name.startswith(".")
                              and f.suffix.lower() in SUPPORTED_EXTS)
            else:
                out.append(str(p))
        return out

    def m_probe(self, path: str) -> dict:
        info = probe(path)
        a = info.audio
        return {
            "path": str(info.path), "name": info.path.name, "kind": info.kind, "duration": info.duration,
            "codec": a.codec, "sampleRate": a.sample_rate, "channels": a.channels, "label": _label(info),
            "sizeBytes": info.path.stat().st_size,
        }

    def m_peaks(self, path: str, buckets: int = 600) -> dict:
        info = probe(path)
        key = (str(info.path), info.path.stat().st_mtime_ns, int(buckets))
        if key not in self._peaks_cache:
            self._peaks_cache[key] = file_peaks(info, buckets)
        return {"peaks": self._peaks_cache[key], "duration": info.duration}

    def m_preview(self, path: str, start: float, strength: float, heavy: bool = False) -> dict:
        if self._preview_cancel:
            self._preview_cancel.cancel()  # a newer request supersedes the one in flight
        cancel = CancelToken()
        self._preview_cancel = cancel
        with self._preview_lock:
            cancel.check()
            info = probe(path)
            start = max(0.0, min(float(start), max(0.0, info.duration - PREVIEW_S)))
            section = self._renderer.render(info, start, float(strength), cancel, heavy=bool(heavy))
            n = next(self._preview_seq)
            folder = self.preview_dir / str(n)
            folder.mkdir()
            orig, clean = folder / "original.wav", folder / "cleaned.wav"
            sf.write(orig, section.original, SR, subtype="FLOAT")
            sf.write(clean, section.cleaned, SR, subtype="FLOAT")
            for old in self.preview_dir.iterdir():  # keep the last two renders only
                if old.name.isdigit() and int(old.name) < n - 1:
                    shutil.rmtree(old, ignore_errors=True)
            return {"original": str(orig), "cleaned": str(clean), "start": start,
                    "duration": len(section.original) / SR, "strength": float(strength), "heavy": bool(heavy)}

    def m_cancelPreview(self) -> dict:
        if self._preview_cancel:
            self._preview_cancel.cancel()
        return {"ok": True}

    def m_startBatch(self, jobs: list[dict], settings: dict) -> dict:
        if self._batch_thread and self._batch_thread.is_alive():
            raise HushError("Files are already being cleaned.")
        s = Settings(strength_db=float(settings.get("strength", 30)), mix=float(settings.get("mix", 100)) / 100,
                     heavy=bool(settings.get("heavy", False)))
        cancel = CancelToken()
        self._batch_cancel = cancel
        jobs = [(str(j["id"]), str(j["path"])) for j in jobs]
        self._batch_thread = threading.Thread(target=self._batch, args=(jobs, s, cancel), name="batch", daemon=True)
        self._batch_thread.start()
        return {"started": True, "count": len(jobs)}

    def _batch(self, jobs: list[tuple[str, str]], settings: Settings, cancel: CancelToken) -> None:
        log.info("batch of %d, strength=%s mix=%s heavy=%s", len(jobs), settings.strength_db, settings.mix,
                 settings.heavy)
        for jid, path in jobs:
            if cancel.cancelled:
                self.event("jobCancelled", id=jid)
                continue
            self.event("jobStarted", id=jid)
            try:
                out = clean_file(path, settings, cancel=cancel, progress=lambda f, m, jid=jid: self.event(
                    "jobProgress", id=jid, fraction=round(f, 4), message=m))
                self.event("jobDone", id=jid, output=str(out))
            except CancelledError:
                self.event("jobCancelled", id=jid)
            except Exception as e:  # noqa: BLE001
                err = friendly(e)
                log.warning("failed %s: %s | %s", path, err.message, err.details)
                self.event("jobFailed", id=jid, message=err.message, details=err.details)
        self.event("batchFinished", cancelled=cancel.cancelled)

    def m_cancelBatch(self) -> dict:
        if self._batch_cancel:
            self._batch_cancel.cancel()
        return {"ok": True}

    def m_shutdown(self) -> dict:
        self.running = False
        return {"ok": True}

    # ---------------------------------------------------------------- lifecycle

    def close(self) -> None:
        for token in (self._batch_cancel, self._preview_cancel):
            if token:
                token.cancel()
        if self._batch_thread:
            self._batch_thread.join(timeout=10)
        self._pool.shutdown(wait=False, cancel_futures=True)
        heavy.shutdown()
        shutil.rmtree(self.preview_dir, ignore_errors=True)


def main() -> int:
    setup_logging()
    tools.migrate_previous_data()
    protocol_out = sys.stdout
    sys.stdout = sys.stderr  # anything printed by accident must not corrupt the protocol
    server = Server(protocol_out)
    server.event("ready", version=__version__, pid=os.getpid())
    try:
        for line in sys.stdin:
            if line.strip():
                server.dispatch(line)
            if not server.running:
                break
    finally:
        server.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
