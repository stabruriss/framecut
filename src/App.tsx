import {
  AlertTriangle,
  Check,
  ChevronRight,
  Crop,
  Download,
  FileImage,
  FolderOutput,
  Info,
  LoaderCircle,
  LockKeyhole,
  Plus,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  type ChangeEvent,
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import thirdPartyNotices from '../THIRD_PARTY_NOTICES.md?raw';
import { EditorStage, type EditorTool } from './components/EditorStage';
import {
  cropArea,
  findDuplicatePosition,
  type CropGeometry,
} from './lib/geometry';
import {
  batchOutputFileName,
  formatBytes,
  formatNumber,
  outputBatchName,
} from './lib/format';
import type {
  CropBox,
  SourceInfo,
  WorkerProgress,
} from './lib/model';
import type { TiffEngineClient } from './lib/tiff-engine-client';
import { StoredZipBuilder } from './lib/zip-output';

interface OpenSource {
  file: File;
  info: SourceInfo;
  previewUrl: string;
  sourceId: string;
}

interface Notice {
  kind: 'error' | 'success' | 'warning';
  text: string;
}

interface ExportState {
  current: number;
  fileName: string;
  total: number;
}

interface PendingDownload {
  fileName: string;
  url: string;
}

interface AppProps {
  createEngine: () => TiffEngineClient;
  processingSupported: boolean;
  unsupportedMessage?: string;
}

function NoticeBanner({
  className = '',
  notice,
  onClose,
}: {
  className?: string;
  notice: Notice;
  onClose: () => void;
}) {
  return (
    <div className={`notice ${notice.kind} ${className}`.trim()}>
      {notice.kind === 'success' ? (
        <Check size={16} />
      ) : notice.kind === 'warning' ? (
        <Info size={16} />
      ) : (
        <AlertTriangle size={16} />
      )}
      <span>{notice.text}</span>
      <button aria-label="Dismiss" onClick={onClose} type="button">
        <X size={14} />
      </button>
    </div>
  );
}

const isTiff = (file: File) =>
  /\.(tif|tiff)$/i.test(file.name) ||
  ['image/tiff', 'image/x-tiff'].includes(file.type);

const isSensitiveDirectoryError = (error: unknown) =>
  error instanceof DOMException &&
  error.name === 'AbortError' &&
  /system|sensitive|dangerous|not allowed|not permitted/i.test(error.message);

async function createUniqueOutputDirectory(
  parent: FileSystemDirectoryHandle,
  baseName: string,
): Promise<{
  directory: FileSystemDirectoryHandle;
  name: string;
}> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const name =
      attempt === 0
        ? baseName
        : `${baseName}-${String(attempt + 1).padStart(2, '0')}`;
    try {
      await parent.getDirectoryHandle(name);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        return {
          directory: await parent.getDirectoryHandle(name, { create: true }),
          name,
        };
      }
      if (error instanceof DOMException && error.name === 'TypeMismatchError') {
        continue;
      }
      throw error;
    }
  }
  throw new Error('Could not create a unique output folder.');
}

