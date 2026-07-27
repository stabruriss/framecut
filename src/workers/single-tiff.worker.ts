/// <reference lib="webworker" />

import createFramecutLibtiff from '../../engine/dist/libtiff-engine.mjs';
import { isValidCrop, rotatedBounds } from '../lib/geometry';
import type {
  CropBox,
  LoadedSource,
  QuarterTurn,
  SourceInfo,
  WorkerProgress,
} from '../lib/model';

type Engine = Awaited<ReturnType<typeof createFramecutLibtiff>>;

interface LoadRequest {
  file: File;
  id: number;
  type: 'load';
}

interface ExportRequest {
  crop: CropBox;
  id: number;
  rotation: QuarterTurn;
  sourceId: string;
  type: 'export';
}

interface DisposeRequest {
  id: number;
  type: 'dispose-source';
}

type WorkerRequest = LoadRequest | ExportRequest | DisposeRequest;

const SOURCE_ROOT = '/framecut-sources';
const OUTPUT_ROOT = '/framecut-output';
const MAX_RAW_CROP_BYTES = 384n * 1024n * 1024n;

let enginePromise: Promise<Engine> | null = null;
let currentMountPath: string | null = null;
let currentSourceId: string | null = null;
let currentSourceInfo: SourceInfo | null = null;

function report(progress: WorkerProgress) {
  self.postMessage({
    type: 'progress',
    progress,
  });
}

async function getEngine(): Promise<Engine> {
  if (!enginePromise) {
    report({ phase: 'engine', percent: 0 });
    enginePromise = createFramecutLibtiff().then((engine) => {
      engine.FS.mkdir(SOURCE_ROOT);
      engine.FS.mkdir(OUTPUT_ROOT);
      report({ phase: 'engine', percent: 100 });
      return engine;
    });
  }

  try {
    return await enginePromise;
  } catch (error) {
    enginePromise = null;
    throw error;
  }
}

function callNumber(
  engine: Engine,
  name: string,
  argumentTypes: Array<'number' | 'string'> = [],
  arguments_: Array<number | string> = [],
): number {
  return engine.ccall(name, 'number', argumentTypes, arguments_);
}

function callVoid(engine: Engine, name: string) {
  engine.ccall(name, null, [], []);
}

function lastError(engine: Engine): string {
  return engine.UTF8ToString(callNumber(engine, 'fc_last_error'));
}

function unmount(engine: Engine, mountPath: string) {
  try {
    engine.FS.unmount(mountPath);
  } finally {
    engine.FS.rmdir(mountPath);
  }
}

function sourceInfo(engine: Engine, file: File): SourceInfo {
  const bitDepth = callNumber(engine, 'fc_get_bits_per_sample');
  const bands = callNumber(engine, 'fc_get_samples_per_pixel');
  const xResolution = engine.ccall(
    'fc_get_x_resolution_dpi',
    'number',
    [],
    [],
  );
  const yResolution = engine.ccall(
    'fc_get_y_resolution_dpi',
    'number',
    [],
    [],
  );

  return {
    width: callNumber(engine, 'fc_get_width'),
    height: callNumber(engine, 'fc_get_height'),
    bands,
    bitDepth,
    fileName: file.name,
    fileSize: file.size,
    format: bitDepth === 16 ? 'ushort' : 'uchar',
    hasIccProfile: callNumber(engine, 'fc_get_has_icc') === 1,
    interpretation:
      bands === 1
        ? bitDepth === 16
          ? 'grey16'
          : 'b-w'
        : bitDepth === 16
          ? 'rgb16'
          : 'srgb',
    orientation: callNumber(engine, 'fc_get_orientation'),
    pageCount: callNumber(engine, 'fc_get_page_count'),
    xResolutionDpi: xResolution > 0 ? xResolution : null,
    yResolutionDpi: yResolution > 0 ? yResolution : null,
  };
}

async function makePreview(engine: Engine): Promise<ArrayBuffer> {
  report({ phase: 'preview', percent: 5 });
  if (!callNumber(engine, 'fc_make_preview', ['number'], [2400])) {
    throw new Error(lastError(engine));
  }

  try {
    const width = callNumber(engine, 'fc_get_preview_width');
    const height = callNumber(engine, 'fc_get_preview_height');
    const pointer = callNumber(engine, 'fc_get_preview_pointer');
    const byteLength = width * height * 4;
    const rgba = engine.HEAPU8.slice(pointer, pointer + byteLength);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Could not create the preview canvas.');
    }

    context.putImageData(
      new ImageData(new Uint8ClampedArray(rgba.buffer), width, height),
      0,
      0,
    );
    report({ phase: 'preview', percent: 92 });
    const blob = await canvas.convertToBlob({
      type: 'image/png',
    });
    return await blob.arrayBuffer();
  } finally {
    callVoid(engine, 'fc_free_preview');
  }
}

