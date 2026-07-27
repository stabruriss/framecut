import type {
  CropBox,
  LoadedSource,
  WorkerProgress,
} from './model';

export interface TiffEngineClient {
  onProgress: ((progress: WorkerProgress) => void) | null;
  load(file: File): Promise<LoadedSource>;
  exportCrop(crop: CropBox, sourceId: string): Promise<ArrayBuffer>;
  disposeSource(): Promise<void>;
  terminate(): void;
}
