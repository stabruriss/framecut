import { writeFile } from 'node:fs/promises';
import Vips from 'wasm-vips';

const [input, output, x, y, width, height] = process.argv.slice(2);
const coordinates = [x, y, width, height].map(Number);

if (
  !input ||
  !output ||
  coordinates.some((value) => !Number.isInteger(value))
) {
  console.error(
    'Usage: npm run smoke:engine -- input.tif output.tif x y width height',
  );
  process.exit(2);
}

const vips = await Vips({
  dynamicLibraries: [],
});
const image = vips.Image.newFromFile(input, {
  access: 'random',
  fail_on: 'error',
});
const [left, top, cropWidth, cropHeight] = coordinates;

if (
  left < 0 ||
  top < 0 ||
  cropWidth < 1 ||
  cropHeight < 1 ||
  left + cropWidth > image.width ||
  top + cropHeight > image.height
) {
  console.error('Crop is outside the source image.');
  image.delete();
  vips.shutdown();
  process.exit(2);
}

const crop = image.crop(left, top, cropWidth, cropHeight);
const bytes = crop.tiffsaveBuffer({
  compression: 'deflate',
  predictor: 'horizontal',
  level: 6,
  keep: 'all',
  properties: false,
  tile: false,
});
await writeFile(output, bytes);

console.log(
  JSON.stringify({
    source: {
      width: image.width,
      height: image.height,
      bands: image.bands,
      format: image.format,
      interpretation: image.interpretation,
    },
    crop: {
      x: left,
      y: top,
      width: cropWidth,
      height: cropHeight,
      bytes: bytes.byteLength,
    },
  }),
);

crop.delete();
image.delete();
vips.shutdown();
