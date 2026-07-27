import { Zip, ZipPassThrough } from 'fflate';

export const MAX_ZIP_BYTES = 512 * 1024 * 1024;

export class StoredZipBuilder {
  private readonly chunks: BlobPart[] = [];
  private readonly completed: Promise<Blob>;
  private readonly zip: Zip;
  private finishRequested = false;
  private storedBytes = 0;

  constructor(estimatedRawBytes = 0) {
    if (
      !Number.isFinite(estimatedRawBytes) ||
      estimatedRawBytes < 0 ||
      estimatedRawBytes > MAX_ZIP_BYTES
    ) {
      throw new Error(
        'ZIP mode is limited to 512 MiB of raw pixels. Export to a folder in desktop Chrome.',
      );
    }

    let resolveCompleted: (blob: Blob) => void;
    let rejectCompleted: (error: Error) => void;
    this.completed = new Promise<Blob>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });

    this.zip = new Zip((error, chunk, final) => {
      if (error) {
        rejectCompleted(error);
        return;
      }

      this.chunks.push(chunk as Uint8Array<ArrayBuffer>);
      if (final) {
        resolveCompleted(
          new Blob(this.chunks, {
            type: 'application/zip',
          }),
        );
      }
    });
  }

  add(fileName: string, buffer: ArrayBuffer) {
    if (this.finishRequested) {
      throw new Error('The ZIP is already closed.');
    }
    if (this.storedBytes + buffer.byteLength > MAX_ZIP_BYTES) {
      throw new Error(
        'ZIP output is limited to 512 MiB. Export to a folder in desktop Chrome.',
      );
    }

    const entry = new ZipPassThrough(fileName);
    entry.mtime = new Date();
    this.zip.add(entry);
    entry.push(new Uint8Array(buffer), true);
    this.storedBytes += buffer.byteLength;
  }

  finish(): Promise<Blob> {
    if (!this.finishRequested) {
      this.finishRequested = true;
      this.zip.end();
    }
    return this.completed;
  }
}
