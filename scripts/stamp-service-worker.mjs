import { createHash } from 'node:crypto';
import {
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const distDirectory = fileURLToPath(
  new URL('../dist/', import.meta.url),
);
const serviceWorkerPath = path.join(distDirectory, 'sw.js');
const versionToken = '__FRAMECUT_CACHE_VERSION__';

async function filesBelow(directory) {
  const entries = await readdir(directory, {
    withFileTypes: true,
  });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesBelow(entryPath)));
    } else if (entryPath !== serviceWorkerPath) {
      files.push(entryPath);
    }
  }

  return files;
}

const hash = createHash('sha256');
const files = (await filesBelow(distDirectory)).sort();
for (const file of files) {
  const relativeName = path
    .relative(distDirectory, file)
    .split(path.sep)
    .join('/');
  hash.update(relativeName);
  hash.update(await readFile(file));
}

const source = await readFile(serviceWorkerPath, 'utf8');
if (!source.includes(versionToken)) {
  throw new Error('Service Worker cache version token is missing.');
}
hash.update('sw.js');
hash.update(source);
const version = hash.digest('hex').slice(0, 16);

await writeFile(
  serviceWorkerPath,
  source.replaceAll(versionToken, version),
);
console.log(`Stamped Service Worker cache: ${version}`);
