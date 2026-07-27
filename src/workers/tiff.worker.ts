/// <reference lib="webworker" />

import type Vips from 'wasm-vips';
import { isValidCrop, rotatedBounds } from '../lib/geometry';
import type {
  CropBox,
  LoadedSource,
  QuarterTurn,
  SourceInfo,
  WorkerProgress,
} from '../lib/model';

type VipsModule = Awaited<ReturnType<typeof Vips>>;

interface LoadRequest {
  engineBaseUrl: string;
  id: number;
  type: 'load';
  file: File;
}

interface ExportRequest {
  id: number;
  type: 'export';
  crop: CropBox;
  rotation: QuarterTurn;
  sourceId: string;
}

interface DisposeRequest {
  id: number;
  type: 'dispose-source';
}

type WorkerRequest = LoadRequest | ExportRequest | DisposeRequest;

let vipsPromise: Promise<VipsModule> | null = null;
let sourceImage: Vips.Image | null = null;
let sourceConnection: Vips.SourceCustom | null = null;
let sourceInfo: SourceInfo | null = null;
let sourceId: string | null = null;

function report(progress: WorkerProgress) {
  self.postMessage({
    type: 'progress',
    progress,
  });
}

async function getVips(engineBaseUrl: string): Promise<VipsModule> {
  if (!vipsPromise) {
    report({ phase: 'engine', percent: 0 });
    const moduleUrl = new URL('vips-es6.js', engineBaseUrl).href;
    const { default: createVips } = (await import(
      /* @vite-ignore */ moduleUrl
    )) as {
      default: typeof Vips;
    };
    vipsPromise = createVips({
      dynamicLibraries: [],
      printErr: (message) => {
        if (!message.includes('VIPS-WARNING')) {
          console.warn(`[libvips] ${message}`);
        }
      },
    }).then((vips) => {
      vips.concurrency(Math.min(navigator.hardwareConcurrency || 4, 6));
      vips.Cache.max(32);
      vips.Cache.maxMem(192 * 1024 * 1024);
      report({ phase: 'engine', percent: 100 });
      return vips;
    });
  }

  try {
    return await vipsPromise;
  } catch (error) {
    vipsPromise = null;
    throw error;
  }
}

function bitDepthForFormat(format: string): number {
  return (
    {
      char: 8,
      uchar: 8,
      short: 16,
      ushort: 16,
      int: 32,
      uint: 32,
      float: 32,
      double: 64,
      complex: 64,
      dpcomplex: 128,
    }[format] ?? 0
  );
}

function optionalInt(image: Vips.Image, name: string): number | null {
  try {
    return image.getTypeof(name) ? image.getInt(name) : null;
  } catch {
    return null;
  }
}

function disposeSource() {
  sourceImage?.delete();
  sourceConnection?.delete();
  sourceImage = null;
  sourceConnection = null;
  sourceInfo = null;
  sourceId = null;
}

function copyForTransfer(buffer: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return copy.buffer;
}

