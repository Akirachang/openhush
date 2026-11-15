#!/bin/bash
# Freezes the Python engine into engine/dist/openhush-engine (bundled into OpenHush.app), and copies uv
# next to it so Heavy repair can be installed on Macs without developer tools.
set -euo pipefail
cd "$(dirname "$0")/../engine"
uv run pyinstaller --noconfirm --clean --log-level WARN --onedir --name openhush-engine \
  --add-data "$PWD/openhush_engine/heavy_worker.py:openhush_engine" \
  --collect-all _soundfile_data \
  --distpath dist --workpath build/pyinstaller --specpath build scripts/engine_entry.py
mkdir -p ../build/bin
cp "$(command -v uv || echo "$HOME/.local/bin/uv")" ../build/bin/uv
echo "engine: frozen ($(du -sh dist/openhush-engine | cut -f1)), uv copied"
