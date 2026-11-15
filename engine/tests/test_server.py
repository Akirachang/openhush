"""The JSON-lines engine server, driven exactly the way the desktop app drives it."""

import json
import os
import queue
import subprocess
import sys
import threading
import time

import pytest
import soundfile as sf


class Client:
    def __init__(self):
        # OPENHUSH_ENGINE_BIN runs the same tests against the frozen binary that ships in OpenHush.app
        cmd = [os.environ["OPENHUSH_ENGINE_BIN"]] if os.environ.get("OPENHUSH_ENGINE_BIN") else \
            [sys.executable, "-m", "openhush_engine.server"]
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self.replies: dict = {}
        self.events: "queue.Queue[dict]" = queue.Queue()
        self.all_events: list[dict] = []
        self._cv = threading.Condition()
        self._ids = iter(range(1, 10**6))
        threading.Thread(target=self._read, daemon=True).start()
        ready = self.next_event("ready")
        assert ready["data"]["version"]

    def _read(self):
        for line in self.proc.stdout:
            msg = json.loads(line)  # every line must be valid JSON
            if "event" in msg:
                self.all_events.append(msg)
                self.events.put(msg)
            else:
                with self._cv:
                    self.replies[msg.get("id")] = msg
                    self._cv.notify_all()

    def send_raw(self, text):
        self.proc.stdin.write(text + "\n")
        self.proc.stdin.flush()

    def request(self, method, **params):
        mid = next(self._ids)
        self.send_raw(json.dumps({"id": mid, "method": method, "params": params}))
        return mid

    def wait(self, mid, timeout=120):
        deadline = time.monotonic() + timeout
        with self._cv:
            while mid not in self.replies:
                left = deadline - time.monotonic()
                assert left > 0, f"no reply to {mid}"
                self._cv.wait(left)
            return self.replies.pop(mid)

    def call(self, method, **params):
        reply = self.wait(self.request(method, **params))
        assert "result" in reply, reply
        return reply["result"]

    def next_event(self, name, timeout=120):
        deadline = time.monotonic() + timeout
        while True:
            msg = self.events.get(timeout=max(0.1, deadline - time.monotonic()))
            if msg["event"] == name:
                return msg

    def close(self):
        if self.proc.poll() is None:
            self.proc.stdin.close()
            self.proc.wait(timeout=15)


@pytest.fixture
def client():
    c = Client()
    yield c
    c.close()


def test_hello(client):
    h = client.call("hello")
    assert h["ffmpeg"]["ok"] and h["engineReady"]
    assert "mp4" in h["supported"] and h["previewSeconds"] == 15
    assert set(h["heavy"]) >= {"gpu", "installed", "reason"}


def test_probe_ok_and_friendly_error(client, workdir):
    info = client.call("probe", path=str(workdir("noisy.mp4")))
    assert info["kind"] == "video" and info["channels"] == 2 and info["label"] == "MP4 · 48 kHz · stereo"
    reply = client.wait(client.request("probe", path=str(workdir("notes.txt"))))
    assert reply["error"]["message"].startswith("“notes.txt” isn't a supported file type")


def test_peaks(client, workdir):
    res = client.call("peaks", path=str(workdir("noisy.mp3")), buckets=300)
    p = res["peaks"]
    assert len(p) == 300 and max(p) == 1.0 and min(p) >= 0


def test_preview_files_and_supersede(client, workdir):
    src = str(workdir("noisy_44k_stereo.wav"))
    first = client.request("preview", path=src, start=2.0, strength=30)
    second = client.request("preview", path=src, start=2.0, strength=80)
    r1, r2 = client.wait(first), client.wait(second)
    assert "result" in r2
    assert "result" in r1 or r1["error"].get("cancelled"), r1
    res = r2["result"]
    o, c = sf.info(res["original"]), sf.info(res["cleaned"])
    assert o.samplerate == c.samplerate == 48000 and o.channels == c.channels == 2
    assert o.frames == c.frames == 15 * 48000
    assert res["strength"] == 80


def test_batch_with_a_bad_file(client, workdir):
    good, bad = workdir("noisy.flac", "notes.txt")
    client.call("startBatch", jobs=[{"id": "a", "path": str(good)}, {"id": "b", "path": str(bad)}],
                settings={"strength": 30, "mix": 100})
    done = client.next_event("jobDone")
    failed = client.next_event("jobFailed")
    fin = client.next_event("batchFinished")
    assert done["data"]["id"] == "a" and done["data"]["output"].endswith("noisy_clean.flac")
    assert failed["data"]["id"] == "b" and "supported" in failed["data"]["message"]
    assert fin["data"]["cancelled"] is False
    names = [e["event"] for e in client.all_events if e["data"].get("id") == "a"]
    assert names[0] == "jobStarted" and "jobProgress" in names and names[-1] == "jobDone"


def test_cancel_batch(client, tmp_path, test_media):
    src = tmp_path / "long.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-stream_loop", "17", "-i", str(test_media / "noisy_48k_mono.wav"),
                    "-c", "copy", str(src)], check=True)
    client.call("startBatch", jobs=[{"id": "x", "path": str(src)}], settings={})
    client.next_event("jobProgress")
    client.call("cancelBatch")
    assert client.next_event("jobCancelled")["data"]["id"] == "x"
    assert client.next_event("batchFinished")["data"]["cancelled"] is True
    assert sorted(p.name for p in tmp_path.iterdir()) == ["long.wav"]


def test_bad_input_does_not_kill_the_server(client):
    client.send_raw("this is not json")
    assert client.wait(None)["error"]["message"] == "Malformed request."
    assert client.wait(client.request("nope"))["error"]["message"].startswith("Unknown method")
    assert client.wait(client.request("probe"))["error"]["message"] == "Bad request."
    assert client.call("hello")["engineReady"]


def test_exits_when_app_closes_stdin(client):
    client.proc.stdin.close()
    assert client.proc.wait(timeout=15) == 0
