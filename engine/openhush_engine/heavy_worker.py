"""Resemble Enhance worker. Runs inside the separate "heavy" Python environment (never in the app's own).

Protocol: one JSON object per line on stdin -> one JSON line on stdout.
    {"in": "/path/in.wav", "out": "/path/out.wav", "lambd": 0.5}  ->  {"ok": true} | {"error": "..."}
Input/output are 48 kHz float WAVs; the output is mono (the voice), same length as the input.
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
import warnings
from pathlib import Path


def reply(obj) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def pick_device() -> str | None:
    import torch

    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", required=True)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    warnings.filterwarnings("ignore")

    try:
        import numpy as np
        import soundfile as sf
        import torch
        from resemble_enhance.enhancer.inference import enhance, load_enhancer
        from torchaudio.functional import resample
    except Exception as e:  # noqa: BLE001
        reply({"error": f"import failed: {e}"})
        return 1

    device = pick_device()
    if device is None:
        reply({"error": "no compatible GPU (needs Apple Silicon or NVIDIA CUDA)"})
        return 1
    weights = Path(args.weights)
    if args.selftest:
        reply({"ok": True, "device": device, "torch": torch.__version__})
        return 0
    try:
        load_enhancer(weights, device)
    except Exception as e:  # noqa: BLE001
        reply({"error": f"model failed to load: {e}"})
        return 1
    reply({"ready": True, "device": device})

    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            req = json.loads(line)
            x, sr = sf.read(req["in"], dtype="float32", always_2d=True)
            mono = x.mean(axis=1)
            y, osr = enhance(torch.from_numpy(np.ascontiguousarray(mono)), sr, device, nfe=32,
                             solver="midpoint", lambd=float(req["lambd"]), tau=0.5, run_dir=weights)
            y = resample(y.detach().cpu().float(), osr, sr).numpy()
            n = len(mono)
            y = y[:n] if len(y) >= n else np.concatenate([y, np.zeros(n - len(y), np.float32)])
            sf.write(req["out"], y, sr, subtype="FLOAT")
            reply({"ok": True})
        except Exception as e:  # noqa: BLE001
            traceback.print_exc(file=sys.stderr)
            reply({"error": f"{type(e).__name__}: {e}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
