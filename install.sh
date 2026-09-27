#!/usr/bin/env bash
# Install (or update) MasterDeck on macOS from the latest GitHub release:
#
#   curl -fsSL https://raw.githubusercontent.com/amntoppo/MasterDeck-Terminal/main/install.sh | bash
#
# The app is not signed by Apple. A DMG downloaded in a browser is marked as coming from the
# internet, and macOS then blocks it until you allow it in System Settings → Privacy & Security.
# curl does not add that mark, and this script clears any left over, so MasterDeck opens at once.
#
# Options (environment): MASTERDECK_VERSION=0.2.0 for a given release instead of the latest;
# MASTERDECK_APP_DIR=/some/dir to install elsewhere; MASTERDECK_NO_OPEN=1 to not open it after.
set -euo pipefail

REPO="amntoppo/MasterDeck-Terminal"
say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'MasterDeck install: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "this installer is for macOS. On Windows, download 'MasterDeck Setup <version>.exe' from https://github.com/$REPO/releases"

case "$(uname -m)" in
  arm64) suffix="-arm64.dmg"; chip="Apple silicon" ;;
  x86_64) suffix=".dmg"; chip="Intel" ;;
  *) die "unsupported Mac: $(uname -m)" ;;
esac

if [ -n "${MASTERDECK_VERSION:-}" ]; then
  api="https://api.github.com/repos/$REPO/releases/tags/v${MASTERDECK_VERSION#v}"
else
  api="https://api.github.com/repos/$REPO/releases/latest"
fi
release="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$api")" || die "could not read the release from GitHub ($api)"

# The DMG for this chip: arm64 ends in -arm64.dmg; Intel is the other .dmg.
urls="$(printf '%s\n' "$release" | grep -o '"browser_download_url": *"[^"]*\.dmg"' | sed 's/.*"\(https[^"]*\)"/\1/')"
if [ "$suffix" = "-arm64.dmg" ]; then
  url="$(printf '%s\n' "$urls" | grep -- '-arm64\.dmg$' | head -1)"
else
  url="$(printf '%s\n' "$urls" | grep -v -- '-arm64\.dmg$' | head -1)"
fi
[ -n "$url" ] || die "no DMG for ${chip} in that release"
version="$(printf '%s\n' "$release" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"v\{0,1\}\([^"]*\)"/\1/')"

dest="${MASTERDECK_APP_DIR:-/Applications}"
if [ -z "${MASTERDECK_APP_DIR:-}" ] && [ ! -w "$dest" ]; then dest="$HOME/Applications"; fi
mkdir -p "$dest"

# Only the copy being replaced matters.
if pgrep -f "$dest/MasterDeck.app/Contents/MacOS/MasterDeck" >/dev/null 2>&1; then
  die "MasterDeck is running. Quit it (Cmd+Q; your Claude sessions keep running) and run this again."
fi

tmp="$(mktemp -d)"
mnt="$tmp/mnt"
cleanup() { hdiutil detach "$mnt" -quiet >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT

say "Downloading MasterDeck ${version} for ${chip}…"
curl -fL --progress-bar -o "$tmp/MasterDeck.dmg" "$url" || die "download failed: $url"

mkdir -p "$mnt"
hdiutil attach "$tmp/MasterDeck.dmg" -nobrowse -readonly -quiet -mountpoint "$mnt" || die "could not open the DMG"
[ -d "$mnt/MasterDeck.app" ] || die "the DMG has no MasterDeck.app"

say "Installing to ${dest}/MasterDeck.app…"
rm -rf "$dest/MasterDeck.app"
cp -R "$mnt/MasterDeck.app" "$dest/"
# Clear the "downloaded from the internet" mark, in case anything set it.
xattr -dr com.apple.quarantine "$dest/MasterDeck.app" 2>/dev/null || true

say "MasterDeck $version is installed."
if [ -z "${MASTERDECK_NO_OPEN:-}" ]; then open "$dest/MasterDeck.app"; fi
