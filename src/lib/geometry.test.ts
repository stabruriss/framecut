import { describe, expect, it } from 'vitest';
import {
  cropFromDrag,
  findDuplicatePosition,
  isValidCrop,
  moveCrop,
  nextQuarterTurn,
  resizeCrop,
  rotateCrop,
  rotatedBounds,
} from './geometry';
import type { QuarterTurn } from './model';

const bounds = { width: 100, height: 80 };

describe('crop geometry', () => {
  it('rounds outward so fractional drawing never drops edge pixels', () => {
    expect(cropFromDrag({ x: 4.8, y: 8.2 }, { x: 20.1, y: 30.7 }, bounds))
      .toEqual({
        x: 4,
        y: 8,
        width: 17,
        height: 23,
      });
  });

  it('supports reverse-direction drawing and clamps to the source', () => {
    expect(cropFromDrag({ x: 110, y: 70 }, { x: -2, y: -5 }, bounds))
      .toEqual({
        x: 0,
        y: 0,
        width: 100,
        height: 70,
      });
  });

  it('moves a crop without allowing it to leave the source', () => {
    const crop = { x: 20, y: 20, width: 30, height: 25 };
    expect(moveCrop(crop, { x: 200, y: -100 }, bounds)).toEqual({
      x: 70,
      y: 0,
      width: 30,
      height: 25,
    });
  });

  it('resizes across the opposite corner and keeps integer pixels', () => {
    const crop = { x: 20, y: 20, width: 30, height: 25 };
    expect(resizeCrop(crop, 'nw', { x: 10.4, y: 9.8 }, bounds)).toEqual({
      x: 10,
      y: 9,
      width: 40,
      height: 36,
    });
  });

  it('rejects zero, fractional and out-of-bounds crops', () => {
    expect(isValidCrop({ x: 0, y: 0, width: 1, height: 1 }, bounds)).toBe(
      true,
    );
    expect(isValidCrop({ x: 0, y: 0, width: 0, height: 1 }, bounds)).toBe(
      false,
    );
    expect(isValidCrop({ x: 0.5, y: 0, width: 1, height: 1 }, bounds)).toBe(
      false,
    );
    expect(isValidCrop({ x: 99, y: 79, width: 2, height: 1 }, bounds)).toBe(
      false,
    );
    expect(
      isValidCrop({ x: Number.NaN, y: 0, width: 1, height: 1 }, bounds),
    ).toBe(false);
    expect(
      isValidCrop({ x: 0, y: 0, width: Infinity, height: 1 }, bounds),
    ).toBe(false);
  });

  it('duplicates to the right with a visible gap when space is available', () => {
    const source = { x: 10, y: 10, width: 20, height: 15 };
    expect(findDuplicatePosition(source, [source], bounds)).toEqual({
      x: 31,
      y: 10,
      width: 20,
      height: 15,
    });
  });

  it('uses another nearby side when the preferred position is occupied', () => {
    const source = { x: 10, y: 10, width: 20, height: 15 };
    const blocker = { x: 31, y: 10, width: 20, height: 15 };
    expect(findDuplicatePosition(source, [source, blocker], bounds)).toEqual({
      x: 10,
      y: 26,
      width: 20,
      height: 15,
    });
  });

  it('returns null when no non-overlapping copy can fit', () => {
    const smallBounds = { width: 20, height: 10 };
    const source = { x: 0, y: 0, width: 20, height: 10 };
    expect(findDuplicatePosition(source, [source], smallBounds)).toBeNull();
  });

  it('rotates crop geometry clockwise with the image bounds', () => {
    const crop = { x: 10, y: 20, width: 30, height: 25 };
    const rotated = rotateCrop(crop, bounds, 1);

    expect(rotatedBounds(bounds, 1)).toEqual({ width: 80, height: 100 });
    expect(rotated).toEqual({
      x: 35,
      y: 10,
      width: 25,
      height: 30,
    });
    expect(isValidCrop(rotated, rotatedBounds(bounds, 1))).toBe(true);
  });

  it('rotates crop geometry counterclockwise with the image bounds', () => {
    const crop = { x: 10, y: 20, width: 30, height: 25 };
    const rotated = rotateCrop(crop, bounds, -1);

    expect(rotated).toEqual({
      x: 20,
      y: 60,
      width: 25,
      height: 30,
    });
    expect(isValidCrop(rotated, rotatedBounds(bounds, 3))).toBe(true);
    expect(nextQuarterTurn(0, -1)).toBe(3);
  });

  it('returns to the original geometry after four clockwise turns', () => {
    const original = { x: 10, y: 20, width: 30, height: 25 };
    let crop = original;
    let currentBounds = bounds;
    let rotation: QuarterTurn = 0;

    for (let turn = 0; turn < 4; turn += 1) {
      crop = rotateCrop(crop, currentBounds, 1);
      currentBounds = rotatedBounds(currentBounds, 1);
      rotation = nextQuarterTurn(rotation, 1);
    }

    expect(rotation).toBe(0);
    expect(currentBounds).toEqual(bounds);
    expect(crop).toEqual(original);
  });
});
