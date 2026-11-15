#!/bin/bash
# Assembles build/icon.icns: 16 and 32 px slots use the simplified mark (icon-small.png), larger ones the full mark.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf icon.iconset && mkdir icon.iconset
sips -z 16 16   icon-small.png --out icon.iconset/icon_16x16.png >/dev/null
sips -z 32 32   icon-small.png --out icon.iconset/icon_16x16@2x.png >/dev/null
sips -z 32 32   icon-small.png --out icon.iconset/icon_32x32.png >/dev/null
sips -z 64 64   icon.png --out icon.iconset/icon_32x32@2x.png >/dev/null
for s in 128 256 512; do
  sips -z $s $s icon.png --out icon.iconset/icon_${s}x${s}.png >/dev/null
  sips -z $((s*2)) $((s*2)) icon.png --out icon.iconset/icon_${s}x${s}@2x.png >/dev/null
done
iconutil -c icns icon.iconset -o icon.icns
rm -rf icon.iconset
echo "icon: built icon.icns"
