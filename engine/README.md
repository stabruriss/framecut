# Framecut single-thread TIFF engine

The single-file build uses a narrow C wrapper around upstream
[libtiff 4.7.2](https://libtiff.gitlab.io/libtiff/). It is compiled as a
single-thread Emscripten module and then inlined into Framecut's classic Blob
Worker. The final `Framecut.html` performs no runtime fetches.

The committed `dist/libtiff-engine.mjs` is generated. To reproduce it:

```sh
./scripts/build-libtiff-engine.sh
```

The build requires Emscripten (`emcc`, `emconfigure`, and `emmake`). It pins
Emscripten 4.0.23, pins the source archive, verifies its SHA-256, cleans stale
objects, and maps local build paths to stable virtual prefixes before
compiling. The browser
module includes only the codecs needed by Framecut's stated input matrix:
uncompressed, LZW, PackBits, and zlib Deflate. Output always uses Adobe
Deflate with horizontal prediction.

`SINGLE_FILE_BINARY_ENCODE=0` is intentional. Emscripten's newer compact
binary-string representation is not safe to pass through arbitrary JavaScript
bundlers/minifiers; Base64 survives Vite's inline Worker transform.

The wrapper rejects unsupported sample layouts before decoding and never uses
libtiff's 8-bit RGBA API for final output. Crop export reads original 8-bit or
16-bit samples and writes them without resampling. It preserves ICC,
resolution, chromaticity, and common descriptive string tags. It intentionally
drops opaque XMP and Photoshop resource blocks because those can retain stale
dimensions or an embedded thumbnail of the uncropped source.
