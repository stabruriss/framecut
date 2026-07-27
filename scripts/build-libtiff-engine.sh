#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="${FRAMECUT_ENGINE_CACHE_DIR:-$ROOT_DIR/engine/.cache}"
LIBTIFF_VERSION="4.7.2"
EMSCRIPTEN_VERSION="4.0.23"
LIBTIFF_ARCHIVE="$CACHE_DIR/tiff-$LIBTIFF_VERSION.tar.xz"
LIBTIFF_SOURCE="$CACHE_DIR/tiff-$LIBTIFF_VERSION"
LIBTIFF_BUILD="$CACHE_DIR/build-$LIBTIFF_VERSION"
LIBTIFF_URL="https://download.osgeo.org/libtiff/tiff-$LIBTIFF_VERSION.tar.xz"
LIBTIFF_SHA256="4996f0c4f93094719b1ca5c6279b20e588773ba8a247533e486416fb662ddb88"
OUTPUT_DIR="$ROOT_DIR/engine/dist"
JOBS="${FRAMECUT_BUILD_JOBS:-4}"
PREFIX_MAP_FLAGS=(
  "-ffile-prefix-map=$CACHE_DIR=/framecut-cache"
  "-ffile-prefix-map=$ROOT_DIR=/framecut"
)

for command_name in curl emcc emconfigure emmake sed shasum tar; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Missing build dependency: %s\n' "$command_name" >&2
    exit 1
  fi
done

ACTUAL_EMSCRIPTEN_VERSION="$(
  emcc --version |
    sed -nE '1s/.* ([0-9]+\.[0-9]+\.[0-9]+) \(.*/\1/p'
)"
if [[ "$ACTUAL_EMSCRIPTEN_VERSION" != "$EMSCRIPTEN_VERSION" ]]; then
  printf 'Expected Emscripten %s, found %s.\n' \
    "$EMSCRIPTEN_VERSION" \
    "${ACTUAL_EMSCRIPTEN_VERSION:-unknown}" >&2
  exit 1
fi

mkdir -p "$CACHE_DIR" "$LIBTIFF_BUILD" "$OUTPUT_DIR"

if [[ ! -f "$LIBTIFF_ARCHIVE" ]]; then
  curl --fail --location --output "$LIBTIFF_ARCHIVE" "$LIBTIFF_URL"
fi

printf '%s  %s\n' "$LIBTIFF_SHA256" "$LIBTIFF_ARCHIVE" |
  shasum -a 256 --check

if [[ ! -f "$LIBTIFF_SOURCE/configure" ]]; then
  tar -xJf "$LIBTIFF_ARCHIVE" -C "$CACHE_DIR"
fi

(
  cd "$LIBTIFF_BUILD"
  emconfigure "$LIBTIFF_SOURCE/configure" \
    --host=wasm32-unknown-emscripten \
    --disable-shared \
    --enable-static \
    --disable-tools \
    --disable-tests \
    --disable-contrib \
    --disable-docs \
    --disable-cxx \
    --disable-ld-version-script \
    --disable-ccitt \
    --enable-lzw \
    --disable-thunder \
    --disable-next \
    --disable-logluv \
    --disable-mdi \
    --enable-zlib \
    --disable-libdeflate \
    --disable-pixarlog \
    --disable-jpeg \
    --disable-old-jpeg \
    --disable-jbig \
    --disable-lerc \
    --disable-lzma \
    --disable-zstd \
    --disable-webp \
    --disable-opengl \
    CFLAGS="-O2 -fno-exceptions -sUSE_ZLIB=1 ${PREFIX_MAP_FLAGS[*]}" \
    LDFLAGS="-sUSE_ZLIB=1"

  # Configure does not invalidate objects when CFLAGS change. Rebuilding this
  # small static library avoids silently linking stale, path-leaking objects.
  emmake make -C libtiff clean
  emmake make -j "$JOBS" -C libtiff
)

EXPORTED_FUNCTIONS='[
  "_fc_open",
  "_fc_close",
  "_fc_last_error",
  "_fc_get_width",
  "_fc_get_height",
  "_fc_get_bits_per_sample",
  "_fc_get_samples_per_pixel",
  "_fc_get_photometric",
  "_fc_get_compression",
  "_fc_get_orientation",
  "_fc_get_page_count",
  "_fc_get_x_resolution_dpi",
  "_fc_get_y_resolution_dpi",
  "_fc_get_has_icc",
  "_fc_make_preview",
  "_fc_get_preview_pointer",
  "_fc_get_preview_width",
  "_fc_get_preview_height",
  "_fc_free_preview",
  "_fc_export_crop"
]'

EXPORTED_RUNTIME_METHODS='[
  "ccall",
  "UTF8ToString",
  "FS",
  "WORKERFS",
  "HEAPU8"
]'

emcc \
  "$ROOT_DIR/engine/libtiff-wrapper.c" \
  "$LIBTIFF_BUILD/libtiff/.libs/libtiff.a" \
  -I"$LIBTIFF_BUILD/libtiff" \
  -I"$LIBTIFF_SOURCE/libtiff" \
  -O2 \
  "${PREFIX_MAP_FLAGS[@]}" \
  -sUSE_ZLIB=1 \
  -sSINGLE_FILE=1 \
  -sSINGLE_FILE_BINARY_ENCODE=0 \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=createFramecutLibtiff \
  -sENVIRONMENT=web,worker \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=67108864 \
  -sMAXIMUM_MEMORY=2147483648 \
  -sSTACK_SIZE=1048576 \
  -sFILESYSTEM=1 \
  -sNO_EXIT_RUNTIME=1 \
  -sASSERTIONS=1 \
  -lworkerfs.js \
  "-sEXPORTED_FUNCTIONS=$EXPORTED_FUNCTIONS" \
  "-sEXPORTED_RUNTIME_METHODS=$EXPORTED_RUNTIME_METHODS" \
  -o "$OUTPUT_DIR/libtiff-engine.mjs"

printf 'Built %s\n' "$OUTPUT_DIR/libtiff-engine.mjs"
