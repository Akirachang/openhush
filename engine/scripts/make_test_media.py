"""Generate noisy-speech test media for OpenHush.

Clean speech comes from macOS `say`; noise (pink hiss + 60 Hz hum + low rumble)
is synthesised with numpy and mixed in at ~5 dB SNR, so we have a known clean
reference to score the output against.

    uv run python scripts/make_test_media.py            # short clips (~25 s)
    uv run python scripts/make_test_media.py --long     # + a 70-minute file
"""

from __future__ import annotations

import argparse
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 48_000
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test_media"

SENTENCES = [
    ("Samantha", "Hello, and welcome back to the channel. Today we are testing noise removal."),
    ("Daniel", "The quick brown fox jumps over the lazy dog, while the fan keeps humming."),
    ("Samantha", "If this works, my voice should sound clear and natural, not robotic."),
    ("Daniel", "Let's count to five. One. Two. Three. Four. Five."),
]


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def make_speech(tmp: Path) -> np.ndarray:
    parts = []
    gap = np.zeros(int(0.6 * SR), dtype=np.float32)
    for i, (voice, text) in enumerate(SENTENCES):
        aiff = tmp / f"s{i}.aiff"
        wav = tmp / f"s{i}.wav"
        run(["say", "-v", voice, "-o", str(aiff), text])
        run(["ffmpeg", "-y", "-i", str(aiff), "-ar", str(SR), "-ac", "1", "-c:a", "pcm_f32le", str(wav)])
        x, _ = sf.read(wav, dtype="float32")
        parts += [gap, x]
    parts.append(gap)
    speech = np.concatenate(parts)
    return (speech / np.max(np.abs(speech)) * 0.7).astype(np.float32)


def pink_noise(n: int, rng: np.random.Generator) -> np.ndarray:
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / SR)
    f[0] = f[1]
    x = np.fft.irfft(spec / np.sqrt(f), n)
    return x / np.std(x)


def make_noise(n: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    t = np.arange(n) / SR
    hiss = pink_noise(n, rng)
    hum = sum(np.sin(2 * np.pi * 60 * k * t + rng.uniform(0, 6.28)) / k for k in (1, 2, 3, 5))
    brown = np.cumsum(rng.standard_normal(n))
    brown -= np.convolve(brown, np.ones(4800) / 4800, mode="same")  # remove DC drift
    rumble = brown / np.std(brown)
    wobble = 1 + 0.3 * np.sin(2 * np.pi * 0.2 * t)  # fan-like slow modulation
    noise = hiss + 0.5 * hum / np.std(hum) + 0.7 * rumble * wobble
    return (noise / np.std(noise)).astype(np.float32)


def mix(speech: np.ndarray, noise: np.ndarray, snr_db: float) -> np.ndarray:
    active = np.abs(speech) > 0.01
    s_rms = np.sqrt(np.mean(speech[active] ** 2))
    n_rms = np.sqrt(np.mean(noise**2))
    noise = noise * (s_rms / n_rms) / (10 ** (snr_db / 20))
    out = speech + noise
    peak = np.max(np.abs(out))
    return (out / peak * 0.9 if peak > 0.9 else out).astype(np.float32)


def ff(*args: str) -> None:
    run(["ffmpeg", "-y", "-hide_banner", *args])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--long", action="store_true", help="also build a 70-minute file")
    args = ap.parse_args()
    OUT.mkdir(exist_ok=True)

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        speech = make_speech(tmp)
        n = len(speech)
        noisy_mono = mix(speech, make_noise(n, 1), snr_db=5)
        # stereo: same voice in both channels, partly decorrelated noise
        noisy_r = mix(speech, 0.6 * make_noise(n, 1) + 0.8 * make_noise(n, 2), snr_db=5)
        noisy_stereo = np.stack([noisy_mono, noisy_r], axis=1)

        sf.write(OUT / "clean_ref_48k.wav", speech, SR, subtype="FLOAT")
        sf.write(OUT / "noisy_48k_mono.wav", noisy_mono, SR, subtype="PCM_16")
        stereo48 = tmp / "stereo48.wav"
        sf.write(stereo48, noisy_stereo, SR, subtype="FLOAT")

        # audio formats
        ff("-i", str(stereo48), "-ar", "44100", "-c:a", "pcm_s16le", str(OUT / "noisy_44k_stereo.wav"))
        ff("-i", str(stereo48), "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "192k", str(OUT / "noisy.mp3"))
        ff("-i", str(OUT / "noisy_48k_mono.wav"), "-c:a", "aac_at", "-b:a", "128k", str(OUT / "noisy.m4a"))
        ff("-i", str(OUT / "noisy_48k_mono.wav"), "-c:a", "flac", "-sample_fmt", "s32", str(OUT / "noisy.flac"))

        # video formats: test pattern with a running timecode
        dur = f"{n / SR:.3f}"
        video = ["-f", "lavfi", "-i", f"testsrc2=size=1280x720:rate=30:duration={dur}"]
        venc = ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p"]
        ff(*video, "-i", str(stereo48), *venc, "-c:a", "aac_at", "-b:a", "192k", "-shortest", str(OUT / "noisy.mp4"))
        ff(*video, "-i", str(stereo48), *venc, "-c:a", "pcm_s16le", "-shortest", str(OUT / "noisy.mov"))
        ff(*video, "-i", str(stereo48), *venc, "-c:a", "libopus", "-b:a", "128k", "-shortest", str(OUT / "noisy.mkv"))
        # audio deliberately starts 0.3 s after the picture
        ff(*video, "-itsoffset", "0.3", "-i", str(stereo48), *venc, "-c:a", "aac_at", "-b:a", "192k",
           str(OUT / "noisy_offset.mp4"))
        ff(*video, *venc, str(OUT / "noaudio.mp4"))

        (OUT / "fake.mp4").write_text("this is not a video")
        (OUT / "notes.txt").write_text("not media")

        if args.long:
            minutes = 70
            ff("-stream_loop", "-1", "-i", str(stereo48), "-t", str(minutes * 60), "-c:a", "aac_at",
               "-b:a", "128k", str(OUT / "noisy_long_70min.m4a"))
            ff("-f", "lavfi", "-i", f"testsrc2=size=640x360:rate=30:duration={minutes * 60}",
               "-stream_loop", "-1", "-i", str(stereo48), "-t", str(minutes * 60),
               "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
               "-c:a", "aac_at", "-b:a", "128k", str(OUT / "noisy_long_70min.mp4"))

    print(f"Wrote test media to {OUT} (speech length {n / SR:.1f} s)")


if __name__ == "__main__":
    main()
