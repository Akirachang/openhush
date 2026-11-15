"""Decode → chunked DeepFilterNet3 → dry/wet mix → encode/mux, in constant memory.

Audio is streamed from an ffmpeg decoder as 48 kHz float PCM, cut into blocks
(each with a warm-up pre-roll so the model's recurrent state is settled), cleaned
by several deep-filter processes in parallel, crossfaded at the seams, mixed with
the dry signal, and streamed into an ffmpeg encoder that writes the final file
(for video: the picture is stream-copied, never re-encoded).
"""

from __future__ import annotations

import errno
import logging
import os
import shutil
import subprocess
import tempfile
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np

from . import tools
from .engine import SR, CancelToken, DeepFilter
from .errors import CancelledError, FfmpegError, HushError, OutputError, friendly
from .probe import MediaInfo, probe

log = logging.getLogger("openhush")

BLOCK_S = 30.0  # seconds of audio per deep-filter call
PREROLL_S = 4.0  # warm-up context before each block (discarded); the model adapts slowly
XFADE = 2_400  # 50 ms crossfade at block seams
XFADE_INCOHERENT = 12_000  # 250 ms equal-power crossfade for engines that regenerate the waveform
POSTROLL = 12_000  # 250 ms extra context after each block so its tail isn't affected by the end
RESAMPLE = "aresample=filter_size=64:phase_shift=10:linear_interp=1"

Progress = Callable[[float, str], None]


