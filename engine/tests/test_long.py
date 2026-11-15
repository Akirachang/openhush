"""70-minute files: bounded memory, exact length, no sync drift.  Run with:  uv run pytest -m slow"""

import subprocess
import sys
import threading
import time

import numpy as np
import pytest

from helpers import MEDIA, ROOT, ffprobe_json, lag, stream_md5

pytestmark = pytest.mark.slow
LONG_AUDIO = MEDIA / "noisy_long_70min.m4a"
LONG_VIDEO = MEDIA / "noisy_long_70min.mp4"


@pytest.fixture(scope="module", autouse=True)
def long_media():
    if not LONG_VIDEO.exists():
        subprocess.run([sys.executable, str(ROOT / "scripts" / "make_test_media.py"), "--long"], check=True)


def run_with_peak_rss(cmd):
    """Run cmd; return peak RSS (MB) of its whole process tree (python + ffmpeg + engines)."""
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    peak = [0]

    def watch():
        while proc.poll() is None:
            rows = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,rss="], capture_output=True, text=True).stdout
            procs = {int(p): (int(pp), int(r)) for p, pp, r in (ln.split() for ln in rows.splitlines() if ln.strip())}
            tree, frontier = set(), {proc.pid}
            while frontier:
                tree |= frontier
                frontier = {p for p, (pp, _) in procs.items() if pp in frontier and p not in tree}
            peak[0] = max(peak[0], sum(procs[p][1] for p in tree if p in procs) // 1024)
            time.sleep(0.25)

    t = threading.Thread(target=watch)
    t.start()
    _, err = proc.communicate()
    t.join()
    assert proc.returncode == 0, err.decode()[-1000:]
    return peak[0]


def segment(path, t, dur=20):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", str(t), "-i", str(path), "-t", str(dur), "-map", "0:a:0",
                          "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, "<f4")


@pytest.mark.parametrize("src", [LONG_AUDIO, LONG_VIDEO], ids=["m4a", "mp4"])
def test_long_file(src, tmp_path):
    local = tmp_path / src.name
    local.symlink_to(src)
    t0 = time.monotonic()
    peak = run_with_peak_rss([sys.executable, "-m", "openhush_engine.cli", str(local)])
    elapsed = time.monotonic() - t0
    out = tmp_path / f"{src.stem}_clean{src.suffix}"
    print(f"\n{src.name}: {elapsed:.0f}s, peak memory {peak} MB")
    assert peak < 1200, "memory must stay bounded"

    dur = lambda p: float(next(s for s in ffprobe_json(p)["streams"] if s["codec_type"] == "audio")["duration"])
    assert abs(dur(out) - dur(src)) < 0.05
    for t in (10, 2100, 4170):  # start, middle, end: no drift
        assert abs(lag(segment(src, t), segment(out, t))) <= 48, f"drift at {t}s"
    if src.suffix == ".mp4":
        assert stream_md5(out) == stream_md5(src)
