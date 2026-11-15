import numpy as np
import pytest
import soundfile as sf

from helpers import MEDIA, audio_stream, decode, frames, lag, sha256, si_sdr
from openhush_engine import pipeline
from openhush_engine.engine import SR, CancelToken, DeepFilter
from openhush_engine.pipeline import Settings, clean_file, output_path_for

AUDIO = ["noisy_48k_mono.wav", "noisy_44k_stereo.wav", "noisy.mp3", "noisy.m4a", "noisy.flac"]


@pytest.mark.parametrize("name", AUDIO)
def test_audio_roundtrip(workdir, name):
    src = workdir(name)
    before = sha256(src)
    out = clean_file(src, Settings(strength_db=30))

    assert out == src.with_name(f"{src.stem}_clean{src.suffix}")
    assert out.exists() and out.stat().st_size > 0
    assert sha256(src) == before, "original must not change"
    assert not list(src.parent.glob(".*partial*")), "no temp files left behind"

    a_in, a_out = audio_stream(src), audio_stream(out)
    assert a_out["codec_name"] == a_in["codec_name"]
    assert a_out["sample_rate"] == a_in["sample_rate"]
    assert a_out["channels"] == a_in["channels"]

    n_in, n_out = frames(src), frames(out)
    sr = int(a_in["sample_rate"])
    if src.suffix in (".wav", ".flac"):
        assert abs(n_out - n_in) <= 2, (n_in, n_out)
    else:  # lossy codecs: allow encoder padding
        assert abs(n_out - n_in) / sr <= 0.05, (n_in, n_out)


def test_cleaning_improves_and_stays_aligned(workdir):
    src = workdir("noisy_48k_mono.wav")
    clean = decode(MEDIA / "clean_ref_48k.wav")
    noisy = decode(src)
    out = decode(clean_file(src, Settings(strength_db=100)))
    assert lag(noisy, out) == 0
    gain = si_sdr(clean, out) - si_sdr(clean, noisy)
    print(f"SI-SDR noisy={si_sdr(clean, noisy):.1f} dB  cleaned={si_sdr(clean, out):.1f} dB  (+{gain:.1f})")
    assert gain > 6


def test_mix_zero_returns_original(workdir):
    src = workdir("noisy_48k_mono.wav")
    noisy = decode(src)
    out = decode(clean_file(src, Settings(mix=0.0)))
    assert np.max(np.abs(out[: len(noisy)] - noisy[: len(out)])) < 1e-3  # 16-bit requantisation only


def test_strength_controls_reduction(workdir):
    src = workdir("noisy_48k_mono.wav")
    noisy = decode(src)
    rms = lambda x: float(np.sqrt(np.mean(x**2)))
    diffs = {}
    for s in (6, 30, 100):
        out = decode(clean_file(src, Settings(strength_db=s)))
        diffs[s] = rms(noisy - out[: len(noisy)])
    assert diffs[6] < diffs[30] < diffs[100], diffs


def test_block_seams_match_unchunked(monkeypatch, tmp_path):
    """Chunked processing (with warm-up + crossfade) ≈ processing the whole file in one go."""
    x, _ = sf.read(MEDIA / "noisy_48k_mono.wav", dtype="float32", always_2d=True)
    engine = DeepFilter(work_dir=tmp_path)
    full = engine.process(x, 30)

    monkeypatch.setattr(pipeline, "BLOCK_S", 4.0)  # 20 s file → 6 blocks, 5 seams

    class FakeReader(pipeline._PcmReader):
        def __init__(self):
            super().__init__(None, 1)
            self.buf, self.eof = x.copy(), True

        def fill_to(self, frame):
            pass

    chunks = []
    pipeline.stream_clean(FakeReader(), chunks.append, engine, Settings(strength_db=30, workers=3), CancelToken())
    chunked = np.concatenate(chunks)
    assert chunked.shape == x.shape

    rel = lambda e, r: 10 * np.log10(np.mean(e**2) / np.mean(r**2))
    seams = np.zeros(len(x), bool)
    for k in range(1, 6):
        seams[k * 4 * SR - 4800 : k * 4 * SR + 4800] = True
    seams[:SR] = False
    body = ~seams
    body[:SR] = False  # both start cold; skip the first second
    near, mid = rel((chunked - full)[seams], full[seams]), rel((chunked - full)[body], full[body])
    print(f"chunked vs unchunked: near seams {near:.1f} dB, mid-block {mid:.1f} dB")
    assert mid < -24
    assert near < mid + 3, "seams must not be noticeably worse than the rest"

    # quality vs. the known clean speech is not worse than processing in one go
    clean, _ = sf.read(MEDIA / "clean_ref_48k.wav", dtype="float32")
    assert si_sdr(clean[SR:], chunked[SR:, 0]) > si_sdr(clean[SR:], full[SR:, 0]) - 0.5

    # no clicks: no sample-to-sample jump bigger than anywhere in the unchunked output
    assert np.abs(np.diff(chunked[:, 0])).max() < 1.5 * np.abs(np.diff(full[:, 0])).max() + 1e-3


def test_never_overwrites(workdir):
    src = workdir("noisy.flac")
    first = clean_file(src)
    second = clean_file(src)
    assert first.name == "noisy_clean.flac"
    assert second.name == "noisy_clean (2).flac"
    assert output_path_for(src).name == "noisy_clean (3).flac"
