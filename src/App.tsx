import {
  AlertTriangle,
  Check,
  ChevronRight,
  Crop,
  Download,
  FileImage,
  FolderOutput,
  HardDrive,
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
import { cropArea } from './lib/geometry';
import {
  fileStem,
  formatBytes,
  formatNumber,
  outputFileName,
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

async function existingOutputNames(
  directory: FileSystemDirectoryHandle,
  names: string[],
): Promise<string[]> {
  const existing: string[] = [];
  for (const name of names) {
    try {
      await directory.getFileHandle(name);
      existing.push(name);
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'NotFoundError') {
        throw error;
      }
    }
  }
  return existing;
}

export default function App({
  createEngine,
  processingSupported,
  unsupportedMessage = '当前页面缺少运行 TIFF 引擎所需的浏览器能力。',
}: AppProps) {
  const worker = useMemo(createEngine, [createEngine]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const operationRef = useRef<'loading' | 'exporting' | null>(null);
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
      } else if (event.key.toLowerCase() === 'v') {
        setTool('select');
      } else if (event.key.toLowerCase() === 'd') {
        setTool('draw');
      } else if (event.key.toLowerCase() === 'h') {
        setTool('hand');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedId, showLicenses]);

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

      if (window.showDirectoryPicker) {
        try {
          directory = await window.showDirectoryPicker({
            id: 'framecut-output-v2',
            mode: 'readwrite',
            startIn: 'pictures',
          });
        } catch (error) {
          if (isSensitiveDirectoryError(error)) {
            setNotice({
              kind: 'error',
              text: 'Chrome 不允许直接写入受保护的根目录；请进入或新建一个普通子文件夹。',
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
        outputFileName(source.file.name, index, crops.length),
      );
      if (directory) {
        try {
          const existing = await existingOutputNames(directory, names);
          if (
            existing.length > 0 &&
            !window.confirm(
              `输出文件夹里已有 ${existing.length} 个同名文件。继续会覆盖它们，是否继续？`,
            )
          ) {
            return;
          }
        } catch {
          setNotice({
            kind: 'error',
            text: '无法检查输出文件夹中的现有文件。',
          });
          return;
        }
      }

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
          fileName: `${fileStem(source.file.name)}_framecut.zip`,
          url: URL.createObjectURL(archive),
        });
      }

      setNotice({
        kind: 'success',
        text: directory
          ? `已无损输出 ${crops.length} 张 TIFF。`
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
            <button
              className="header-open"
              disabled={busy !== null}
              onClick={() => fileInputRef.current?.click()}
              type="button"
            >
              <Plus size={15} />
              换一张
            </button>
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

            <div className="output-summary">
              <div>
                <span>输出</span>
                <strong>{crops.length} 张 TIFF</strong>
              </div>
              <div>
                <span>裸像素合计</span>
                <strong>
                  {crops.length ? `约 ${formatBytes(estimatedRawBytes)}` : '—'}
                </strong>
              </div>
            </div>

            {notice && (
              <NoticeBanner
                notice={notice}
                onClose={() => setNotice(null)}
              />
            )}

            <div className="panel-actions">
              <button
                className="export-button"
                disabled={
                  busy !== null || crops.length === 0
                }
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
                        ? '选择输出子文件夹'
                        : '生成 ZIP 并下载'}
                  </strong>
                  <small>
                    {busy === 'exporting' && exportState
                      ? exportState.fileName
                      : `${source.info.bitDepth}-bit 原样裁切 · 无重采样`}
                  </small>
                </span>
              </button>
              {directoryOutputSupported ? (
                <p className="browser-warning folder-guidance">
                  <HardDrive size={14} />
                  请新建或进入一个子文件夹；Chrome 会拦截“下载”“桌面”等根目录。
                </p>
              ) : (
                <p className="browser-warning">
                  <HardDrive size={14} />
                  当前浏览器不支持目录写入，将下载一个 ZIP。
                </p>
              )}
              {pendingDownload && (
                <a
                  className="download-button"
                  download={pendingDownload.fileName}
                  href={pendingDownload.url}
                  onClick={() => {
                    window.setTimeout(() => setPendingDownload(null), 1000);
                  }}
                >
                  <Download size={16} />
                  下载 {pendingDownload.fileName}
                </a>
              )}
            </div>
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