def default_workers() -> int:
    """Parallel engine processes. Each needs ~70-140 MB; 4 workers clean 70 min of stereo in ~85 s."""
    try:
        ram_gb = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 2**30
    except (ValueError, OSError):
        ram_gb = 8
    cores = os.cpu_count() or 2
    return max(1, min(4, (cores - 2) // 3, int(ram_gb // 4)))


@dataclass
class Settings:
    strength_db: float = 30.0  # deep-filter attenuation limit (6..100)
    mix: float = 1.0  # 1.0 = fully cleaned, 0.0 = original
    workers: int = field(default_factory=default_workers)
    heavy: bool = False  # Resemble Enhance "Heavy repair" instead of DeepFilterNet3

    def __post_init__(self) -> None:
        self.strength_db = float(min(100.0, max(0.0, self.strength_db)))
        self.mix = float(min(1.0, max(0.0, self.mix)))
        self.workers = max(1, int(self.workers))
        if self.heavy:
            self.mix = 1.0  # regenerated audio isn't phase-aligned with the original: blending would comb-filter
            self.workers = 1  # one GPU job at a time


def make_engine(settings: Settings, work_dir: Path):
    if settings.heavy:
        from .heavy import ResembleEngine
        return ResembleEngine(work_dir=work_dir)
    return DeepFilter(work_dir=work_dir)


def ensure_ready(settings: Settings) -> None:
    if settings.heavy:
        from .heavy import check_ready
        check_ready()
    else:
        tools.ensure_engine()


# ---------------------------------------------------------------- output naming


def output_path_for(src: Path) -> Path:
    """`<name>_clean.<ext>` next to the original; never an existing file."""
    base = src.with_name(f"{src.stem}_clean{src.suffix}")
    if not base.exists():
        return base
    n = 2
    while True:
        cand = src.with_name(f"{src.stem}_clean ({n}){src.suffix}")
        if not cand.exists():
            return cand
        n += 1


def _finalize(partial: Path, src: Path) -> Path:
    """Move the finished temp file into place without ever overwriting anything."""
    for _ in range(100):
        final = output_path_for(src)
        try:
            os.link(partial, final)  # atomic, fails if `final` exists
            partial.unlink()
            return final
        except FileExistsError:
            continue
        except OSError as e:
            if e.errno not in (errno.EPERM, errno.ENOTSUP, errno.EXDEV, errno.EMLINK, errno.EOPNOTSUPP):
                raise
            if final.exists():  # filesystem without hard links (e.g. exFAT)
                continue
            os.rename(partial, final)
            return final
    raise OutputError("Couldn't find a free file name for the cleaned file.")


# ---------------------------------------------------------------- encoder args


def _snap(value: int | None, choices: list[int], floor: int) -> int:
    want = max(floor, value or floor)
    return min(choices, key=lambda c: (abs(c - want), -c))


def _aac(bit_rate: int | None, channels: int) -> list[str]:
    floor = 192_000 if channels >= 2 else 128_000
    kbps = min(320_000, max(floor, bit_rate or floor)) // 1000
    enc = "aac_at" if tools.has_encoder("aac_at") else "aac"
    return [enc, "-b:a:0", f"{kbps}k"]


def _pcm(codec: str) -> str:
    return codec if codec in ("pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le") else (
        "pcm_s24le" if codec in ("pcm_s24be", "pcm_s32be", "pcm_f64le", "pcm_f32be") else "pcm_s16le"
    )


def audio_codec_args(info: MediaInfo) -> list[str]:
    """`-c:a:0 …` arguments that best match the original audio for the output container."""
    a = info.audio
    ext = info.path.suffix.lower()
    c = a.codec
    if ext == ".wav":
        args = [_pcm(c)]
    elif ext == ".flac":
        args = ["flac", "-sample_fmt:a:0", "s32" if (a.bits or 16) > 16 else "s16"]
    elif ext == ".mp3":
        kb = _snap(a.bit_rate, [128_000, 160_000, 192_000, 224_000, 256_000, 320_000], 192_000)
        args = ["libmp3lame", "-b:a:0", f"{kb // 1000}k"]
    elif c == "alac" and ext in (".m4a", ".mp4", ".mov", ".mkv"):
        args = ["alac", "-sample_fmt:a:0", "s32p" if (a.bits or 16) > 16 else "s16p"]
    elif ext == ".mov" and c.startswith("pcm_"):
        args = [_pcm(c)]
    elif ext == ".mkv" and c == "opus":
        kb = min(256_000, max(128_000, a.bit_rate or 128_000)) // 1000
        args = ["libopus", "-b:a:0", f"{kb}k"]
    elif ext == ".mkv" and c == "flac":
        args = ["flac"]
    elif ext == ".mkv" and c.startswith("pcm_"):
        args = [_pcm(c)]
    elif ext == ".mkv" and c in ("ac3", "eac3"):
        kb = min(640_000, max(192_000, a.bit_rate or 384_000)) // 1000
        args = [c, "-b:a:0", f"{kb}k"]
    else:  # .m4a/.mp4/.mov/.mkv default
        args = _aac(a.bit_rate, a.channels)
    out_sr = 48_000 if args[0] == "libopus" else a.sample_rate
    return ["-c:a:0", *args, "-ar:a:0", str(out_sr)]


def encoder_command(info: MediaInfo, out: Path) -> list[str]:
    a = info.audio
    pcm_in = ["-f", "f32le", "-ar", str(SR), "-ac", str(a.channels), "-i", "pipe:0"]
    cmd = [tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y"]
    if info.kind == "video":
        # input 0 = original file (picture, other tracks), input 1 = cleaned audio
        cmd += ["-i", str(info.path), *pcm_in]
        cmd += ["-map", "0:v", "-map", "1:a:0", "-map", "0:a?", "-map", f"-0:a:{a.order}", "-map", "0:s?"]
        if out.suffix.lower() == ".mkv":
            cmd += ["-map", "0:t?"]
        # Shift the cleaned audio so it starts exactly where the original track did
        # (-itsoffset is ignored for raw PCM pipes, so do it in the filter graph).
        offset = a.start_time - info.container_start
        shift = f"asetpts=PTS+{offset:.6f}/TB," if abs(offset) > 1e-6 else ""
        cmd += ["-c", "copy", "-filter:a:0", shift + RESAMPLE, *audio_codec_args(info)]
        # Don't use -map_metadata:s:… here: any per-stream mapping disables ffmpeg's default
        # copying of tags (e.g. language) for all the other streams.
        cmd += ["-map_metadata", "0", "-disposition:a:0", "default"]
        for k, v in a.tags.items():
            cmd += ["-metadata:s:a:0", f"{k}={v}"]
        if out.suffix.lower() in (".mp4", ".mov"):
            cmd += ["-movflags", "+use_metadata_tags"]
    else:
        cmd += [*pcm_in, "-i", str(info.path), "-map", "0:a:0"]
        if info.has_cover and out.suffix.lower() in (".mp3", ".m4a", ".flac"):
            cmd += ["-map", "1:v:0", "-c:v", "copy", "-disposition:v:0", "attached_pic"]
        cmd += ["-filter:a:0", RESAMPLE, *audio_codec_args(info), "-map_metadata", "1"]
    cmd += [str(out)]
    return cmd


def decoder_command(info: MediaInfo, start: float | None = None, duration: float | None = None) -> list[str]:
    cmd = [tools.ffmpeg(), "-hide_banner", "-nostdin", "-loglevel", "error"]
    if start:
        cmd += ["-ss", f"{start:.3f}"]
    if duration:
        cmd += ["-t", f"{duration:.3f}"]
    cmd += ["-i", str(info.path), "-map", f"0:a:{info.audio.order}", "-vn", "-sn", "-dn",
            "-ac", str(info.audio.channels)]
    if info.audio.sample_rate != SR:
        cmd += ["-af", RESAMPLE]
    cmd += ["-ar", str(SR), "-f", "f32le", "pipe:1"]
    return cmd


# ---------------------------------------------------------------- block streaming


class _PcmReader:
    """Reads interleaved float32 frames from a pipe into a rolling buffer."""

    def __init__(self, stream, channels: int):
        self.stream = stream
        self.ch = channels
        self.frame_bytes = 4 * channels
        self.buf = np.zeros((0, channels), dtype=np.float32)
        self.buf_start = 0  # absolute frame index of buf[0]
        self.eof = False
        self._leftover = b""

    @property
    def end(self) -> int:
        return self.buf_start + len(self.buf)

    def fill_to(self, frame: int) -> None:
        parts = [self.buf]
        have = self.end
        while have < frame and not self.eof:
            want = max(SR, frame - have) * self.frame_bytes
            data = self.stream.read(min(want, 8 * SR * self.frame_bytes))
            if not data:
                self.eof = True
                break
            data = self._leftover + data
            usable = len(data) - len(data) % self.frame_bytes
            self._leftover = data[usable:]
            arr = np.frombuffer(data[:usable], dtype="<f4").reshape(-1, self.ch)
            parts.append(arr)
            have += len(arr)
        if len(parts) > 1:
            self.buf = np.concatenate(parts)

    def get(self, a: int, b: int) -> np.ndarray:
        return self.buf[a - self.buf_start : b - self.buf_start]

    def drop_before(self, frame: int) -> None:
        k = frame - self.buf_start
        if k > 0:
            self.buf = self.buf[k:].copy()
            self.buf_start = frame


def stream_clean(
    reader: _PcmReader,
    write: Callable[[np.ndarray], None],
    engine,
    settings: Settings,
    cancel: CancelToken,
    on_frames: Callable[[int], None] | None = None,
) -> int:
    """Clean everything `reader` yields and pass it to `write` in order. Returns frames written."""
    coherent = getattr(engine, "coherent", True)
    B, P, T = int(BLOCK_S * SR), int(PREROLL_S * SR), POSTROLL
    F = XFADE if coherent else XFADE_INCOHERENT
    t = np.linspace(0, 1, F, dtype=np.float32)[:, None]
    if coherent:  # blocks are near-identical in the overlap: equal-gain
        fade_in = 0.5 - 0.5 * np.cos(np.pi * t)
        fade_out = 1.0 - fade_in
    else:  # uncorrelated waveforms: equal-power keeps the loudness steady
        fade_in, fade_out = np.sin(0.5 * np.pi * t), np.cos(0.5 * np.pi * t)
    mix = settings.mix

    pending: deque = deque()
    next_start = 0
    done_reading = False
    carry: np.ndarray | None = None
    written = 0

    with ThreadPoolExecutor(max_workers=settings.workers) as pool:
        try:
            while True:
                while not done_reading and len(pending) < settings.workers:
                    cancel.check()
                    s, e = next_start, next_start + B
                    reader.fill_to(e + F + T)
                    if reader.end <= s:  # nothing left (only if input was empty)
                        done_reading = True
                        break
                    last = reader.eof and reader.end <= e + F + T
                    if last:
                        e = reader.end
                    a, b = max(0, s - P), (e if last else e + F + T)
                    seg = reader.get(a, b).copy()
                    fut = pool.submit(engine.process, seg, settings.strength_db, cancel)
                    pending.append((fut, a, s, e, last))
                    next_start = e
                    done_reading = last
                if not pending:
                    break
                fut, a, s, e, last = pending.popleft()
                wet = fut.result()[s - a :]  # drop warm-up pre-roll → covers [s, b)
                if carry is not None:
                    wet[:F] = carry * fade_out + wet[:F] * fade_in
                core = wet[: e - s]
                carry = None if last else wet[e - s : e - s + F].copy()
                if mix < 1.0:
                    core = mix * core + (1.0 - mix) * reader.get(s, e)
                write(np.ascontiguousarray(core, dtype=np.float32))
                written += len(core)
                if on_frames:
                    on_frames(written)
                reader.drop_before(max(0, e - P))
        except BaseException:
            cancel.cancel()  # stop in-flight engine processes quickly
            raise
    return written


# ---------------------------------------------------------------- main entry point


def _tail(path: Path, n: int = 600) -> str:
    try:
        return path.read_text(errors="replace").strip()[-n:]
    except OSError:
        return ""


def _check_space(info: MediaInfo, folder: Path) -> None:
    try:
        size = info.path.stat().st_size
        free = shutil.disk_usage(folder).free
    except OSError:
        return
    need = int(size * 1.2) + 50 * 1024 * 1024
    if info.audio.codec.startswith("pcm_") or info.path.suffix.lower() in (".wav", ".flac"):
        need = int(size * 1.6) + 50 * 1024 * 1024
    if free < need:
        raise OutputError(
            f"Not enough disk space next to “{info.path.name}” "
            f"(about {need / 1e9:.1f} GB needed, {free / 1e9:.1f} GB free)."
        )


def clean_file(
    src: str | Path,
    settings: Settings | None = None,
    progress: Progress | None = None,
    cancel: CancelToken | None = None,
) -> Path:
    """Clean one file. Returns the path of the new `<name>_clean.<ext>` file."""
    settings = settings or Settings()
    cancel = cancel or CancelToken()
    src = Path(os.path.abspath(Path(src).expanduser()))  # keep symlink location: output goes next to it
    report = progress or (lambda f, m: None)

    try:
        report(0.0, "Reading file…")
        info = probe(src)
        ensure_ready(settings)
        engine_work = Path(tempfile.mkdtemp(prefix="hush-"))
        try:
            return _run(info, settings, report, cancel, engine_work)
        finally:
            shutil.rmtree(engine_work, ignore_errors=True)
    except HushError:
        raise
    except BrokenPipeError as e:
        if cancel.cancelled:
            raise CancelledError() from e
        raise FfmpegError("ffmpeg stopped unexpectedly while writing the output.", str(e)) from e
    except Exception as e:  # noqa: BLE001 - convert to a readable message
        log.exception("Unexpected error processing %s", src)
        raise friendly(e) from e


def _run(info: MediaInfo, settings: Settings, report: Progress, cancel: CancelToken, work: Path) -> Path:
    src = info.path
    folder = src.parent
    if not os.access(folder, os.W_OK):
        raise OutputError(f"Can't save next to “{src.name}” — that folder is read-only.")
    _check_space(info, folder)

    final_name = output_path_for(src)
    partial = folder / f".{final_name.stem}.partial{src.suffix}"
    engine = make_engine(settings, work)
    dec_err, enc_err = work / "decoder.log", work / "encoder.log"
    total = max(1, int(info.duration * SR))
    log.info("Cleaning %s (%s, %.1fs, %s %d Hz %dch) strength=%s mix=%s",
             src, info.kind, info.duration, info.audio.codec, info.audio.sample_rate,
             info.audio.channels, settings.strength_db, settings.mix)

    # Per-file token: an error here kills this file's processes without
    # cancelling the caller's token (so the rest of a batch keeps going).
    job = cancel.child()
    dec = enc = None
    ok = False
    try:
        with open(dec_err, "wb") as de, open(enc_err, "wb") as ee:
            dec = subprocess.Popen(decoder_command(info), stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=de, bufsize=0)
            job.register(dec)
            enc = subprocess.Popen(encoder_command(info, partial), stdin=subprocess.PIPE,
                                   stdout=subprocess.DEVNULL, stderr=ee)
            job.register(enc)

            def write(frames: np.ndarray) -> None:
                try:
                    enc.stdin.write(frames.tobytes())
                except (BrokenPipeError, OSError) as e:
                    if cancel.cancelled:
                        raise CancelledError() from e
                    enc.wait()
                    raise FfmpegError("Couldn't write the cleaned file.", _tail(enc_err)) from e

            label = "Cleaning video audio…" if info.kind == "video" else "Cleaning…"
            report(0.0, label)
            written = stream_clean(
                _PcmReader(dec.stdout, info.audio.channels), write, engine, settings, job,
                on_frames=lambda n: report(min(0.99, n / total), label),
            )
            dec.wait()
            job.check()
            if dec.returncode != 0:
                raise FfmpegError(f"Couldn't decode the audio in “{src.name}”.", _tail(dec_err))
            if written == 0:
                raise FfmpegError(f"No audio could be decoded from “{src.name}”.", _tail(dec_err))
            report(0.99, "Saving…")
            enc.stdin.close()
            enc.wait()
            job.check()
            if enc.returncode != 0:
                raise FfmpegError("Couldn't save the cleaned file.", _tail(enc_err))
        final = _finalize(partial, src)
        ok = True
        report(1.0, "Done")
        log.info("Wrote %s", final)
        return final
    finally:
        job.detach()
        for p in (dec, enc):
            if p is not None:
                if p.poll() is None:
                    p.kill()
                    p.wait()
                job.unregister(p)
                if p.stdin:
                    try:
                        p.stdin.close()
                    except OSError:
                        pass
                if p.stdout:
                    p.stdout.close()
        if not ok:
            partial.unlink(missing_ok=True)
