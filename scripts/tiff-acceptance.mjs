#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync, inflateSync } from 'node:zlib';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(SCRIPT_DIR, '..');
const DEFAULT_FIXTURE = resolve(
  PROJECT_DIR,
  'tests/fixtures/rgb16-icc-source.tif',
);

const FIXTURE = Object.freeze({
  width: 17,
  height: 11,
  samplesPerPixel: 3,
  bitDepth: 16,
  crop: Object.freeze({
    x: 3,
    y: 2,
    width: 9,
    height: 6,
  }),
});

// sRGB-v2-micro.icc by Clinton Ingram, released under CC0-1.0:
// https://github.com/saucecontrol/Compact-ICC-Profiles
const FIXTURE_ICC = Buffer.from(
  'AAAByGxjbXMCEAAAbW50clJHQiBYWVogB+IAAwAUAAkADgAdYWNzcE1TRlQAAAAAc2F3c2N0cmwAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1oYW5knZEAPUCAsD1AdCyBnqUijgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJZGVzYwAAAPAAAABfY3BydAAAAQwAAAAMd3RwdAAAARgAAAAUclhZWgAAASwAAAAUZ1hZWgAAAUAAAAAUYlhZWgAAAVQAAAAUclRSQwAAAWgAAABgZ1RSQwAAAWgAAABgYlRSQwAAAWgAAABgZGVzYwAAAAAAAAAFdVJHQgAAAAAAAAAAAAAAAHRleHQAAAAAQ0MwAFhZWiAAAAAAAADzVAABAAAAARbJWFlaIAAAAAAAAG+gAAA48gAAA49YWVogAAAAAAAAYpYAALeJAAAY2lhZWiAAAAAAAAAkoAAAD4UAALbEY3VydgAAAAAAAAAqAAAAfAD4AZwCdQODBMkGTggSChgMYg70Ec8U9hhqHC4gQySsKWoufjPrObM/1kZXTTZUdlwXZB1shnVWfo2ILJI2nKunjLLbvpnKx9dl5Hfx+f//',
  'base64',
);

const TIFF_TYPE_BYTES = new Map([
  [1, 1], // BYTE
  [2, 1], // ASCII
  [3, 2], // SHORT
  [4, 4], // LONG
  [5, 8], // RATIONAL
  [6, 1], // SBYTE
  [7, 1], // UNDEFINED
  [8, 2], // SSHORT
  [9, 4], // SLONG
  [10, 8], // SRATIONAL
  [11, 4], // FLOAT
  [12, 8], // DOUBLE
  [13, 4], // IFD
]);

function usage() {
  console.error(`Usage:
  node scripts/tiff-acceptance.mjs generate [source.tif]
  node scripts/tiff-acceptance.mjs inspect <image.tif>
  node scripts/tiff-acceptance.mjs verify <source.tif> <output.tif> <x> <y> <width> <height>

The built-in browser acceptance crop is:
  x=${FIXTURE.crop.x}, y=${FIXTURE.crop.y}, width=${FIXTURE.crop.width}, height=${FIXTURE.crop.height}`);
}

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function align(value, boundary = 4) {
  return Math.ceil(value / boundary) * boundary;
}

function uint16(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}

function uint16s(values) {
  const bytes = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => bytes.writeUInt16LE(value, index * 2));
  return bytes;
}

function uint32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function rational(numerator, denominator) {
  const bytes = Buffer.alloc(8);
  bytes.writeUInt32LE(numerator, 0);
  bytes.writeUInt32LE(denominator, 4);
  return bytes;
}

function fixtureSample(x, y, channel) {
  if (channel === 0) {
    return (x * 4093 + y * 257 + 17) & 0xffff;
  }
  if (channel === 1) {
    return (x * 1237 + y * 8191 + 991) & 0xffff;
  }
  return ((x * 32749) ^ (y * 12345) ^ 0xa55a) & 0xffff;
}

