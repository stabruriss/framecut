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
      <button aria-label="关闭提示" onClick={onClose} type="button">
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
  throw new Error('无法为这次输出创建唯一的文件夹。');
}

export default function App({
  createEngine,
  processingSupported,
  unsupportedMessage = '当前页面缺少运行 TIFF 引擎所需的浏览器能力。',
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
          text: 'Framecut 当前只接受 .tif 或 .tiff 文件。',
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
            text: `这是一个 ${loaded.info.pageCount} 页 TIFF；首版目前只打开第 1 页。`,
          });
        } else if (file.size > 350 * 1024 * 1024) {
          setNotice({
            kind: 'warning',
            text: '这个文件较大。浏览器版会占用较多内存，请先画一个小框测试输出。',
          });
        }
      } catch (error) {
        setNotice({
          kind: 'error',
          text: error instanceof Error ? error.message : '无法打开这个 TIFF。',
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
          name: `画面 ${String(current.length + 1).padStart(2, '0')}`,
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
          text: '画面里没有足够空间放下一个不重叠的同尺寸裁切框。',
        });
        return;
      }

      const id = crypto.randomUUID();
      setCrops([
        ...crops,
        {
          ...duplicate,
          id,
          name: `画面 ${String(crops.length + 1).padStart(2, '0')}`,
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
              text: 'Chrome 会在授权前拦截“下载”等根目录，自动新建子文件夹也无法绕过；请先进入一个普通文件夹再选择。',
            });
            return;
          }
          if (error instanceof DOMException && error.name === 'AbortError') {
            return;
          }
          zip = new StoredZipBuilder(estimatedRawBytes);
          setNotice({
            kind: 'warning',
            text: '无法写入文件夹，完成后将改为下载一个 ZIP。',
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
          ? `已无损输出 ${crops.length} 张 TIFF 到“${batchName}”。`
          : `包含 ${crops.length} 张 TIFF 的 ZIP 已准备好，请点击下载。`,
      });
    } catch (error) {
      setNotice({
        kind: 'error',
        text:
          error instanceof Error
            ? `输出中断：${error.message}`
            : '输出中断。',
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
          title="打开另一个 TIFF"
          type="button"
        >
          <span className="wordmark-mark" aria-hidden="true">
            <span />
          </span>
          <span>
            <strong>Framecut</strong>
            <small>TIFF CONTACT SHEET CUTTER</small>
          </span>
        </button>

        <div className="privacy-stamp">
          <LockKeyhole size={14} />
          <span>只在本机处理 · 不上传</span>
        </div>

        <div className="header-actions">
          <button
            className="license-open"
            onClick={() => setShowLicenses(true)}
            title="查看第三方许可"
            type="button"
          >
            <Info size={14} />
            许可
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
                换一张
              </button>

              <section
                aria-label="输出"
                className="header-export"
              >
                <div className="header-export-meta">
                  <div>
                    <span>输出</span>
                    <strong>{crops.length} 张</strong>
                  </div>
                  <div>
                    <span>裸像素</span>
                    <strong>
                      {crops.length
                        ? `约 ${formatBytes(estimatedRawBytes)}`
                        : '—'}
                    </strong>
                  </div>
                </div>

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
                          ? '选择保存位置并输出'
                          : '生成 ZIP 并下载'}
                    </strong>
                    <small>
                      {busy === 'exporting' && exportState
                        ? exportState.fileName
                        : directoryOutputSupported
                          ? '自动新建时间戳文件夹'
                          : '当前浏览器不支持目录写入'}
                    </small>
                  </span>
                </button>

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
                        下载 {pendingDownload.fileName}
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
            <p className="eyebrow">LOCAL / LOSSLESS / OVERLAP OK</p>
            <h1>
              把整版扫描，
              <br />
              重新变成照片。
            </h1>
            <p className="intro-text">
              拖入 TIFF，手工画出每一格。预览只负责定位，正式裁切直接读取原始像素。
            </p>
            <div className="feature-ledger">
              <span>
                <i>01</i> 8 / 16-bit TIFF
              </span>
              <span>
                <i>02</i> 裁切框允许重叠
              </span>
              <span>
                <i>03</i> 文件夹 / ZIP 输出
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
                  ? '正在建立预览…'
                  : '把 TIFF 拖到这里'}
              </strong>
              <small>或点击选择文件</small>
              <span className="drop-footnote">文件不会离开这台电脑</span>
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
                {source.info.bitDepth}-bit · {source.info.bands} 通道
              </span>
              <span>{formatBytes(source.info.fileSize)}</span>
              <span>
                {source.info.hasIccProfile ? (
                  <>
                    <ShieldCheck size={13} /> ICC
                  </>
                ) : (
                  '无 ICC'
                )}
              </span>
            </div>
          </section>

          <aside className="crop-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">CUT LIST</p>
                <h2>裁切清单</h2>
              </div>
              <span className="frame-count">{crops.length}</span>
            </div>

            {crops.length === 0 ? (
              <div className="crop-empty">
                <Crop size={26} />
                <strong>还没有裁切框</strong>
                <p>选择画框工具，在照片预览上拖动。框可以互相重叠。</p>
                <button onClick={() => setTool('draw')} type="button">
                  开始画框 <ChevronRight size={15} />
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
                      aria-label={`删除${crop.name}`}
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
          <strong>松手打开这张 TIFF</strong>
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
                <h2 id="license-title">第三方许可</h2>
              </div>
              <button
                aria-label="关闭第三方许可"
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
