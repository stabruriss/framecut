export interface FramecutFileSystem {
  mkdir(path: string): void;
  mount(
    type: unknown,
    options: {
      blobs: Array<{
        data: Blob;
        name: string;
      }>;
    },
    mountPoint: string,
  ): unknown;
  readFile(path: string): Uint8Array<ArrayBuffer>;
  rmdir(path: string): void;
  unlink(path: string): void;
  unmount(path: string): void;
}

export interface FramecutLibtiffModule {
  FS: FramecutFileSystem;
  HEAPU8: Uint8Array<ArrayBuffer>;
  WORKERFS: unknown;
  UTF8ToString(pointer: number): string;
  ccall(
    name: string,
    returnType: 'number' | null,
    argumentTypes?: Array<'number' | 'string'>,
    arguments_?: Array<number | string>,
  ): number;
}

export default function createFramecutLibtiff(): Promise<FramecutLibtiffModule>;