function makeFixturePixels() {
  const pixels = Buffer.alloc(
    FIXTURE.width *
      FIXTURE.height *
      FIXTURE.samplesPerPixel *
      (FIXTURE.bitDepth / 8),
  );
  let offset = 0;
  for (let y = 0; y < FIXTURE.height; y += 1) {
    for (let x = 0; x < FIXTURE.width; x += 1) {
      for (let channel = 0; channel < FIXTURE.samplesPerPixel; channel += 1) {
        pixels.writeUInt16LE(fixtureSample(x, y, channel), offset);
        offset += 2;
      }
    }
  }
  return pixels;
}

function makeFixtureTiff() {
  const pixels = makeFixturePixels();
  const entries = [
    { tag: 256, type: 4, count: 1, data: uint32(FIXTURE.width) },
    { tag: 257, type: 4, count: 1, data: uint32(FIXTURE.height) },
    { tag: 258, type: 3, count: 3, data: uint16s([16, 16, 16]) },
    { tag: 259, type: 3, count: 1, data: uint16(1) },
    { tag: 262, type: 3, count: 1, data: uint16(2) },
    { tag: 273, type: 4, count: 1, data: uint32(0) },
    { tag: 274, type: 3, count: 1, data: uint16(1) },
    { tag: 277, type: 3, count: 1, data: uint16(3) },
    { tag: 278, type: 4, count: 1, data: uint32(FIXTURE.height) },
    { tag: 279, type: 4, count: 1, data: uint32(pixels.byteLength) },
    { tag: 282, type: 5, count: 1, data: rational(600, 1) },
    { tag: 283, type: 5, count: 1, data: rational(600, 1) },
    { tag: 284, type: 3, count: 1, data: uint16(1) },
    { tag: 296, type: 3, count: 1, data: uint16(2) },
    { tag: 339, type: 3, count: 3, data: uint16s([1, 1, 1]) },
    {
      tag: 34675,
      type: 7,
      count: FIXTURE_ICC.byteLength,
      data: FIXTURE_ICC,
    },
  ].sort((left, right) => left.tag - right.tag);

  const ifdOffset = 8;
  const ifdBytes = 2 + entries.length * 12 + 4;
  let cursor = align(ifdOffset + ifdBytes);

  for (const entry of entries) {
    if (entry.data.byteLength > 4) {
      entry.dataOffset = cursor;
      cursor = align(cursor + entry.data.byteLength);
    }
  }

  const pixelOffset = align(cursor);
  const stripOffset = entries.find((entry) => entry.tag === 273);
  assert(stripOffset, 'Fixture encoder lost StripOffsets.');
  stripOffset.data = uint32(pixelOffset);

  const result = Buffer.alloc(pixelOffset + pixels.byteLength);
  result.write('II', 0, 2, 'ascii');
  result.writeUInt16LE(42, 2);
  result.writeUInt32LE(ifdOffset, 4);
  result.writeUInt16LE(entries.length, ifdOffset);

  entries.forEach((entry, index) => {
    const entryOffset = ifdOffset + 2 + index * 12;
    result.writeUInt16LE(entry.tag, entryOffset);
    result.writeUInt16LE(entry.type, entryOffset + 2);
    result.writeUInt32LE(entry.count, entryOffset + 4);
    if (entry.data.byteLength <= 4) {
      entry.data.copy(result, entryOffset + 8);
    } else {
      result.writeUInt32LE(entry.dataOffset, entryOffset + 8);
      entry.data.copy(result, entry.dataOffset);
    }
  });

  result.writeUInt32LE(0, ifdOffset + 2 + entries.length * 12);
  pixels.copy(result, pixelOffset);
  return result;
}

function checkedRange(bytes, offset, length, label) {
  assert(
    Number.isSafeInteger(offset) &&
      Number.isSafeInteger(length) &&
      offset >= 0 &&
      length >= 0 &&
      offset + length <= bytes.byteLength,
    `${label} points outside the TIFF (${offset}+${length}, file=${bytes.byteLength}).`,
  );
  return bytes.subarray(offset, offset + length);
}

function makeNumberReader(bytes, littleEndian) {
  return {
    u16(offset, label = 'uint16') {
      checkedRange(bytes, offset, 2, label);
      return littleEndian
        ? bytes.readUInt16LE(offset)
        : bytes.readUInt16BE(offset);
    },
    u32(offset, label = 'uint32') {
      checkedRange(bytes, offset, 4, label);
      return littleEndian
        ? bytes.readUInt32LE(offset)
        : bytes.readUInt32BE(offset);
    },
  };
}

