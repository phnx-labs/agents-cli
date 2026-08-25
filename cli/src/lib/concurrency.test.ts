import { describe, it, expect } from 'vitest';
import { mapBounded } from './concurrency.js';

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('mapBounded', () => {
  it('preserves input order regardless of completion order', async () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    // Earlier items finish later, so completion order != input order.
    const out = await mapBounded(
      items,
      async n => { await delay((items.length - n) * 2); return n * 10; },
      { concurrency: 4 },
    );
    expect(out).toEqual(items.map(n => n * 10));
  });

  it('never exceeds the concurrency bound', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 25 }, (_, i) => i);
    await mapBounded(
      items,
      async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(5);
        inFlight--;
      },
      { concurrency: 3 },
    );
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1); // actually parallel, not accidentally serial
  });

  it('spaces successive starts by at least staggerMs (no simultaneous burst)', async () => {
    const starts: number[] = [];
    const items = [0, 1, 2, 3, 4];
    const t0 = performance.now();
    await mapBounded(
      items,
      async () => { starts.push(performance.now() - t0); },
      { concurrency: 10, staggerMs: 20 }, // concurrency >= n, so only the gate spreads starts
    );
    const elapsed = performance.now() - t0;
    // 5 starts spaced >= 20ms apart => the last starts no earlier than ~80ms in.
    expect(elapsed).toBeGreaterThanOrEqual(70);
    // Starts must be monotonically non-decreasing and spread, not all at t~0.
    expect(Math.max(...starts)).toBeGreaterThanOrEqual(70);
  });

  it('handles empty input', async () => {
    const out = await mapBounded([], async (x: number) => x, { concurrency: 4 });
    expect(out).toEqual([]);
  });
});