async function loadSource(file: File): Promise<LoadedSource> {
  const engine = await getEngine();
  const mountId = crypto.randomUUID();
  const mountPath = `${SOURCE_ROOT}/${mountId}`;
  const sourcePath = `${mountPath}/source.tif`;
  const previousMountPath = currentMountPath;
  let candidateOpened = false;
  let candidateMounted = false;

  engine.FS.mkdir(mountPath);
  try {
    engine.FS.mount(
      engine.WORKERFS,
      {
        blobs: [
          {
            data: file,
            name: 'source.tif',
          },
        ],
      },
      mountPath,
    );
    candidateMounted = true;

    if (!callNumber(engine, 'fc_open', ['string'], [sourcePath])) {
      throw new Error(lastError(engine));
    }
    candidateOpened = true;

    const info = sourceInfo(engine, file);
    const previewBuffer = await makePreview(engine);
    const nextSourceId = crypto.randomUUID();

    if (previousMountPath) {
      unmount(engine, previousMountPath);
    }
    currentMountPath = mountPath;
    currentSourceId = nextSourceId;
    currentSourceInfo = info;
    report({ phase: 'preview', percent: 100 });
    return {
      info,
      previewBuffer,
      sourceId: nextSourceId,
    };
  } catch (error) {
    if (candidateOpened) {
      if (previousMountPath) {
        const previousPath = `${previousMountPath}/source.tif`;
        if (!callNumber(engine, 'fc_open', ['string'], [previousPath])) {
          callVoid(engine, 'fc_close');
          currentMountPath = null;
          currentSourceId = null;
          currentSourceInfo = null;
        }
      } else {
        callVoid(engine, 'fc_close');
      }
    }
    if (candidateMounted) {
      unmount(engine, mountPath);
    } else {
      engine.FS.rmdir(mountPath);
    }
    throw error;
  }
}

function exportCrop(
  engine: Engine,
  crop: CropBox,
  expectedSourceId: string,
  rotation: QuarterTurn,
): ArrayBuffer {
  if (!currentSourceInfo || !currentSourceId || !currentMountPath) {
    throw new Error('Open a TIFF first.');
  }
  if (currentSourceId !== expectedSourceId) {
    throw new Error('The source TIFF changed. Export stopped.');
  }
  if (!isValidCrop(crop, rotatedBounds(currentSourceInfo, rotation))) {
    throw new Error(`“${crop.name}” is outside the source image.`);
  }

  const rawBytes =
    BigInt(crop.width) *
    BigInt(crop.height) *
    BigInt(currentSourceInfo.bands) *
    BigInt(currentSourceInfo.bitDepth / 8);
  if (rawBytes > MAX_RAW_CROP_BYTES) {
    throw new Error('One frame exceeds the 384 MiB raw-pixel limit.');
  }

  const outputPath = `${OUTPUT_ROOT}/${crypto.randomUUID()}.tif`;
  report({ phase: 'export', percent: 2 });
  try {
    if (
      !callNumber(
        engine,
        'fc_export_crop',
        ['number', 'number', 'number', 'number', 'number', 'string'],
        [
          crop.x,
          crop.y,
          crop.width,
          crop.height,
          rotation,
          outputPath,
        ],
      )
    ) {
      throw new Error(lastError(engine));
    }

    report({ phase: 'export', percent: 96 });
    const bytes = engine.FS.readFile(outputPath);
    const result = bytes.buffer;
    report({ phase: 'export', percent: 100 });
    return result;
  } finally {
    try {
      engine.FS.unlink(outputPath);
    } catch {
      // A failed export may not have created the output file.
    }
  }
}

async function disposeSource() {
  const engine = await getEngine();
  callVoid(engine, 'fc_close');
  if (currentMountPath) {
    unmount(engine, currentMountPath);
  }
  currentMountPath = null;
  currentSourceId = null;
  currentSourceInfo = null;
}

self.addEventListener(
  'message',
  async (event: MessageEvent<WorkerRequest>) => {
    const request = event.data;
    try {
      let result: LoadedSource | ArrayBuffer | undefined;
      if (request.type === 'load') {
        result = await loadSource(request.file);
      } else if (request.type === 'export') {
        result = exportCrop(
          await getEngine(),
          request.crop,
          request.sourceId,
          request.rotation,
        );
      } else {
        await disposeSource();
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