function parseIfd(bytes, reader, ifdOffset, littleEndian) {
  const entryCount = reader.u16(ifdOffset, 'IFD entry count');
  checkedRange(bytes, ifdOffset + 2, entryCount * 12 + 4, 'IFD');
  const tags = new Map();

  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = ifdOffset + 2 + index * 12;
    const tag = reader.u16(entryOffset, `IFD entry ${index} tag`);
    const type = reader.u16(entryOffset + 2, `TIFF tag ${tag} type`);
    const count = reader.u32(entryOffset + 4, `TIFF tag ${tag} count`);
    const typeBytes = TIFF_TYPE_BYTES.get(type);
    assert(typeBytes, `TIFF tag ${tag} has unsupported field type ${type}.`);
    const byteLength = count * typeBytes;
    assert(
      Number.isSafeInteger(byteLength),
      `TIFF tag ${tag} is too large to inspect safely.`,
    );
    const dataOffset =
      byteLength <= 4
        ? entryOffset + 8
        : reader.u32(entryOffset + 8, `TIFF tag ${tag} data offset`);
    const data = checkedRange(bytes, dataOffset, byteLength, `TIFF tag ${tag}`);
    tags.set(tag, {
      tag,
      type,
      count,
      data,
      littleEndian,
    });
  }

  return tags;
}

function unsignedValues(entry, label) {
  assert(entry, `Missing TIFF tag: ${label}.`);
  const values = [];
  if (entry.type === 1 || entry.type === 7) {
    return [...entry.data];
  }
  if (entry.type === 3) {
    for (let offset = 0; offset < entry.data.byteLength; offset += 2) {
      values.push(
        entry.littleEndian
          ? entry.data.readUInt16LE(offset)
          : entry.data.readUInt16BE(offset),
      );
    }
    return values;
  }
  if (entry.type === 4 || entry.type === 13) {
    for (let offset = 0; offset < entry.data.byteLength; offset += 4) {
      values.push(
        entry.littleEndian
          ? entry.data.readUInt32LE(offset)
          : entry.data.readUInt32BE(offset),
      );
    }
    return values;
  }
  fail(`${label} uses unsupported numeric TIFF type ${entry.type}.`);
}

function optionalUnsigned(tags, tag, fallback) {
  const entry = tags.get(tag);
  return entry ? unsignedValues(entry, `tag ${tag}`) : fallback;
}

function inflateStrip(compressed, label) {
  try {
    return inflateSync(compressed);
  } catch (zlibError) {
    try {
      return inflateRawSync(compressed);
    } catch {
      throw new Error(
        `${label} is not valid TIFF Deflate data: ${zlibError.message}`,
      );
    }
  }
}

