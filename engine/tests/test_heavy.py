"""Heavy repair (Resemble Enhance). Slow; skipped unless it's installed:  uv run pytest -m slow tests/test_heavy.py

Resemble regenerates the waveform, so sample-level comparisons don't apply: timing is checked on the
loudness envelope and quality with a log-spectral distance to the known clean speech.
"""

import subprocess
import threading

import numpy as np
import pytest

from helpers import MEDIA, audio_stream, decode, frames, stream_md5
from openhush_engine import heavy, pipeline
from openhush_engine.engine import SR, CancelToken
from openhush_engine.errors import CancelledError
from openhush_engine.pipeline import Settings, clean_file

pytestmark = [pytest.mark.slow,
              pytest.mark.skipif(not heavy.installed(), reason="Heavy repair not installed")]
HOP = 240  # 5 ms


def env(x):
    n = len(x) // HOP
    return np.sqrt((x[: n * HOP].reshape(n, HOP) ** 2).mean(1))


def env_lag_ms(ref, sig, max_ms=200):
    a, b = env(ref), env(sig)
    n = min(len(a), len(b))
    a, b = a[:n] - a[:n].mean(), b[:n] - b[:n].mean()
    m = max_ms // 5
    cs = [np.dot(a[max(0, -k): n - max(0, k)], b[max(0, k): n - max(0, -k)]) for k in range(-m, m + 1)]
    return (int(np.argmax(cs)) - m) * 5


def lsd(ref, x):
    def spec(y):
        f = np.abs(np.fft.rfft(np.lib.stride_tricks.sliding_window_view(y, 1024)[::256] * np.hanning(1024), axis=1))
        edges = (np.geomspace(100, 8000, 41) / (SR / 1024)).astype(int)
        return 20 * np.log10(np.stack([f[:, a:max(a + 1, b)].mean(1) for a, b in zip(edges[:-1], edges[1:])], 1) + 1e-6)
    n = min(len(ref), len(x))
    return float(np.sqrt(((spec(ref[:n]) - spec(x[:n])) ** 2).mean()))


def test_heavy_audio(workdir):
    src = workdir("noisy_44k_stereo.wav")
    out = clean_file(src, Settings(strength_db=60, heavy=True, mix=0.5))
    a_in, a_out = audio_stream(src), audio_stream(out)
    assert (a_out["sample_rate"], a_out["channels"]) == (a_in["sample_rate"], a_in["channels"])
    assert abs(frames(out) - frames(src)) <= 2
    clean, noisy, rep = decode(MEDIA / "clean_ref_48k.wav"), decode(src), decode(out)
    lag = env_lag_ms(clean, rep)
    print(f"\nheavy: envelope lag {lag:+d} ms, LSD noisy {lsd(clean, noisy):.1f} dB → repaired {lsd(clean, rep):.1f} dB")
    assert abs(lag) <= 20  # regenerated audio: no sample-exact timing (see test_heavy_video_sync)
    assert lsd(clean, rep) < lsd(clean, noisy) - 5
    st = decode(out, mono=False).reshape(-1, 2)
    assert np.allclose(st[:, 0], st[:, 1], atol=1e-4), "same repaired voice on both channels"


def test_heavy_video_sync(workdir):
    src = workdir("noisy_offset.mp4")
    out = clean_file(src, Settings(heavy=True))
    assert stream_md5(out) == stream_md5(src)
    lag = env_lag_ms(decode(src, timeline=True), decode(out, timeline=True))
    print(f"\nheavy video: A/V envelope offset {lag:+d} ms")
    # Regenerated audio has no sample-exact timing; ±20 ms is far below what's noticeable (~45 ms audio-early).
    assert abs(lag) <= 20


def test_heavy_seams_are_not_outliers(monkeypatch, tmp_path):
    """Blocks are regenerated independently (and Resemble is non-deterministic), so compare the
    chunked output with an unchunked run: the level difference at seams must be no worse than the
    difference found everywhere else."""
    import soundfile as sf
    x, _ = sf.read(MEDIA / "noisy_48k_mono.wav", dtype="float32", always_2d=True)
    engine = heavy.ResembleEngine(work_dir=tmp_path)

    class R(pipeline._PcmReader):
        def __init__(self):
            super().__init__(None, 1)
            self.buf, self.eof = x.copy(), True

        def fill_to(self, frame):
            pass

    def run(block_s):
        monkeypatch.setattr(pipeline, "BLOCK_S", block_s)
        out = []
        pipeline.stream_clean(R(), out.append, engine, Settings(heavy=True), CancelToken())
        return np.concatenate(out)[:, 0]

    block_s = 3.7  # 5 seams, so some land on speech rather than in pauses
    chunked, whole = run(block_s), run(100.0)
    assert len(chunked) == len(x)
    assert np.abs(np.diff(chunked)).max() < 0.5, "no clicks"

    e_c, e_w, e_ref = env(chunked), env(whole), env(decode(MEDIA / "clean_ref_48k.wav"))
    level = lambda e, i: 20 * np.log10(e[i - 20:i + 20].mean() + 1e-6)  # ±100 ms window
    speech = lambda i: e_ref[i - 20:i + 20].mean() > 0.02 * e_ref.max()
    seams = [int(k * block_s * 1000 / 5) for k in range(1, 6)]
    seam_d = [abs(level(e_c, i) - level(e_w, i)) for i in seams if speech(i)]
    other_d = [abs(level(e_c, i) - level(e_w, i)) for i in range(100, len(e_ref) - 100, 7)
               if speech(i) and all(abs(i - s) > 80 for s in seams)]
    print(f"\nseam level differences {np.round(seam_d, 1).tolist()} dB; elsewhere mean "
          f"{np.mean(other_d):.1f}, max {max(other_d):.1f} dB")
    assert seam_d, "at least one seam on speech"
    # A seam artifact would raise the seams systematically; random regeneration differences don't.
    assert np.mean(seam_d) <= np.mean(other_d) + 3.0
    assert max(seam_d) <= max(other_d)


def test_heavy_cancel_then_recover(tmp_path, test_media):
    src = tmp_path / "long.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-stream_loop", "5", "-i", str(test_media / "noisy_48k_mono.wav"),
                    "-c", "copy", str(src)], check=True)
    cancel = CancelToken()
    threading.Timer(15, cancel.cancel).start()
    with pytest.raises(CancelledError):
        clean_file(src, Settings(heavy=True), cancel=cancel)
    assert sorted(p.name for p in tmp_path.iterdir()) == ["long.wav"]
    short = tmp_path / "short.flac"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(test_media / "noisy.flac"), "-t", "5", str(short)],
                   check=True)
    assert clean_file(short, Settings(heavy=True)).exists(), "worker restarts after a cancel"
