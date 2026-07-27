import {
  CopyPlus,
  Crop,
  Hand,
  Maximize,
  MousePointer2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  cropFromDrag,
  moveCrop,
  resizeCrop,
  type Point,
} from '../lib/geometry';
import type { CropBox, ImageBounds } from '../lib/model';

export type EditorTool = 'select' | 'draw' | 'hand';

interface EditorStageProps {
  bounds: ImageBounds;
  crops: CropBox[];
  disabled?: boolean;
  previewUrl: string;
  selectedId: string | null;
  tool: EditorTool;
  onAdd: (crop: Pick<CropBox, 'x' | 'y' | 'width' | 'height'>) => void;
  onChange: (crop: CropBox) => void;
  onDuplicate: () => void;
  onSelect: (id: string | null) => void;
  onToolChange: (tool: EditorTool) => void;
}

type Corner = 'nw' | 'ne' | 'se' | 'sw';

type Interaction =
  | {
      type: 'draw';
      pointerId: number;
      start: Point;
    }
  | {
      type: 'move';
      pointerId: number;
      start: Point;
      original: CropBox;
    }
  | {
      type: 'resize';
      pointerId: number;
      corner: Corner;
      original: CropBox;
    }
  | {
      type: 'pan';
      pointerId: number;
      start: Point;
      original: Point;
      deselectOnClick: boolean;
      moved: boolean;
    };

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), maximum);

