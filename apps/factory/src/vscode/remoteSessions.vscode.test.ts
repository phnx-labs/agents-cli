import { test, expect } from 'bun:test';
import { mapWithConcurrency } from './remoteSessions.vscode';

// mapWithConcurrency bounds the host fan-out. A broken bound is what froze the M5,
// and order preservation matters because results are zipped back to their host by
// index. Real async work (setTimeout), no mocks.

test('preserves input order regardless of per-item latency', async () => {
  const items = [40, 5, 25, 10, 0];
  const out = await mapWithConcurrency(items, 2, async (ms, i) => {
    await new Promise((r) => setTimeout(r, ms));
    return `${i}:${ms}`;
  });
  expect(out).toEqual(['0:40', '1:5', '2:25', '3:10', '4:0']);
});

test('never exceeds the concurrency limit and still runs every item', async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  const out = await mapWithConcurrency(items, 4, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return n * 2;
  });
  expect(peak).toBeLessThanOrEqual(4);
  expect(out).toEqual(items.map((n) => n * 2));
});

test('a limit larger than the item count runs all of them (no hang)', async () => {
  const out = await mapWithConcurrency([1, 2, 3], 10, async (n) => n + 1);
  expect(out).toEqual([2, 3, 4]);
});

test('an empty list resolves to an empty array', async () => {
  const out = await mapWithConcurrency([] as number[], 4, async (n) => n);
  expect(out).toEqual([]);
});
