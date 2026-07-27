import type { CropBox, ImageBounds } from './model';

export interface Point {
  x: number;
  y: number;
}

export type CropGeometry = Pick<CropBox, 'x' | 'y' | 'width' | 'height'>;

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
