#!/usr/bin/env bash
# Replace /Applications/MasterDeck.app with the freshly built one. Quit MasterDeck first.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)/dist/mac-$(uname -m | sed 's/x86_64/x64/')/MasterDeck.app"
[ -d "$SRC" ] || SRC="$(cd "$(dirname "$0")/.." && pwd)/dist/mac/MasterDeck.app"
if pgrep -f "/Applications/MasterDeck.app/Contents/MacOS/MasterDeck" >/dev/null; then
  echo "MasterDeck is running. Quit it (Cmd+Q) and run this again. Your sessions keep running." >&2
  exit 1
fi
rm -rf /Applications/MasterDeck.app
cp -R "$SRC" /Applications/
xattr -dr com.apple.quarantine /Applications/MasterDeck.app 2>/dev/null || true
echo "Installed $(defaults read /Applications/MasterDeck.app/Contents/Info.plist CFBundleShortVersionString) to /Applications/MasterDeck.app"
