#!/bin/bash
# Builds whisper-cli (whisper.cpp's command line tool) for meetings' transcription, into
# app/resources/whisper/<arch>/whisper-cli, which electron-builder ships as Resources/whisper/<arch>/
# (macOS only). Static: the binary links only macOS's own libraries and frameworks.
#
#   scripts/whisper.sh            # this Mac's architecture
#   scripts/whisper.sh arm64      # Apple Silicon, with Metal
#   scripts/whisper.sh x64        # Intel (cross-built on Apple Silicon), CPU only
#
# Needs git, cmake and Xcode's command line tools. Written for macOS's bash 3.2.
set -euo pipefail

# A pinned release, checked by its commit: a moved tag stops the build instead of shipping other code.
WHISPER_TAG="v1.9.4"
WHISPER_COMMIT="927cfce34f31707e17f2bff35c349632fb9e2c3a"
WHISPER_REPO="https://github.com/ggml-org/whisper.cpp.git"

here="$(cd "$(dirname "$0")" && pwd)"
app="$(dirname "$here")"
out_root="${app}/resources/whisper"
src="${out_root}/.src"

arch="${1:-}"
if [ -z "$arch" ]; then
  case "$(uname -m)" in
    arm64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *) echo "whisper.sh: unknown machine $(uname -m)" >&2; exit 2 ;;
  esac
fi
case "$arch" in
  arm64) osx_arch=arm64; metal=ON; cpu_flags="" ;;
  # ponytail: Intel builds assume AVX2/FMA/F16C (Haswell, 2013 and later); a Mac without AVX2
  # would need GGML_CPU_ALL_VARIANTS, which loads CPU backends as dylibs (not static).
  x64) osx_arch=x86_64; metal=OFF; cpu_flags="-DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON" ;;
  *) echo "usage: whisper.sh [arm64|x64]" >&2; exit 2 ;;
esac

if [ "$(uname -s)" != "Darwin" ]; then
  echo "whisper.sh: macOS only (meetings are macOS only)" >&2
  exit 2
fi
for tool in git cmake xcrun; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "whisper.sh: ${tool} is missing (cmake: brew install cmake)" >&2
    exit 1
  fi
done

if [ ! -d "${src}/.git" ]; then
  rm -rf "$src"
  git clone --quiet --depth 1 --branch "$WHISPER_TAG" "$WHISPER_REPO" "$src"
else
  git -C "$src" fetch --quiet --depth 1 origin "refs/tags/${WHISPER_TAG}:refs/tags/${WHISPER_TAG}"
  git -C "$src" checkout --quiet --force "$WHISPER_TAG"
fi
got="$(git -C "$src" rev-parse HEAD)"
if [ "$got" != "$WHISPER_COMMIT" ]; then
  echo "whisper.sh: ${WHISPER_TAG} is ${got}, expected ${WHISPER_COMMIT}" >&2
  exit 1
fi

build="${out_root}/.build-${arch}"
rm -rf "$build"
# Static libraries, no SDL/curl, no native CPU tuning (the binary runs on other Macs), and the
# Metal shaders embedded in the binary so nothing is loaded from beside it.
# shellcheck disable=SC2086
cmake -S "$src" -B "$build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES="$osx_arch" \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0 \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_NATIVE=OFF \
  -DGGML_METAL="$metal" \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DGGML_BLAS=ON \
  -DGGML_OPENMP=OFF \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=OFF \
  -DWHISPER_SDL2=OFF \
  -DWHISPER_CURL=OFF \
  $cpu_flags >/dev/null
cmake --build "$build" --config Release --target whisper-cli -j "$(sysctl -n hw.ncpu)" >/dev/null

bin="${build}/bin/whisper-cli"
if ! lipo -archs "$bin" | grep -qw "$osx_arch"; then
  echo "whisper.sh: ${bin} is not ${osx_arch}" >&2
  exit 1
fi
# Only macOS's own libraries: anything else would be missing on another Mac.
foreign="$(otool -L "$bin" | tail -n +2 | awk '{print $1}' | grep -v -E '^(/usr/lib/|/System/Library/)' || true)"
if [ -n "$foreign" ]; then
  echo "whisper.sh: whisper-cli links libraries macOS does not have:" >&2
  echo "$foreign" >&2
  exit 1
fi

dest="${out_root}/${arch}"
mkdir -p "$dest"
cp "$bin" "${dest}/whisper-cli.tmp"
strip -x "${dest}/whisper-cli.tmp"
# strip invalidates the linker's signature; Apple Silicon runs no unsigned code.
codesign --force --sign - "${dest}/whisper-cli.tmp"
mv -f "${dest}/whisper-cli.tmp" "${dest}/whisper-cli"
rm -rf "$build"
echo "whisper-cli ${WHISPER_TAG} (${arch}): ${dest}/whisper-cli"