function readSamples({
  bytes,
  label,
  littleEndian,
  width,
  height,
  samplesPerPixel,
  bitDepth,
  compression,
  predictor,
  rowsPerStrip,
  stripOffsets,
  stripByteCounts,
}) {
  assert(
    stripOffsets.length === stripByteCounts.length,
    `${label}: StripOffsets count (${stripOffsets.length}) differs from StripByteCounts (${stripByteCounts.length}).`,
  );
  const expectedStripCount = Math.ceil(height / rowsPerStrip);
  assert(
    stripOffsets.length === expectedStripCount,
    `${label}: expected ${expectedStripCount} strips, found ${stripOffsets.length}.`,
  );

  const bytesPerSample = bitDepth / 8;
  const rowSamples = width * samplesPerPixel;
  const result = new Uint32Array(width * height * samplesPerPixel);
  let resultOffset = 0;

  stripOffsets.forEach((stripOffset, stripIndex) => {
    const stripRows = Math.min(
      rowsPerStrip,
      height - stripIndex * rowsPerStrip,
    );
    const expectedBytes = stripRows * rowSamples * bytesPerSample;
    const stored = checkedRange(
      bytes,
      stripOffset,
      stripByteCounts[stripIndex],
      `${label} strip ${stripIndex}`,
    );
    const decoded =
      compression === 1
        ? stored
        : inflateStrip(stored, `${label} strip ${stripIndex}`);
    assert(
      decoded.byteLength === expectedBytes,
      `${label}: strip ${stripIndex} decoded to ${decoded.byteLength} bytes; expected ${expectedBytes}.`,
    );

    const stripSamples = new Uint32Array(stripRows * rowSamples);
    for (
      let sampleIndex = 0;
      sampleIndex < stripSamples.length;
      sampleIndex += 1
    ) {
      const byteOffset = sampleIndex * bytesPerSample;
      stripSamples[sampleIndex] =
        bitDepth === 8
          ? decoded[byteOffset]
          : littleEndian
            ? decoded.readUInt16LE(byteOffset)
            : decoded.readUInt16BE(byteOffset);
    }

    if (predictor === 2) {
      const sampleMask = bitDepth === 8 ? 0xff : 0xffff;
      for (let row = 0; row < stripRows; row += 1) {
        const rowOffset = row * rowSamples;
        for (let x = 1; x < width; x += 1) {
          for (let channel = 0; channel < samplesPerPixel; channel += 1) {
            const index = rowOffset + x * samplesPerPixel + channel;
            stripSamples[index] =
              (stripSamples[index] +
                stripSamples[index - samplesPerPixel]) &
              sampleMask;
          }
        }
      }
    }

    result.set(stripSamples, resultOffset);
    resultOffset += stripSamples.length;
  });

  return result;
}

