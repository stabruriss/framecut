import type {
  CropBox,
  LoadedSource,
  QuarterTurn,
  WorkerProgress,
} from './model';

export interface TiffEngineClient {
  onProgress: ((progress: WorkerProgress) => void) | null;
  load(file: File): Promise<LoadedSource>;
  exportCrop(
    crop: CropBox,
    sourceId: string,
    rotation: QuarterTurn,
  ): Promise<ArrayBuffer>;
  disposeSource(): Promise<void>;
  terminate(): void;
}
