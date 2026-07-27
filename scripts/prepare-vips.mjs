import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const destination = join(root, 'public', 'vendor', 'wasm-vips');

await mkdir(destination, {
  recursive: true,
});
await Promise.all(
  [
    ['lib/vips-es6.js', 'vips-es6.js'],
    ['lib/vips.wasm', 'vips.wasm'],
    ['LICENSE', 'LICENSE'],
    ['THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.md'],
  ].map(([sourceName, destinationName]) =>
    copyFile(
      join(root, 'node_modules', 'wasm-vips', sourceName),
      join(destination, destinationName),
    ),
  ),
);
