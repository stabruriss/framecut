# TIFF acceptance fixture

`rgb16-icc-source.tif` is a deliberately small, deterministic fixture for
checking Framecut's lossless crop path. It is:

- 17 × 11 pixels;
- interleaved, unsigned 16-bit RGB;
- uncompressed and stored as one strip;
- tagged with a 600 DPI resolution and Orientation 1;
- tagged with the 456-byte CC0
  [`sRGB-v2-micro.icc`](https://github.com/saucecontrol/Compact-ICC-Profiles).

The source pixels are generated from their `(x, y, channel)` coordinates, so
the acceptance tool can detect off-by-one crop errors as well as changed
samples. The file is generated rather than hand-edited:

```sh
node scripts/tiff-acceptance.mjs generate
```

The command prints the exact crop to enter in the browser:

```text
x=3, y=2, width=9, height=6
```

After exporting that crop from Framecut, verify it with:

```sh
node scripts/tiff-acceptance.mjs verify \
  tests/fixtures/rgb16-icc-source.tif \
  /path/to/exported.tif \
  3 2 9 6
```

A pass means all of the following are exact:

- output dimensions;
- 16-bit unsigned sample format and channel count;
- every RGB sample at the requested source coordinate;
- the embedded ICC profile's original bytes.

The verifier intentionally has a narrow scope: Classic TIFF with chunky,
unsigned 8-bit or 16-bit strips using no compression or Deflate, optionally
with horizontal predictor. That covers this fixture and Framecut's expected
output without turning the test helper into a second general-purpose TIFF
engine.
