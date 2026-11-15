"""Command-line interface:  openhush-cli FILE... [--strength 30] [--mix 100]"""

from __future__ import annotations

import argparse
import signal
import sys
import time
from pathlib import Path

from . import tools
from .applog import setup_logging
from .engine import CancelToken
from .errors import CancelledError, HushError, friendly
from .pipeline import Settings, clean_file, default_workers


def _bar(frac: float, width: int = 30) -> str:
    filled = int(frac * width)
    return "█" * filled + "░" * (width - filled)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="openhush-cli", description="Remove background noise with DeepFilterNet3.")
    ap.add_argument("files", nargs="*", type=Path)
    ap.add_argument("--strength", type=float, default=30.0,
                    help="max noise reduction in dB, 6-100 (default 30; lower sounds more natural)")
    ap.add_argument("--mix", type=float, default=100.0,
                    help="percent of cleaned signal, 0-100 (default 100)")
    ap.add_argument("--workers", type=int, default=default_workers(), help="parallel engine processes")
    ap.add_argument("--heavy", action="store_true",
                    help="Heavy repair with Resemble Enhance (GPU only, much slower, may change the voice)")
    ap.add_argument("--install-heavy", action="store_true", help="install Heavy repair (~1.6 GB) and exit")
    args = ap.parse_args(argv)
    setup_logging()
    tools.migrate_previous_data()

    if not args.files and not args.install_heavy:
        ap.error("give at least one file")
    if not 6 <= args.strength <= 100:
        ap.error("--strength must be between 6 and 100")
    if not 0 <= args.mix <= 100:
        ap.error("--mix must be between 0 and 100")

    if args.install_heavy:
        from . import heavy
        try:
            heavy.install(lambda f, m: print(f"\r  {_bar(f)} {f:4.0%} {m:50}", end="", flush=True))
            print("\nHeavy repair is installed.")
            return 0
        except HushError as e:
            print(f"\nError: {e.message}\n  {e.details}", file=sys.stderr)
            return 2
    if args.heavy and args.mix != 100:
        print("Note: --mix is ignored with --heavy (the repaired voice can't be blended with the original).")

    try:
        tools.ffmpeg_paths()
        if not args.heavy and not tools.engine_ready():
            print("Downloading the DeepFilterNet3 engine (one time, ~28 MB)…", flush=True)
            tools.ensure_engine(lambda f: print(f"\r  {_bar(f)} {f:4.0%}", end="", flush=True))
            print()
    except HushError as e:
        print(f"Error: {e.message}\n  {e.details}" if e.details else f"Error: {e.message}", file=sys.stderr)
        return 2

    cancel = CancelToken()
    signal.signal(signal.SIGINT, lambda *_: cancel.cancel())
    settings = Settings(strength_db=args.strength, mix=args.mix / 100.0, workers=args.workers, heavy=args.heavy)
    failures = 0
    for i, f in enumerate(args.files, 1):
        name = f.name
        t0 = time.monotonic()

        def show(frac: float, msg: str) -> None:
            print(f"\r[{i}/{len(args.files)}] {name[:40]:40} {_bar(frac)} {frac:4.0%} {msg:22}", end="", flush=True)

        try:
            out = clean_file(f, settings, progress=show, cancel=cancel)
            print(f"\n    → {out}  ({time.monotonic() - t0:.1f}s)")
        except CancelledError:
            print("\nCancelled.")
            return 130
        except Exception as e:  # noqa: BLE001
            err = friendly(e)
            failures += 1
            print(f"\n    ✗ {err.message}" + (f"\n      {err.details.splitlines()[-1]}" if err.details else ""))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
