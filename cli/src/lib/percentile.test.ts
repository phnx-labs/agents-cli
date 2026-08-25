import { describe, expect, it } from 'vitest';
import { percentile } from './percentile.js';

describe('percentile', () => {
  it('is bounds-safe for empty and single-element arrays', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 100)).toBe(42);
  });

  it('linearly interpolates between the two nearest ranks', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([10, 20, 30, 40, 50], 0)).toBe(10);
    expect(percentile([10, 20, 30, 40, 50], 100)).toBe(50);
  });

  it('is monotonic non-decreasing across p50/p95/p99 on the same distribution', () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const p99 = percentile(sorted, 99);
    expect(p95).toBeGreaterThanOrEqual(p50);
    expect(p99).toBeGreaterThanOrEqual(p95);
  });
});