function parseTiff(bytes, label) {
  assert(bytes.byteLength >= 8, `${label}: file is too small to be a TIFF.`);
  const byteOrder = bytes.toString('ascii', 0, 2);
  assert(
    byteOrder === 'II' || byteOrder === 'MM',
    `${label}: invalid TIFF byte order ${JSON.stringify(byteOrder)}.`,
  );
  const littleEndian = byteOrder === 'II';
  const reader = makeNumberReader(bytes, littleEndian);
  const magic = reader.u16(2, 'TIFF magic');
  assert(
    magic === 42,
    `${label}: only Classic TIFF is supported by this acceptance helper (magic=${magic}).`,
  );
  const ifdOffset = reader.u32(4, 'first IFD offset');
  const tags = parseIfd(bytes, reader, ifdOffset, littleEndian);

  const width = unsignedValues(tags.get(256), 'ImageWidth')[0];
  const height = unsignedValues(tags.get(257), 'ImageLength')[0];
  const samplesPerPixel = optionalUnsigned(tags, 277, [1])[0];
  let bitsPerSample = optionalUnsigned(tags, 258, [1]);
  if (bitsPerSample.length === 1 && samplesPerPixel > 1) {
    bitsPerSample = Array(samplesPerPixel).fill(bitsPerSample[0]);
  }
  assert(
    bitsPerSample.length === samplesPerPixel &&
      bitsPerSample.every((value) => value === bitsPerSample[0]),
    `${label}: mixed or incomplete BitsPerSample is not supported (${bitsPerSample.join(', ')}).`,
  );
  const bitDepth = bitsPerSample[0];
  assert(
    bitDepth === 8 || bitDepth === 16,
    `${label}: acceptance helper supports only 8-bit or 16-bit integer samples (found ${bitDepth}).`,
  );

  let sampleFormat = optionalUnsigned(tags, 339, [1]);
  if (sampleFormat.length === 1 && samplesPerPixel > 1) {
    sampleFormat = Array(samplesPerPixel).fill(sampleFormat[0]);
  }
  assert(
    sampleFormat.length === samplesPerPixel &&
      sampleFormat.every((value) => value === 1),
    `${label}: acceptance helper requires unsigned integer SampleFormat=1 (found ${sampleFormat.join(', ')}).`,
  );

  const compression = optionalUnsigned(tags, 259, [1])[0];
  assert(
    compression === 1 || compression === 8 || compression === 32946,
    `${label}: acceptance helper supports uncompressed or Deflate strips (Compression=${compression}).`,
  );
  const planarConfiguration = optionalUnsigned(tags, 284, [1])[0];
  assert(
    planarConfiguration === 1,
    `${label}: acceptance helper requires chunky/interleaved samples (PlanarConfiguration=${planarConfiguration}).`,
  );
  const predictor = optionalUnsigned(tags, 317, [1])[0];
  assert(
    predictor === 1 || predictor === 2,
    `${label}: acceptance helper supports Predictor 1 or 2 (found ${predictor}).`,
  );
  assert(
    !tags.has(324) && !tags.has(325),
    `${label}: tiled TIFF is outside this fixture acceptance path; output strips instead.`,
  );
  const rowsPerStrip = optionalUnsigned(tags, 278, [height])[0];
  assert(rowsPerStrip > 0, `${label}: RowsPerStrip must be positive.`);
  const stripOffsets = unsignedValues(tags.get(273), 'StripOffsets');
  const stripByteCounts = unsignedValues(tags.get(279), 'StripByteCounts');
  const icc = tags.get(34675)?.data ?? null;
  const samples = readSamples({
    bytes,
    label,
    littleEndian,
    width,
    height,
    samplesPerPixel,
    bitDepth,
    compression,
    predictor,
    rowsPerStrip,
    stripOffsets,
    stripByteCounts,
  });

  return {
    label,
    width,
    height,
    samplesPerPixel,
    bitsPerSample,
    bitDepth,
    sampleFormat,
    compression,
    predictor,
    rowsPerStrip,
    stripCount: stripOffsets.length,
    icc,
    samples,
  };
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function metadataForReport(image) {
  return {
    width: image.width,
    height: image.height,
    samplesPerPixel: image.samplesPerPixel,
    bitsPerSample: image.bitsPerSample,
    sampleFormat: image.sampleFormat,
    compression: image.compression,
    predictor: image.predictor,
    rowsPerStrip: image.rowsPerStrip,
    stripCount: image.stripCount,
    iccBytes: image.icc?.byteLength ?? 0,
    iccSha256: image.icc ? hash(image.icc) : null,
  };
}

function integerArgument(value, name) {
  const parsed = Number(value);
  assert(Number.isInteger(parsed), `${name} must be an integer; got ${value}.`);
  return parsed;
}

async function generate(outputArgument) {
  const output = resolve(outputArgument ?? DEFAULT_FIXTURE);
  const fixture = makeFixtureTiff();
  const parsed = parseTiff(fixture, 'generated fixture');

  assert(
    parsed.width === FIXTURE.width &&
      parsed.height === FIXTURE.height &&
      parsed.bitDepth === FIXTURE.bitDepth &&
      parsed.samplesPerPixel === FIXTURE.samplesPerPixel,
    'Generated fixture metadata failed its own sanity check.',
  );
  assert(
    parsed.icc?.equals(FIXTURE_ICC),
    'Generated fixture ICC bytes failed their own sanity check.',
  );
  for (let y = 0; y < FIXTURE.height; y += 1) {
    for (let x = 0; x < FIXTURE.width; x += 1) {
      for (let channel = 0; channel < FIXTURE.samplesPerPixel; channel += 1) {
        const index =
          (y * FIXTURE.width + x) * FIXTURE.samplesPerPixel + channel;
        assert(
          parsed.samples[index] === fixtureSample(x, y, channel),
          `Generated fixture pixel sanity check failed at (${x}, ${y}), channel ${channel}.`,
        );
      }
    }
  }

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, fixture);
  const fixtureDisplayPath = relative(PROJECT_DIR, output) || output;

  console.log(
    JSON.stringify(
      {
        ok: true,
        source: fixtureDisplayPath,
        bytes: fixture.byteLength,
        sha256: hash(fixture),
        browserCrop: FIXTURE.crop,
        instructions: [
          `Open ${fixtureDisplayPath} in Framecut.`,
          `Draw or enter x=${FIXTURE.crop.x}, y=${FIXTURE.crop.y}, width=${FIXTURE.crop.width}, height=${FIXTURE.crop.height}.`,
          'Export the crop without changing bit depth or color profile.',
          `Run: node scripts/tiff-acceptance.mjs verify ${fixtureDisplayPath} <exported.tif> ${FIXTURE.crop.x} ${FIXTURE.crop.y} ${FIXTURE.crop.width} ${FIXTURE.crop.height}`,
        ],
        image: metadataForReport(parsed),
      },
      null,
      2,
    ),
  );
}

