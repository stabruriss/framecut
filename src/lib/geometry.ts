import type {
  CropBox,
  ImageBounds,
  QuarterTurn,
} from './model';

export interface Point {
  x: number;
  y: number;
}

export type CropGeometry = Pick<CropBox, 'x' | 'y' | 'width' | 'height'>;
export type RotationDirection = -1 | 1;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), maximum);

export function cropFromDrag(
  start: Point,
  end: Point,
  bounds: ImageBounds,
): CropGeometry {
  const left = clamp(Math.floor(Math.min(start.x, end.x)), 0, bounds.width);
  const top = clamp(Math.floor(Math.min(start.y, end.y)), 0, bounds.height);
  const right = clamp(Math.ceil(Math.max(start.x, end.x)), 0, bounds.width);
  const bottom = clamp(Math.ceil(Math.max(start.y, end.y)), 0, bounds.height);

  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

export function moveCrop(
  crop: CropGeometry,
  delta: Point,
  bounds: ImageBounds,
): CropGeometry {
  return {
    ...crop,
    x: clamp(Math.round(crop.x + delta.x), 0, bounds.width - crop.width),
    y: clamp(Math.round(crop.y + delta.y), 0, bounds.height - crop.height),
  };
}

export function resizeCrop(
  crop: CropGeometry,
  corner: 'nw' | 'ne' | 'se' | 'sw',
  point: Point,
  bounds: ImageBounds,
): CropGeometry {
  const opposite = {
    nw: { x: crop.x + crop.width, y: crop.y + crop.height },
    ne: { x: crop.x, y: crop.y + crop.height },
    se: { x: crop.x, y: crop.y },
    sw: { x: crop.x + crop.width, y: crop.y },
  }[corner];

  return cropFromDrag(opposite, point, bounds);
}

export function isValidCrop(
  crop: CropGeometry,
  bounds: ImageBounds,
): boolean {
  return (
    Number.isInteger(crop.x) &&
    Number.isInteger(crop.y) &&
    Number.isInteger(crop.width) &&
    Number.isInteger(crop.height) &&
    crop.x >= 0 &&
    crop.y >= 0 &&
    crop.width >= 1 &&
    crop.height >= 1 &&
    crop.x + crop.width <= bounds.width &&
    crop.y + crop.height <= bounds.height
  );
}

export function cropArea(crop: CropGeometry): number {
  return crop.width * crop.height;
}

export function nextQuarterTurn(
  rotation: QuarterTurn,
  direction: RotationDirection,
): QuarterTurn {
  return ((rotation + direction + 4) % 4) as QuarterTurn;
}

export function rotatedBounds(
  bounds: ImageBounds,
  rotation: QuarterTurn,
): ImageBounds {
  return rotation % 2 === 0
    ? { width: bounds.width, height: bounds.height }
    : { width: bounds.height, height: bounds.width };
}

export function rotateCrop(
  crop: CropGeometry,
  bounds: ImageBounds,
  direction: RotationDirection,
): CropGeometry {
  return direction === 1
    ? {
        x: bounds.height - crop.y - crop.height,
        y: crop.x,
        width: crop.height,
        height: crop.width,
      }
    : {
        x: crop.y,
        y: bounds.width - crop.x - crop.width,
        width: crop.height,
        height: crop.width,
      };
}

function cropsOverlap(first: CropGeometry, second: CropGeometry): boolean {
  return (
    first.x < second.x + second.width &&
    first.x + first.width > second.x &&
    first.y < second.y + second.height &&
    first.y + first.height > second.y
  );
}

function duplicateAtGap(
  source: CropGeometry,
  existing: CropGeometry[],
  bounds: ImageBounds,
  gap: number,
): CropGeometry | null {
  const maximumX = bounds.width - source.width;
  const maximumY = bounds.height - source.height;
  if (maximumX < 0 || maximumY < 0) {
    return null;
  }

  const obstacles = [source, ...existing];
  const isAvailable = (candidate: CropGeometry) =>
    candidate.x >= 0 &&
    candidate.y >= 0 &&
    candidate.x <= maximumX &&
    candidate.y <= maximumY &&
    !obstacles.some((crop) => cropsOverlap(candidate, crop));
  const candidate = (x: number, y: number): CropGeometry => ({
    x,
    y,
    width: source.width,
    height: source.height,
  });

  const preferred = [
    candidate(source.x + source.width + gap, source.y),
    candidate(source.x, source.y + source.height + gap),
    candidate(source.x - source.width - gap, source.y),
    candidate(source.x, source.y - source.height - gap),
  ];
  const directMatch = preferred.find(isAvailable);
  if (directMatch) {
    return directMatch;
  }

  const xCoordinates = new Set<number>([
    0,
    maximumX,
    source.x,
    source.x + source.width + gap,
    source.x - source.width - gap,
  ]);
  const yCoordinates = new Set<number>([
    0,
    maximumY,
    source.y,
    source.y + source.height + gap,
    source.y - source.height - gap,
  ]);

  for (const crop of obstacles) {
    xCoordinates.add(crop.x + crop.width + gap);
    xCoordinates.add(crop.x - source.width - gap);
    yCoordinates.add(crop.y + crop.height + gap);
    yCoordinates.add(crop.y - source.height - gap);
  }

  const candidates: CropGeometry[] = [];
  for (const x of xCoordinates) {
    for (const y of yCoordinates) {
      const next = candidate(x, y);
      if (isAvailable(next)) {
        candidates.push(next);
      }
    }
  }

  candidates.sort((first, second) => {
    const firstDistance =
      (first.x - source.x) ** 2 + (first.y - source.y) ** 2;
    const secondDistance =
      (second.x - source.x) ** 2 + (second.y - source.y) ** 2;
    return (
      firstDistance - secondDistance ||
      first.y - second.y ||
      first.x - second.x
    );
  });
  return candidates[0] ?? null;
}

export function findDuplicatePosition(
  source: CropGeometry,
  existing: CropGeometry[],
  bounds: ImageBounds,
): CropGeometry | null {
  const visibleGap = Math.max(
    1,
    Math.min(24, Math.round(Math.min(source.width, source.height) * 0.04)),
  );
  return (
    duplicateAtGap(source, existing, bounds, visibleGap) ??
    duplicateAtGap(source, existing, bounds, 0)
  );
}