export function EditorStage({
  bounds,
  crops,
  disabled = false,
  previewUrl,
  selectedId,
  tool,
  onAdd,
  onChange,
  onDuplicate,
  onSelect,
  onToolChange,
}: EditorStageProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const interactionRef = useRef<Interaction | null>(null);
  const [viewport, setViewport] = useState({ width: 1, height: 1 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [spacePressed, setSpacePressed] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const spacePressedRef = useRef(false);
  const [draft, setDraft] = useState<
    Pick<CropBox, 'x' | 'y' | 'width' | 'height'> | null
  >(null);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      setViewport({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [previewUrl]);

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.code !== 'Space' ||
        event.repeat ||
        isEditableTarget(event.target)
      ) {
        return;
      }
      event.preventDefault();
      spacePressedRef.current = true;
      setSpacePressed(true);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space') {
        return;
      }
      if (spacePressedRef.current) {
        event.preventDefault();
      }
      spacePressedRef.current = false;
      setSpacePressed(false);
    };
    const handleBlur = () => {
      spacePressedRef.current = false;
      setSpacePressed(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  const fitScale = useMemo(
    () =>
      Math.min(
        Math.max(1, viewport.width - 56) / bounds.width,
        Math.max(1, viewport.height - 56) / bounds.height,
      ),
    [bounds.height, bounds.width, viewport.height, viewport.width],
  );

  const stageWidth = bounds.width * fitScale;
  const stageHeight = bounds.height * fitScale;
  const base = {
    x: (viewport.width - stageWidth) / 2,
    y: (viewport.height - stageHeight) / 2,
  };
  const screenScale = Math.max(0.0001, fitScale * zoom);
  const selected = crops.find((crop) => crop.id === selectedId) ?? null;

  const imagePoint = (clientX: number, clientY: number): Point => {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) {
      return { x: 0, y: 0 };
    }
    const point = new DOMPoint(clientX, clientY).matrixTransform(
      matrix.inverse(),
    );
    return {
      x: clamp(point.x, 0, bounds.width),
      y: clamp(point.y, 0, bounds.height),
    };
  };

  const capture = (pointerId: number) => {
    svgRef.current?.setPointerCapture(pointerId);
  };

  const beginDraw = (event: ReactPointerEvent<SVGElement>) => {
    if (disabled || event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const start = imagePoint(event.clientX, event.clientY);
    interactionRef.current = {
      type: 'draw',
      pointerId: event.pointerId,
      start,
    };
    setDraft(cropFromDrag(start, start, bounds));
    capture(event.pointerId);
  };

  const beginPan = (
    event: ReactPointerEvent<SVGElement>,
    deselectOnClick = false,
  ) => {
    if (disabled || (event.button !== 0 && event.button !== 1)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    interactionRef.current = {
      type: 'pan',
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      original: pan,
      deselectOnClick,
      moved: false,
    };
    setIsPanning(true);
    capture(event.pointerId);
  };

  const handleBackgroundPointerDown = (
    event: ReactPointerEvent<SVGSVGElement>,
  ) => {
    if (disabled || event.button === 2) {
      return;
    }

    if (
      event.button === 1 ||
      spacePressedRef.current ||
      tool === 'hand' ||
      tool === 'select'
    ) {
      beginPan(
        event,
        event.button === 0 &&
          !spacePressedRef.current &&
          tool === 'select',
      );
      return;
    }

    if (tool === 'draw') {
      beginDraw(event);
      return;
    }

    onSelect(null);
  };

  const handleCropPointerDown = (
    event: ReactPointerEvent<SVGRectElement>,
    crop: CropBox,
  ) => {
    if (disabled || event.button === 2) {
      return;
    }
    if (
      event.button === 1 ||
      spacePressedRef.current ||
      tool === 'hand'
    ) {
      beginPan(event);
      return;
    }
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onSelect(crop.id);
    onToolChange('select');
    interactionRef.current = {
      type: 'move',
      pointerId: event.pointerId,
      start: imagePoint(event.clientX, event.clientY),
      original: crop,
    };
    capture(event.pointerId);
  };

  const beginResize = (
    event: ReactPointerEvent<SVGRectElement>,
    crop: CropBox,
    corner: Corner,
  ) => {
    if (disabled || event.button === 2) {
      return;
    }
    if (
      event.button === 1 ||
      spacePressedRef.current ||
      tool === 'hand'
    ) {
      beginPan(event);
      return;
    }
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    interactionRef.current = {
      type: 'resize',
      pointerId: event.pointerId,
      corner,
      original: crop,
    };
    capture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) {
      return;
    }

    if (interaction.type === 'pan') {
      const delta = {
        x: event.clientX - interaction.start.x,
        y: event.clientY - interaction.start.y,
      };
      if (!interaction.moved && Math.hypot(delta.x, delta.y) < 3) {
        return;
      }
      interaction.moved = true;
      setPan({
        x: interaction.original.x + delta.x,
        y: interaction.original.y + delta.y,
      });
      return;
    }

    const point = imagePoint(event.clientX, event.clientY);
    if (interaction.type === 'draw') {
      setDraft(cropFromDrag(interaction.start, point, bounds));
      return;
    }

    if (interaction.type === 'move') {
      const delta = {
        x: point.x - interaction.start.x,
        y: point.y - interaction.start.y,
      };
      onChange({
        ...interaction.original,
        ...moveCrop(interaction.original, delta, bounds),
      });
      return;
    }

    const geometry = resizeCrop(
      interaction.original,
      interaction.corner,
      point,
      bounds,
    );
    if (geometry.width >= 1 && geometry.height >= 1) {
      onChange({
        ...interaction.original,
        ...geometry,
      });
    }
  };

  const finishInteraction = (
    event: ReactPointerEvent<SVGSVGElement>,
    commit: boolean,
  ) => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) {
      return;
    }

    if (
      commit &&
      interaction.type === 'draw' &&
      draft &&
      draft.width >= 2 &&
      draft.height >= 2
    ) {
      onAdd(draft);
      onToolChange('select');
    }
    if (interaction.type === 'pan') {
      if (commit && !interaction.moved && interaction.deselectOnClick) {
        onSelect(null);
      }
      setIsPanning(false);
    }
    interactionRef.current = null;
    setDraft(null);
    try {
      svgRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture can already be released when the pointer leaves the OS.
    }
  };

  const cancelInteraction = (event: ReactPointerEvent<SVGSVGElement>) => {
    finishInteraction(event, false);
  };

  const endInteraction = (event: ReactPointerEvent<SVGSVGElement>) => {
    finishInteraction(event, true);
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    const pointer = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    const nextZoom = clamp(
      zoom * Math.exp(-event.deltaY * 0.0014),
      0.35,
      12,
    );
    const local = {
      x: (pointer.x - base.x - pan.x) / zoom,
      y: (pointer.y - base.y - pan.y) / zoom,
    };
    setPan({
      x: pointer.x - base.x - local.x * nextZoom,
      y: pointer.y - base.y - local.y * nextZoom,
    });
    setZoom(nextZoom);
  };

  const zoomBy = (factor: number) => {
    const nextZoom = clamp(zoom * factor, 0.35, 12);
    const center = {
      x: viewport.width / 2,
      y: viewport.height / 2,
    };
    const local = {
      x: (center.x - base.x - pan.x) / zoom,
      y: (center.y - base.y - pan.y) / zoom,
    };
    setPan({
      x: center.x - base.x - local.x * nextZoom,
      y: center.y - base.y - local.y * nextZoom,
    });
    setZoom(nextZoom);
  };

  const fit = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const handleSize = 12 / screenScale;
  const strokeWidth = 1.5;
  const labelHeight = 24 / screenScale;
  const labelFontSize = 12 / screenScale;

  return (
    <div
      className={[
        'editor-viewport',
        `tool-${tool}`,
        spacePressed ? 'space-pan' : '',
        isPanning ? 'is-panning' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onWheel={handleWheel}
      ref={viewportRef}
    >
      <div className="editor-controls">
        <div className="editor-toolbar" aria-label="Edit tools">
          <button
            aria-label="Select frame"
            className={tool === 'select' ? 'active' : ''}
            onClick={() => onToolChange('select')}
            title="Select frame (V)"
            type="button"
          >
            <MousePointer2 size={17} />
          </button>
          <button
            aria-label="Pan canvas"
            className={tool === 'hand' ? 'active' : ''}
            onClick={() => onToolChange('hand')}
            title="Pan canvas (H)"
            type="button"
          >
            <Hand size={17} />
          </button>
          <button
            aria-label="Draw frame"
            className={tool === 'draw' ? 'active' : ''}
            onClick={() => onToolChange('draw')}
            title="Draw frame (D)"
            type="button"
          >
            <Crop size={17} />
          </button>
          <button
            aria-label="Duplicate frame"
            disabled={disabled || !selected}
            onClick={onDuplicate}
            title="Duplicate selected frame"
            type="button"
          >
            <CopyPlus size={17} />
          </button>
        </div>

        <div className="zoom-toolbar" aria-label="Zoom tools">
          <button
            aria-label="Zoom out"
            onClick={() => zoomBy(0.8)}
            title="Zoom out"
            type="button"
          >
            <ZoomOut size={17} />
          </button>
          <span className="zoom-readout">{Math.round(zoom * 100)}%</span>
          <button
            aria-label="Zoom in"
            onClick={() => zoomBy(1.25)}
            title="Zoom in"
            type="button"
          >
            <ZoomIn size={17} />
          </button>
          <button
            aria-label="Fit to window"
            onClick={fit}
            title="Fit to window"
            type="button"
          >
            <Maximize size={16} />
          </button>
        </div>
      </div>

      <div
        className="image-stage"
        style={{
          height: stageHeight,
          transform: `translate(${base.x + pan.x}px, ${base.y + pan.y}px) scale(${zoom})`,
          width: stageWidth,
        }}
      >
        <img alt="TIFF preview" draggable={false} src={previewUrl} />
        <svg
          aria-label="Frame canvas"
          onLostPointerCapture={cancelInteraction}
          onPointerCancel={cancelInteraction}
          onPointerDown={handleBackgroundPointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endInteraction}
          preserveAspectRatio="none"
          ref={svgRef}
          viewBox={`0 0 ${bounds.width} ${bounds.height}`}
        >
          {crops.map((crop, index) => {
            const isSelected = crop.id === selectedId;
            return (
              <g className={isSelected ? 'crop-shape selected' : 'crop-shape'} key={crop.id}>
                <rect
                  className="crop-hit"
                  height={crop.height}
                  onPointerDown={(event) =>
                    handleCropPointerDown(event, crop)
                  }
                  width={crop.width}
                  x={crop.x}
                  y={crop.y}
                />
                <rect
                  className="crop-outline"
                  height={crop.height}
                  pointerEvents="none"
                  strokeWidth={strokeWidth}
                  width={crop.width}
                  x={crop.x}
                  y={crop.y}
                />
                <g pointerEvents="none">
                  <rect
                    className="crop-label-bg"
                    height={labelHeight}
                    width={labelHeight * 1.18}
                    x={crop.x}
                    y={crop.y}
                  />
                  <text
                    className="crop-label"
                    dominantBaseline="central"
                    fontSize={labelFontSize}
                    textAnchor="middle"
                    x={crop.x + labelHeight * 0.59}
                    y={crop.y + labelHeight / 2}
                  >
                    {index + 1}
                  </text>
                </g>
              </g>
            );
          })}

          {draft && (
            <rect
              className="crop-outline draft"
              height={draft.height}
              pointerEvents="none"
              strokeWidth={strokeWidth}
              width={draft.width}
              x={draft.x}
              y={draft.y}
            />
          )}

          {selected && tool === 'select' &&
            (
              [
                ['nw', selected.x, selected.y],
                ['ne', selected.x + selected.width, selected.y],
                [
                  'se',
                  selected.x + selected.width,
                  selected.y + selected.height,
                ],
                ['sw', selected.x, selected.y + selected.height],
              ] as const
            ).map(([corner, x, y]) => (
              <rect
                className={`crop-handle handle-${corner}`}
                height={handleSize}
                key={corner}
                onPointerDown={(event) =>
                  beginResize(event, selected, corner)
                }
                strokeWidth={strokeWidth}
                width={handleSize}
                x={x - handleSize / 2}
                y={y - handleSize / 2}
              />
            ))}
        </svg>
      </div>

      <div className="stage-hint">
        {spacePressed
          ? 'Pan · Release Space to return'
          : tool === 'draw'
          ? 'Drag to draw · Click an edge to select · Space to pan'
          : tool === 'hand'
            ? 'Drag to pan · Scroll to zoom'
            : 'Click blank space to deselect · Drag to pan · Corners to resize'}
      </div>
    </div>
  );
}
