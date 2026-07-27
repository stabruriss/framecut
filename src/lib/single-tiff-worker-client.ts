import SingleTiffWorker from '../workers/single-tiff.worker?worker&inline';
import type {
  CropBox,
  LoadedSource,
  QuarterTurn,
  WorkerProgress,
} from './model';
import type { TiffEngineClient } from './tiff-engine-client';

interface WorkerSuccess<T> {
  id: number;
  ok: true;
  result: T;
}

interface WorkerFailure {
  error: string;
  id: number;
  ok: false;
}

interface ProgressMessage {
  progress: WorkerProgress;
  type: 'progress';
}

type WorkerResponse<T> = WorkerSuccess<T> | WorkerFailure | ProgressMessage;

interface PendingRequest<T> {
  reject: (reason: Error) => void;
  resolve: (value: T) => void;
}

export class SingleTiffWorkerClient implements TiffEngineClient {
  private readonly worker = new SingleTiffWorker();
  private requestId = 0;
  private readonly pending = new Map<number, PendingRequest<unknown>>();

  onProgress: ((progress: WorkerProgress) => void) | null = null;

  constructor() {
    this.worker.addEventListener(
      'message',
      (event: MessageEvent<WorkerResponse<unknown>>) => {
        const response = event.data;
        if ('type' in response) {
          this.onProgress?.(response.progress);
          return;
        }

        const pending = this.pending.get(response.id);
        if (!pending) {
          return;
        }

        this.pending.delete(response.id);
        if (response.ok) {
          pending.resolve(response.result);
        } else {
          pending.reject(new Error(response.error));
        }
      },
    );

    this.worker.addEventListener('error', (event) => {
      const error = new Error(event.message || 'TIFF worker stopped.');
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  load(file: File): Promise<LoadedSource> {
    return this.request<LoadedSource>({
      type: 'load',
      file,
    });
  }

  exportCrop(
    crop: CropBox,
    sourceId: string,
    rotation: QuarterTurn,
  ): Promise<ArrayBuffer> {
    return this.request<ArrayBuffer>({
      type: 'export',
      crop,
      sourceId,
      rotation,
    });
  }

  disposeSource(): Promise<void> {
    return this.request<void>({
      type: 'dispose-source',
    });
  }

  terminate() {
    this.worker.terminate();
    const error = new Error('TIFF worker is closed.');
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private request<T>(payload: Record<string, unknown>): Promise<T> {
    const id = ++this.requestId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.worker.postMessage({
        ...payload,
        id,
      });
    });
  }
}