async function inspect(inputArgument) {
  assert(inputArgument, 'inspect requires an input TIFF path.');
  const input = resolve(inputArgument);
  const image = parseTiff(await readFile(input), input);
  console.log(
    JSON.stringify(
      {
        ok: true,
        path: input,
        image: metadataForReport(image),
      },
      null,
      2,
    ),
  );
}

async function verify(args) {
  const [sourceArgument, outputArgument, xArg, yArg, widthArg, heightArg] =
    args;
  assert(
    sourceArgument &&
      outputArgument &&
      xArg !== undefined &&
      yArg !== undefined &&
      widthArg !== undefined &&
      heightArg !== undefined,
    'verify requires source, output, x, y, width, and height.',
  );
  const crop = {
    x: integerArgument(xArg, 'x'),
    y: integerArgument(yArg, 'y'),
    width: integerArgument(widthArg, 'width'),
    height: integerArgument(heightArg, 'height'),
  };
  assert(
    crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0,
    `Invalid crop: ${JSON.stringify(crop)}.`,
  );

  const sourcePath = resolve(sourceArgument);
  const outputPath = resolve(outputArgument);
  const [source, output] = await Promise.all([
    readFile(sourcePath).then((bytes) => parseTiff(bytes, sourcePath)),
    readFile(outputPath).then((bytes) => parseTiff(bytes, outputPath)),
  ]);

  assert(
    crop.x + crop.width <= source.width &&
      crop.y + crop.height <= source.height,
    `Crop ${JSON.stringify(crop)} exceeds source ${source.width}x${source.height}.`,
  );
  assert(
    output.width === crop.width && output.height === crop.height,
    `Output is ${output.width}x${output.height}; expected ${crop.width}x${crop.height}.`,
  );
  assert(
    output.bitDepth === source.bitDepth,
    `Output bit depth is ${output.bitDepth}; source is ${source.bitDepth}.`,
  );
  assert(
    output.samplesPerPixel === source.samplesPerPixel,
    `Output has ${output.samplesPerPixel} samples/pixel; source has ${source.samplesPerPixel}.`,
  );
  assert(source.icc, 'Source has no ICC profile to preserve.');
  assert(output.icc, 'Output lost the source ICC profile.');
  assert(
    output.icc.equals(source.icc),
    `Output ICC differs byte-for-byte (source SHA-256 ${hash(source.icc)}, output ${hash(output.icc)}).`,
  );

  const sampleCount =
    crop.width * crop.height * source.samplesPerPixel;
  for (let outputY = 0; outputY < crop.height; outputY += 1) {
    for (let outputX = 0; outputX < crop.width; outputX += 1) {
      for (
        let channel = 0;
        channel < source.samplesPerPixel;
        channel += 1
      ) {
        const sourceX = crop.x + outputX;
        const sourceY = crop.y + outputY;
        const sourceIndex =
          (sourceY * source.width + sourceX) * source.samplesPerPixel +
          channel;
        const outputIndex =
          (outputY * output.width + outputX) * output.samplesPerPixel +
          channel;
        const expected = source.samples[sourceIndex];
        const actual = output.samples[outputIndex];
        assert(
          actual === expected,
          `Pixel mismatch at output (${outputX}, ${outputY}), source (${sourceX}, ${sourceY}), channel ${channel}: expected ${expected}, got ${actual}.`,
        );
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        result: 'PASS — crop samples, bit depth, and ICC bytes are exact.',
        crop,
        samplesCompared: sampleCount,
        source: metadataForReport(source),
        output: metadataForReport(output),
        checks: {
          dimensionsExact: true,
          bitDepthExact: true,
          samplesExact: true,
          iccBytesExact: true,
        },
      },
      null,
      2,
    ),
  );
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'generate') {
    await generate(args[0]);
    return;
  }
  if (command === 'inspect') {
    await inspect(args[0]);
    return;
  }
  if (command === 'verify') {
    await verify(args);
    return;
  }
  usage();
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(`TIFF acceptance failed: ${error.message}`);
  process.exitCode = 1;
});
