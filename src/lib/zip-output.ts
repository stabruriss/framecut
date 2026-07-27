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
        'ZIP 后备模式只适合裸像素合计不超过 512 MiB 的任务；请用桌面版 Chrome 直接输出到文件夹。',
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
      throw new Error('ZIP 已经结束，不能再加入文件。');
    }
    if (this.storedBytes + buffer.byteLength > MAX_ZIP_BYTES) {
      throw new Error(
        'ZIP 后备输出最多容纳 512 MiB；请改用桌面版 Chrome 直接写入文件夹。',
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
