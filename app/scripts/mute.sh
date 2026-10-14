#!/bin/bash
# Builds md-mute (native/mute/main.swift), the helper that reads the meeting app's own Mute /
# Unmute control through Accessibility, into app/resources/mute/<arch>/md-mute, which
# electron-builder ships as Resources/mute/<arch>/ (macOS only). It links only macOS's frameworks.
#
#   scripts/mute.sh            # this Mac's architecture
#   scripts/mute.sh arm64      # Apple Silicon
#   scripts/mute.sh x64        # Intel (cross-built on Apple Silicon)
#
# Needs Xcode's command line tools (swiftc). Written for macOS's bash 3.2.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
app="$(dirname "$here")"
src="${app}/native/mute/main.swift"
out_root="${app}/resources/mute"

arch="${1:-}"
if [ -z "$arch" ]; then
  case "$(uname -m)" in
    arm64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *) echo "mute.sh: unknown machine $(uname -m)" >&2; exit 2 ;;
  esac
fi
case "$arch" in
  arm64) target=arm64-apple-macos12.0; osx_arch=arm64 ;;
  x64) target=x86_64-apple-macos12.0; osx_arch=x86_64 ;;
  *) echo "usage: mute.sh [arm64|x64]" >&2; exit 2 ;;
esac

if [ "$(uname -s)" != "Darwin" ]; then
  echo "mute.sh: macOS only (meetings are macOS only)" >&2
  exit 2
fi
if ! command -v xcrun >/dev/null 2>&1; then
  echo "mute.sh: Xcode's command line tools are missing (xcode-select --install)" >&2
  exit 1
fi

dest="${out_root}/${arch}"
mkdir -p "$dest"
tmp="${dest}/md-mute.tmp"
xcrun swiftc -O -swift-version 5 -target "$target" -sdk "$(xcrun --sdk macosx --show-sdk-path)" -o "$tmp" "$src"

if ! lipo -archs "$tmp" | grep -qw "$osx_arch"; then
  echo "mute.sh: ${tmp} is not ${osx_arch}" >&2
  exit 1
fi
# Only macOS's own libraries: anything else would be missing on another Mac.
foreign="$(otool -L "$tmp" | tail -n +2 | awk '{print $1}' | grep -v -E '^(/usr/lib/|/System/Library/)' || true)"
if [ -n "$foreign" ]; then
  echo "mute.sh: md-mute links libraries macOS does not have:" >&2
  echo "$foreign" >&2
  rm -f "$tmp"
  exit 1
fi
strip -x "$tmp"
# strip invalidates the linker's signature; Apple Silicon runs no unsigned code.
codesign --force --sign - --identifier io.github.amntoppo.masterdeck.md-mute "$tmp"
mv -f "$tmp" "${dest}/md-mute"
echo "md-mute (${arch}): ${dest}/md-mute"