async function loadSource(
  file: File,
  engineBaseUrl: string,
): Promise<LoadedSource> {
  const vips = await getVips(engineBaseUrl);

  report({ phase: 'preview', percent: 2 });
  const reader = new FileReaderSync();
  let position = 0;
  const connection = new vips.SourceCustom();
  connection.onRead = (length) => {
    if (position >= file.size) {
      return undefined;
    }
    const end = Math.min(file.size, position + length);
    const buffer = reader.readAsArrayBuffer(file.slice(position, end));
    position += buffer.byteLength;
    return new Uint8Array(buffer);
  };
  connection.onSeek = (offset, whence) => {
    const origin =
      whence === 0
        ? 0
        : whence === 1
          ? position
          : whence === 2
            ? file.size
            : position;
    position = Math.max(0, Math.min(file.size, origin + offset));
    return position;
  };

  let image: Vips.Image | null = null;
  let preview: Vips.Image | null = null;
  try {
    image = vips.Image.newFromSource(connection, '', {
      access: 'random',
      fail_on: 'error',
    });
    const format = image.format;
    const bitDepth = bitDepthForFormat(format);
    if (![8, 16].includes(bitDepth)) {
      throw new Error(
        `Only 8-bit and 16-bit TIFFs are supported. This file is ${format}.`,
      );
    }

    const pageCount = optionalInt(image, 'n-pages') ?? 1;
    const orientation = optionalInt(image, 'orientation') ?? 1;
    if (orientation < 1 || orientation > 8) {
      throw new Error(
        `TIFF Orientation=${orientation} is invalid. Expected 1–8.`,
      );
    }
    if (orientation !== 1) {
      const oriented = image.autorot();
      image.delete();
      image = oriented;
    }
    const info: SourceInfo = {
      width: image.width,
      height: image.height,
      bands: image.bands,
      bitDepth,
      fileName: file.name,
      fileSize: file.size,
      format,
      hasIccProfile: image.getTypeof('icc-profile-data') !== 0,
      interpretation: image.interpretation,
      orientation,
      pageCount,
      xResolutionDpi: image.xres > 0 ? image.xres * 25.4 : null,
      yResolutionDpi: image.yres > 0 ? image.yres * 25.4 : null,
    };

    image.onProgress = (percent) => {
      report({
        phase: 'preview',
        percent: Math.max(2, Math.min(percent, 94)),
      });
    };

    const previewMax = 2400;
    preview = image.thumbnailImage(previewMax, {
      height: previewMax,
      no_rotate: true,
      size: 'down',
    });

    if (!['b-w', 'grey16', 'srgb', 'rgb16'].includes(preview.interpretation)) {
      const converted = preview.colourspace('srgb');
      preview.delete();
      preview = converted;
    }

    if (preview.format !== 'uchar') {
      const cast = preview.cast('uchar', {
        shift: true,
      });
      preview.delete();
      preview = cast;
    }

    const previewBytes = preview.pngsaveBuffer({
      bitdepth: 8,
      compression: 6,
      keep: 'icc',
    });
    const previewBuffer = copyForTransfer(previewBytes);
    preview.delete();
    preview = null;

    disposeSource();
    const nextSourceId = crypto.randomUUID();
    sourceImage = image;
    sourceConnection = connection;
    sourceInfo = info;
    sourceId = nextSourceId;
    report({ phase: 'preview', percent: 100 });

    return {
      info,
      previewBuffer,
      sourceId: nextSourceId,
    };
  } catch (error) {
    preview?.delete();
    image?.delete();
    connection.delete();
    throw error;
  }
}

function exportCrop(
  crop: CropBox,
  expectedSourceId: string,
  rotation: QuarterTurn,
): ArrayBuffer {
  if (!sourceImage || !sourceInfo || !sourceId) {
    throw new Error('Open a TIFF first.');
  }
  if (sourceId !== expectedSourceId) {
    throw new Error('The source TIFF changed. Export stopped.');
  }
  if (!isValidCrop(crop, rotatedBounds(sourceInfo, rotation))) {
    throw new Error(`“${crop.name}” is outside the source image.`);
  }

  const estimatedBytes =
    crop.width *
    crop.height *
    sourceInfo.bands *
    Math.ceil(sourceInfo.bitDepth / 8);
  if (estimatedBytes > 384 * 1024 * 1024) {
    throw new Error('One frame exceeds the 384 MiB raw-pixel limit.');
  }

  report({ phase: 'export', percent: 1 });
  const rotated =
    rotation === 0
      ? null
      : sourceImage.rot(rotation as Vips.Angle);
  const exportImage = rotated ?? sourceImage;
  const output = exportImage.crop(
    crop.x,
    crop.y,
    crop.width,
    crop.height,
  );
  output.onProgress = (percent) => {
    report({
      phase: 'export',
      percent: Math.max(1, Math.min(percent, 98)),
    });
  };

  try {
    const bytes = output.tiffsaveBuffer({
      compression: 'deflate',
      predictor:
        sourceInfo.format === 'float' || sourceInfo.format === 'double'
          ? 'float'
          : 'horizontal',
      level: 6,
      keep: 'all',
      properties: false,
      tile: false,
    });
    const result = copyForTransfer(bytes);
    report({ phase: 'export', percent: 100 });
    return result;
  } finally {
    output.delete();
    rotated?.delete();
  }
}

self.addEventListener(
  'message',
  async (event: MessageEvent<WorkerRequest>) => {
    const request = event.data;
    try {
      let result: LoadedSource | ArrayBuffer | undefined;
      if (request.type === 'load') {
        result = await loadSource(request.file, request.engineBaseUrl);
      } else if (request.type === 'export') {
        result = exportCrop(
          request.crop,
          request.sourceId,
          request.rotation,
        );
      } else {
        disposeSource();
      }

      if (result instanceof ArrayBuffer) {
        self.postMessage(
          {
            id: request.id,
            ok: true,
            result,
          },
          {
            transfer: [result],
          },
        );
      } else if (result?.previewBuffer instanceof ArrayBuffer) {
        self.postMessage(
          {
            id: request.id,
            ok: true,
            result,
          },
          {
            transfer: [result.previewBuffer],
          },
        );
      } else {
        self.postMessage({
          id: request.id,
          ok: true,
          result,
        });
      }
    } catch (error) {
      self.postMessage({
        id: request.id,
        ok: false,
        error:
          error instanceof Error ? error.message : 'Could not process this TIFF.',
      });
    }
  },
);
