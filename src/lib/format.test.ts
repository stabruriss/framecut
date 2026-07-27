import { describe, expect, it } from 'vitest';
import {
  batchOutputFileName,
  outputBatchName,
} from './format';

describe('output batch names', () => {
  it('uses a readable local timestamp for each output run', () => {
    expect(outputBatchName(new Date(2026, 6, 27, 9, 5, 3))).toBe(
      'framecut-20260727-090503',
    );
  });

  it('numbers files with enough leading zeroes for the batch', () => {
    expect(
      batchOutputFileName('framecut-20260727-090503', 0, 12),
    ).toBe('framecut-20260727-090503-01.tif');
    expect(
      batchOutputFileName('framecut-20260727-090503', 999, 1000),
    ).toBe('framecut-20260727-090503-1000.tif');
  });
});