export default function App({
  createEngine,
  processingSupported,
  unsupportedMessage = 'This browser cannot run the TIFF engine.',
}: AppProps) {
  const worker = useMemo(createEngine, [createEngine]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const operationRef = useRef<'loading' | 'exporting' | null>(null);
  const copiedCropRef = useRef<CropGeometry | null>(null);
  const [source, setSource] = useState<OpenSource | null>(null);
  const [crops, setCrops] = useState<CropBox[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tool, setTool] = useState<EditorTool>('draw');
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [busy, setBusy] = useState<'loading' | 'exporting' | null>(null);
  const [progress, setProgress] = useState<WorkerProgress | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [exportState, setExportState] = useState<ExportState | null>(null);
  const [pendingDownload, setPendingDownload] =
    useState<PendingDownload | null>(null);
  const [showLicenses, setShowLicenses] = useState(false);

  const directoryOutputSupported =
    typeof window.showDirectoryPicker === 'function';
  useEffect(() => {
    worker.onProgress = setProgress;
    return () => {
      worker.terminate();
    };
  }, [worker]);

  useEffect(
    () => () => {
      if (source) {
        URL.revokeObjectURL(source.previewUrl);
      }
    },
    [source],
  );

  useEffect(
    () => () => {
      if (pendingDownload) {
        URL.revokeObjectURL(pendingDownload.url);
      }
    },
    [pendingDownload],
  );

  const loadFile = useCallback(
    async (file: File) => {
      if (operationRef.current !== null) {
        return;
      }
      if (!processingSupported) {
        setNotice({
          kind: 'error',
          text: unsupportedMessage,
        });
        return;
      }
      if (!isTiff(file)) {
        setNotice({
          kind: 'error',
          text: 'Open a .tif or .tiff file.',
        });
        return;
      }

      operationRef.current = 'loading';
      setBusy('loading');
      setNotice(null);
      setPendingDownload(null);
      setProgress({ phase: 'engine', percent: 0 });

      try {
        const loaded = await worker.load(file);
        const previewUrl = URL.createObjectURL(
          new Blob([loaded.previewBuffer], {
            type: 'image/png',
          }),
        );
        setSource((previous) => {
          if (previous) {
            URL.revokeObjectURL(previous.previewUrl);
          }
          return {
            file,
            info: loaded.info,
            previewUrl,
            sourceId: loaded.sourceId,
          };
        });
        setSelectedId(null);
        setCrops([]);
        copiedCropRef.current = null;
        setTool('draw');

        if (loaded.info.pageCount > 1) {
          setNotice({
            kind: 'warning',
            text: `${loaded.info.pageCount}-page TIFF. Only page 1 is open.`,
          });
        }
      } catch (error) {
        setNotice({
          kind: 'error',
          text: error instanceof Error ? error.message : 'Could not open this TIFF.',
        });
      } finally {
        operationRef.current = null;
        setBusy(null);
        setProgress(null);
      }
    },
    [processingSupported, unsupportedMessage, worker],
  );

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      void loadFile(file);
    }
    event.target.value = '';
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDraggingFile(false);
    if (operationRef.current !== null) {
      return;
    }
    const file = event.dataTransfer.files[0];
    if (file) {
      void loadFile(file);
    }
  };

  const addCrop = useCallback(
    (geometry: Pick<CropBox, 'x' | 'y' | 'width' | 'height'>) => {
      const id = crypto.randomUUID();
      setCrops((current) => [
        ...current,
        {
          ...geometry,
          id,
          name: `Frame ${String(current.length + 1).padStart(2, '0')}`,
        },
      ]);
      setSelectedId(id);
    },
    [],
  );

  const changeCrop = useCallback((next: CropBox) => {
    setCrops((current) =>
      current.map((crop) => (crop.id === next.id ? next : crop)),
    );
  }, []);

  const deleteCrop = (id: string) => {
    setCrops((current) => current.filter((crop) => crop.id !== id));
    setSelectedId((current) => (current === id ? null : current));
  };

  const selectedCrop =
    crops.find((crop) => crop.id === selectedId) ?? null;

  const duplicateCrop = useCallback(
    (geometry: CropGeometry) => {
      if (!source || operationRef.current !== null) {
        return;
      }

      const duplicate = findDuplicatePosition(
        geometry,
        crops,
        source.info,
      );
      if (!duplicate) {
        setNotice({
          kind: 'warning',
          text: 'No room for a non-overlapping copy.',
        });
        return;
      }

      const id = crypto.randomUUID();
      setCrops([
        ...crops,
        {
          ...duplicate,
          id,
          name: `Frame ${String(crops.length + 1).padStart(2, '0')}`,
        },
      ]);
      setSelectedId(id);
      setTool('select');
    },
    [crops, source],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (showLicenses) {
        if (event.key === 'Escape') {
          setShowLicenses(false);
        }
        return;
      }

      const target = event.target as HTMLElement | null;
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      const commandKey = event.metaKey || event.ctrlKey;
      if (commandKey && key === 'c') {
        if (
          !event.repeat &&
          operationRef.current === null &&
          selectedCrop
        ) {
          event.preventDefault();
          copiedCropRef.current = {
            x: selectedCrop.x,
            y: selectedCrop.y,
            width: selectedCrop.width,
            height: selectedCrop.height,
          };
        }
        return;
      }
      if (commandKey && key === 'v') {
        if (
          !event.repeat &&
          operationRef.current === null &&
          copiedCropRef.current
        ) {
          event.preventDefault();
          duplicateCrop(copiedCropRef.current);
        }
        return;
      }
      if (commandKey || event.altKey) {
        return;
      }

      if (
        operationRef.current === null &&
        (event.key === 'Delete' || event.key === 'Backspace') &&
        selectedId
      ) {
        event.preventDefault();
        setCrops((current) =>
          current.filter((crop) => crop.id !== selectedId),
        );
        setSelectedId(null);
      } else if (key === 'v') {
        setTool('select');
      } else if (key === 'd') {
        setTool('draw');
      } else if (key === 'h') {
        setTool('hand');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [duplicateCrop, selectedCrop, selectedId, showLicenses]);

  const exportCrops = async () => {
    if (
      !source ||
      crops.length === 0 ||
      operationRef.current !== null
    ) {
      return;
    }

    operationRef.current = 'exporting';
    setBusy('exporting');
    setNotice(null);
    setPendingDownload(null);
    try {
      let directory: FileSystemDirectoryHandle | null = null;
      let zip: StoredZipBuilder | null = null;
      let batchName = outputBatchName(new Date());

      if (window.showDirectoryPicker) {
        try {
          const parentDirectory = await window.showDirectoryPicker({
            id: 'framecut-output-v3',
            mode: 'readwrite',
            startIn: 'downloads',
          });
          const outputDirectory = await createUniqueOutputDirectory(
            parentDirectory,
            batchName,
          );
          directory = outputDirectory.directory;
          batchName = outputDirectory.name;
        } catch (error) {
          if (isSensitiveDirectoryError(error)) {
            setNotice({
              kind: 'error',
              text: 'Chrome blocks protected folders such as Downloads. Choose a folder inside one.',
            });
            return;
          }
          if (error instanceof DOMException && error.name === 'AbortError') {
            return;
          }
          zip = new StoredZipBuilder(estimatedRawBytes);
          setNotice({
            kind: 'warning',
            text: 'Folder unavailable. Building a ZIP instead.',
          });
        }
      } else {
        zip = new StoredZipBuilder(estimatedRawBytes);
      }

      const names = crops.map((_, index) =>
        batchOutputFileName(batchName, index, crops.length),
      );

      for (let index = 0; index < crops.length; index += 1) {
        const fileName = names[index];
        setExportState({
          current: index + 1,
          fileName,
          total: crops.length,
        });
        const buffer = await worker.exportCrop(
          crops[index],
          source.sourceId,
        );
        if (directory) {
          const fileHandle = await directory.getFileHandle(fileName, {
            create: true,
          });
          const writable = await fileHandle.createWritable();
          try {
            await writable.write(
              new Blob([buffer], {
                type: 'image/tiff',
              }),
            );
            await writable.close();
          } catch (error) {
            try {
              await writable.abort();
            } catch {
              // The stream may already be closed by the browser.
            }
            throw error;
          }
        } else {
          zip?.add(fileName, buffer);
        }
      }

      if (zip) {
        const archive = await zip.finish();
        setPendingDownload({
          fileName: `${batchName}.zip`,
          url: URL.createObjectURL(archive),
        });
      }

      setNotice({
        kind: 'success',
        text: directory
          ? `Exported ${crops.length} TIFF${crops.length === 1 ? '' : 's'} to “${batchName}”.`
          : `ZIP with ${crops.length} TIFF${crops.length === 1 ? '' : 's'} is ready.`,
      });
    } catch (error) {
      setNotice({
        kind: 'error',
        text:
          error instanceof Error
            ? `Export stopped: ${error.message}`
            : 'Export stopped.',
      });
    } finally {
      operationRef.current = null;
      setBusy(null);
      setExportState(null);
      setProgress(null);
    }
  };

  const totalPixels = crops.reduce(
    (total, crop) => total + cropArea(crop),
    0,
  );
  const estimatedRawBytes = source
    ? totalPixels *
      source.info.bands *
      Math.ceil(source.info.bitDepth / 8)
    : 0;
  const activePercent =
    busy === 'exporting' && exportState
      ? ((exportState.current - 1 + (progress?.percent ?? 0) / 100) /
          exportState.total) *
        100
      : (progress?.percent ?? 0);

  return (
    <div
      className={`app-shell ${isDraggingFile ? 'file-dragging' : ''}`}
      onDragEnter={(event) => {
        event.preventDefault();
        if (operationRef.current === null) {
          setIsDraggingFile(true);
        }
      }}
      onDragLeave={(event) => {
        const nextTarget = event.relatedTarget;
        if (
          !(nextTarget instanceof Node) ||
          !event.currentTarget.contains(nextTarget)
        ) {
          setIsDraggingFile(false);
        }
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      <header className="app-header">
        <button
          className="wordmark"
          disabled={busy !== null}
          onClick={() => fileInputRef.current?.click()}
          title="Open another TIFF"
          type="button"
        >
          <span className="wordmark-mark" aria-hidden="true">
            <span />
          </span>
          <span>
            <strong>Framecut</strong>
            <small>NEGATIVE ROLL CUTTER</small>
          </span>
        </button>

        <div className="privacy-stamp">
          <LockKeyhole size={14} />
          <span>LOCAL ONLY · NO UPLOAD</span>
        </div>

        <div className="header-actions">
          <button
            className="license-open"
            onClick={() => setShowLicenses(true)}
            title="Third-party licenses"
            type="button"
          >
            <Info size={14} />
            Licenses
          </button>
          {source && (
            <>
              <button
                className="header-open"
                disabled={busy !== null}
                onClick={() => fileInputRef.current?.click()}
                type="button"
              >
                <Plus size={15} />
                New TIFF
              </button>

              <section
                aria-label="Export"
                className="header-export"
              >
                <div className="header-export-meta">
                  <div>
                    <span>FILES</span>
                    <strong>
                      {crops.length} TIFF{crops.length === 1 ? '' : 's'}
                    </strong>
                  </div>
                  <div>
                    <span>RAW SIZE</span>
                    <strong>
                      {crops.length
                        ? `~${formatBytes(estimatedRawBytes)}`
                        : '—'}
                    </strong>
                  </div>
                </div>

                <div className="header-export-action">
                  <button
                    className="export-button"
                    disabled={busy !== null || crops.length === 0}
                    onClick={() => void exportCrops()}
                    type="button"
                  >
                    {busy === 'exporting' ? (
                      <LoaderCircle className="spin" size={18} />
                    ) : (
                      <FolderOutput size={18} />
                    )}
                    <span>
                      <strong>
                        {busy === 'exporting' && exportState
                          ? `${exportState.current} / ${exportState.total}`
                          : directoryOutputSupported
                            ? 'Choose Folder & Export'
                            : 'Build ZIP'}
                      </strong>
                      {(!directoryOutputSupported ||
                        (busy === 'exporting' && exportState)) && (
                        <small>
                          {busy === 'exporting' && exportState
                            ? exportState.fileName
                            : 'Folder access unavailable'}
                        </small>
                      )}
                    </span>
                  </button>
                  {directoryOutputSupported && (
                    <p className="folder-picker-hint">
                      Choose a subfolder — not Downloads itself.
                    </p>
                  )}
                </div>

                {(notice || pendingDownload) && (
                  <div className="header-export-feedback">
                    {notice && (
                      <NoticeBanner
                        notice={notice}
                        onClose={() => setNotice(null)}
                      />
                    )}
                    {pendingDownload && (
                      <a
                        className="download-button"
                        download={pendingDownload.fileName}
                        href={pendingDownload.url}
                        onClick={() => {
                          window.setTimeout(
                            () => setPendingDownload(null),
                            1000,
                          );
                        }}
                      >
                        <Download size={16} />
                        Download {pendingDownload.fileName}
                      </a>
                    )}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
        <input
          accept=".tif,.tiff,image/tiff"
          className="visually-hidden"
          disabled={busy !== null}
          onChange={handleFileInput}
          ref={fileInputRef}
          type="file"
        />
      </header>

      {busy && (
        <div className="operation-line">
          <span style={{ width: `${activePercent}%` }} />
        </div>
      )}

      {!source ? (
        <main className="empty-workspace">
          <section className="intro-copy">
            <p className="eyebrow">LOCAL / LOSSLESS</p>
            <h1>
              CUT NEGATIVE SCAN
              <br />
              {' '}TO FRAMES
            </h1>
            <p className="intro-text">
              Drop TIFF, Draw Frames, Cut Lossless
            </p>
            <div className="feature-ledger">
              <span>
                <i>01</i> Drop TIFF (8/16-bit)
              </span>
              <span>
                <i>02</i> Cut to Frames
              </span>
              <span>
                <i>03</i> Export Locally
              </span>
              <span>
                <i>04</i> Import to Lightroom
              </span>
            </div>
          </section>

          <div className="empty-action">
            <button
              className="drop-table"
              disabled={busy !== null}
              onClick={() => fileInputRef.current?.click()}
              type="button"
            >
              <span className="registration-mark top-left" />
              <span className="registration-mark top-right" />
              <span className="registration-mark bottom-left" />
              <span className="registration-mark bottom-right" />
              <span className="drop-film">
                {busy === 'loading' ? (
                  <LoaderCircle className="spin" size={38} />
                ) : (
                  <Upload size={36} />
                )}
              </span>
              <strong>
                {busy === 'loading'
                  ? 'BUILDING PREVIEW…'
                  : 'DROP TIFF'}
              </strong>
              <small>or choose a file</small>
            </button>
            {notice && (
              <NoticeBanner
                className="empty-notice"
                notice={notice}
                onClose={() => setNotice(null)}
              />
            )}
          </div>

          {!processingSupported && (
            <div className="compatibility-note error">
              <AlertTriangle size={16} />
              {unsupportedMessage}
            </div>
          )}
        </main>
      ) : (
        <main className="editor-layout">
          <section className="canvas-column">
            <EditorStage
              bounds={source.info}
              crops={crops}
              disabled={busy !== null}
              onAdd={addCrop}
              onChange={changeCrop}
              onDuplicate={() => {
                if (selectedCrop) {
                  duplicateCrop(selectedCrop);
                }
              }}
              onSelect={setSelectedId}
              onToolChange={setTool}
              previewUrl={source.previewUrl}
              selectedId={selectedId}
              tool={tool}
            />
            <div className="source-strip">
              <span>
                <FileImage size={14} />
                {source.file.name}
              </span>
              <span>
                {formatNumber(source.info.width)} ×{' '}
                {formatNumber(source.info.height)}
              </span>
              <span>
                {source.info.bitDepth}-bit · {source.info.bands} channels
              </span>
              <span>{formatBytes(source.info.fileSize)}</span>
              <span>
                {source.info.hasIccProfile ? (
                  <>
                    <ShieldCheck size={13} /> ICC
                  </>
                ) : (
                  'No ICC'
                )}
              </span>
            </div>
          </section>

          <aside className="crop-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">FRAME INDEX</p>
                <h2>Selected Frames</h2>
              </div>
              <span className="frame-count">{crops.length}</span>
            </div>

            {crops.length === 0 ? (
              <div className="crop-empty">
                <Crop size={26} />
                <strong>No Frames Yet</strong>
                <p>Draw on the preview. Overlap is allowed.</p>
                <button onClick={() => setTool('draw')} type="button">
                  Draw Frame <ChevronRight size={15} />
                </button>
              </div>
            ) : (
              <ol className="crop-list">
                {crops.map((crop, index) => (
                  <li
                    className={crop.id === selectedId ? 'selected' : ''}
                    key={crop.id}
                  >
                    <button
                      className="crop-index"
                      onClick={() => {
                        setSelectedId(crop.id);
                        setTool('select');
                      }}
                      type="button"
                    >
                      {String(index + 1).padStart(2, '0')}
                    </button>
                    <button
                      className="crop-description"
                      onClick={() => {
                        setSelectedId(crop.id);
                        setTool('select');
                      }}
                      type="button"
                    >
                      <strong>{crop.name}</strong>
                      <small>
                        {formatNumber(crop.width)} ×{' '}
                        {formatNumber(crop.height)} px
                      </small>
                    </button>
                    <button
                      aria-label={`Delete ${crop.name}`}
                      className="crop-delete"
                      disabled={busy !== null}
                      onClick={() => deleteCrop(crop.id)}
                      type="button"
                    >
                      <Trash2 size={15} />
                    </button>
                  </li>
                ))}
              </ol>
            )}

          </aside>
        </main>
      )}

      {isDraggingFile && (
        <div className="global-drop-overlay">
          <Upload size={38} />
          <strong>Release to Open</strong>
        </div>
      )}

      {showLicenses && (
        <div
          className="license-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setShowLicenses(false);
            }
          }}
        >
          <section
            aria-labelledby="license-title"
            aria-modal="true"
            className="license-dialog"
            role="dialog"
          >
            <header>
              <div>
                <p className="eyebrow">OPEN SOURCE</p>
                <h2 id="license-title">Third-Party Licenses</h2>
              </div>
              <button
                aria-label="Close licenses"
                onClick={() => setShowLicenses(false)}
                type="button"
              >
                <X size={18} />
              </button>
            </header>
            <pre>{thirdPartyNotices}</pre>
          </section>
        </div>
      )}
    </div>
  );
}
