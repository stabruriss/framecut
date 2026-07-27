export interface CropBox {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageBounds {
  width: number;
  height: number;
}

export type QuarterTurn = 0 | 1 | 2 | 3;

export interface SourceInfo extends ImageBounds {
  bands: number;
  bitDepth: number;
  fileName: string;
  fileSize: number;
  format: string;
  hasIccProfile: boolean;
  interpretation: string;
  orientation: number;
  pageCount: number;
  xResolutionDpi: number | null;
  yResolutionDpi: number | null;
}

export interface LoadedSource {
  info: SourceInfo;
  previewBuffer: ArrayBuffer;
  sourceId: string;
}

export interface WorkerProgress {
  phase: 'engine' | 'preview' | 'export';
  percent: number;
}
