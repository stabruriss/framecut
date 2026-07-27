import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { MAX_ZIP_BYTES, StoredZipBuilder } from './zip-output';

describe('StoredZipBuilder', () => {
  it('collects TIFF outputs without recompressing them', async () => {
    const first = new Uint8Array([0x49, 0x49, 0x2a, 0x00]);
    const second = new Uint8Array([0x4d, 0x4d, 0x00, 0x2a, 0x01]);
    const builder = new StoredZipBuilder();

    builder.add('scan_01.tif', first.slice().buffer);
    builder.add('scan_02.tif', second.slice().buffer);

    const archive = new Uint8Array(await (await builder.finish()).arrayBuffer());
    const files = unzipSync(archive);

    expect(files['scan_01.tif']).toEqual(first);
    expect(files['scan_02.tif']).toEqual(second);
  });

  it('rejects an oversized task before processing any crop', () => {
    expect(() => new StoredZipBuilder(MAX_ZIP_BYTES + 1)).toThrow(
      '裸像素合计不超过 512 MiB',
    );
  });
});
