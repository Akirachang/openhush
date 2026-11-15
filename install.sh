#!/bin/bash
# Installs (or reinstalls) the latest OpenHush:
#   curl -fsSL https://raw.githubusercontent.com/Akirachang/openhush/main/install.sh | bash
# After that, OpenHush updates itself from inside the app.
set -euo pipefail

REPO="Akirachang/openhush"
ASSET="OpenHush-mac-arm64.zip"
BASE="${OPENHUSH_RELEASE_BASE:-https://github.com/$REPO/releases/latest/download}"   # overridable for tests
DEST="${OPENHUSH_INSTALL_DIR:-/Applications}"

say() { printf '%s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ] || fail "OpenHush needs a Mac with Apple Silicon (M1 or newer)."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "Downloading OpenHush…"
curl -fL --progress-bar -o "$TMP/$ASSET" "$BASE/$ASSET" || fail "Couldn't download $ASSET."
curl -fsSL -o "$TMP/$ASSET.sha256" "$BASE/$ASSET.sha256" || fail "Couldn't download the checksum."
EXPECTED="$(awk '{print $1}' "$TMP/$ASSET.sha256")"
ACTUAL="$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')"
[ "$EXPECTED" = "$ACTUAL" ] || fail "The download didn't pass its integrity check. Please try again."

ditto -x -k "$TMP/$ASSET" "$TMP/app"
[ -d "$TMP/app/OpenHush.app" ] || fail "The download didn't contain OpenHush.app."
codesign --verify --deep --strict "$TMP/app/OpenHush.app" || fail "The downloaded app's signature is broken."

if [ ! -w "$DEST" ]; then
  DEST="$HOME/Applications"
  mkdir -p "$DEST"
fi

# Quit a running copy first ("is running" never launches it).
if [ -z "${OPENHUSH_INSTALL_DIR:-}" ] && osascript -e 'application "OpenHush" is running' 2>/dev/null | grep -q true; then
  say "Quitting OpenHush…"
  osascript -e 'tell application "OpenHush" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 100); do pgrep -f "OpenHush.app/Contents/MacOS/OpenHush" >/dev/null || break; sleep 0.1; done
fi

rm -rf "$DEST/OpenHush.app"
mv "$TMP/app/OpenHush.app" "$DEST/OpenHush.app"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$DEST/OpenHush.app/Contents/Info.plist")"
say "Installed OpenHush $VERSION in $DEST."

if ! command -v ffmpeg >/dev/null 2>&1 && [ ! -x /opt/homebrew/bin/ffmpeg ] && [ ! -x /usr/local/bin/ffmpeg ]; then
  say "Note: OpenHush needs ffmpeg. Install it with:  brew install ffmpeg"
fi

[ -n "${OPENHUSH_NO_OPEN:-}" ] || open "$DEST/OpenHush.app"
