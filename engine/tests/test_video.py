import subprocess

import pytest

from helpers import audio_stream, decode, ffprobe_json, lag, sha256, stream_md5
from openhush_engine.pipeline import Settings, clean_file

VIDEOS = ["noisy.mp4", "noisy.mov", "noisy.mkv", "noisy_offset.mp4"]


def _durations(path):
    info = ffprobe_json(path)
    out = {}
    for s in info["streams"]:
        # mkv has no per-stream duration; fall back to decoding the stream's packets
        d = s.get("duration") or s.get("tags", {}).get("DURATION")
        if isinstance(d, str) and ":" in d:
            h, m, sec = d.split(":")
            d = int(h) * 3600 + int(m) * 60 + float(sec)
        out[s["codec_type"]] = float(d)
    return out


@pytest.mark.parametrize("name", VIDEOS)
def test_video_roundtrip(workdir, name):
    src = workdir(name)
    before = sha256(src)
    out = clean_file(src, Settings(strength_db=30))

    assert out.name == f"{src.stem}_clean{src.suffix}"
    assert sha256(src) == before

    # picture is copied bit-for-bit (not re-encoded)
    assert stream_md5(out, "0:v:0") == stream_md5(src, "0:v:0")

    # the whole file decodes without a single error
    err = subprocess.run(["ffmpeg", "-v", "error", "-i", str(out), "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    assert err.strip() == ""

    a_in, a_out = audio_stream(src), audio_stream(out)
    assert a_out["codec_name"] == a_in["codec_name"]
    assert a_out["sample_rate"] == a_in["sample_rate"]
    assert a_out["channels"] == a_in["channels"]

    d_in, d_out = _durations(src), _durations(out)
    assert abs(d_out["video"] - d_in["video"]) < 1e-3

    # audio plays for the same span of the timeline (sample 0 = t 0), within one AAC frame
    orig = decode(src, timeline=True)
    clean = decode(out, timeline=True)
    assert abs(len(clean) - len(orig)) / 48_000 < 0.025, (len(orig), len(clean))

    # A/V sync: on that shared timeline the cleaned speech lines up with the original
    offset_ms = lag(orig, clean) / 48
    print(f"{name}: A/V offset vs original = {offset_ms:+.2f} ms")
    assert abs(offset_ms) < 10


def test_offset_audio_keeps_its_start(workdir):
    """The 0.3 s late audio must still start 0.3 s after the picture."""
    src = workdir("noisy_offset.mp4")
    out = clean_file(src)
    plain = decode(workdir("noisy.mp4"), timeline=True)
    assert abs(lag(plain, decode(out, timeline=True)) / 48 - 300) < 10


def test_extra_tracks_and_subtitles_preserved(tmp_path, test_media):
    srt = tmp_path / "subs.srt"
    srt.write_text("1\n00:00:01,000 --> 00:00:04,000\nHello there\n")
    src = tmp_path / "multi.mkv"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(test_media / "noisy.mkv"), "-i", str(test_media / "noisy.mp3"),
         "-i", str(srt), "-map", "0:v", "-map", "0:a", "-map", "1:a", "-map", "2:s",
         "-c:v", "copy", "-c:a", "copy", "-c:s", "srt",
         "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=jpn", str(src)],
        check=True,
    )
    out = clean_file(src)
    streams = ffprobe_json(out)["streams"]
    kinds = [s["codec_type"] for s in streams]
    assert kinds == ["video", "audio", "audio", "subtitle"]
    assert streams[1]["tags"].get("language") == "eng"
    assert streams[2]["tags"].get("language") == "jpn"
    assert stream_md5(out, "0:a:1") == stream_md5(src, "0:a:1"), "second audio track copied untouched"
    assert stream_md5(out, "0:a:0") != stream_md5(src, "0:a:0"), "first audio track was cleaned"
