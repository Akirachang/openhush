import os
import stat
import subprocess
import sys

import pytest

from openhush_engine import tools
from openhush_engine.engine import DeepFilter
from openhush_engine.errors import (EngineError, EngineMissingError, FfmpegMissingError, NoAudioError, OutputError,
                         UnsupportedFileError)
from openhush_engine.pipeline import clean_file
from openhush_engine.probe import probe


def test_unsupported_extension(workdir):
    with pytest.raises(UnsupportedFileError, match="isn't a supported file type"):
        probe(workdir("notes.txt"))


def test_fake_media_file(workdir):
    with pytest.raises(UnsupportedFileError, match="damaged or not a real MP4 file"):
        probe(workdir("fake.mp4"))


def test_video_without_audio(workdir):
    with pytest.raises(NoAudioError, match="has no audio track"):
        clean_file(workdir("noaudio.mp4"))


def test_missing_file(tmp_path):
    with pytest.raises(UnsupportedFileError, match="doesn't exist"):
        clean_file(tmp_path / "gone.wav")


def test_ffmpeg_missing(monkeypatch):
    monkeypatch.setattr(tools, "_which", lambda name: None)
    tools.ffmpeg_paths.cache_clear()
    try:
        with pytest.raises(FfmpegMissingError) as e:
            tools.ffmpeg_paths()
        assert "brew install ffmpeg" in e.value.details
    finally:
        monkeypatch.undo()
        tools.ffmpeg_paths.cache_clear()


def test_engine_missing(tmp_path):
    with pytest.raises(EngineMissingError, match="isn't installed"):
        DeepFilter(binary=tmp_path / "nope")


def test_engine_crash_is_reported_cleanly(workdir, tmp_path, monkeypatch):
    (tmp_path / "bin").mkdir()
    fake = tmp_path / "bin" / "deep-filter"
    fake.write_text("#!/bin/sh\necho 'model exploded' >&2\nexit 3\n")
    fake.chmod(0o755)
    monkeypatch.setenv("OPENHUSH_DEEP_FILTER", str(fake))
    src = workdir("noisy.flac")
    with pytest.raises(EngineError, match="engine failed") as e:
        clean_file(src)
    assert "model exploded" in e.value.details
    assert sorted(p.name for p in src.parent.iterdir()) == ["bin", "noisy.flac"], "no partial output left"


def test_read_only_folder(workdir):
    src = workdir("noisy.flac")
    folder = src.parent
    folder.chmod(stat.S_IRUSR | stat.S_IXUSR)
    try:
        with pytest.raises(OutputError, match="read-only"):
            clean_file(src)
    finally:
        folder.chmod(0o755)


def test_cli_prints_friendly_errors_not_tracebacks(workdir):
    files = [workdir("notes.txt"), workdir("fake.mp4"), workdir("noaudio.mp4")]
    res = subprocess.run([sys.executable, "-m", "openhush_engine.cli", *map(str, files)], capture_output=True, text=True)
    out = res.stdout + res.stderr
    assert res.returncode == 1
    assert "Traceback" not in out
    assert out.count("✗") == 3
