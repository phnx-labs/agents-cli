import { describe, test, expect, spyOn } from 'bun:test';
import { runStaggered, RESTORE_MAX_CONCURRENCY } from './restoreThrottle';

/** Deterministic yield so overlapping workers actually interleave. */
const tick = () => new Promise<void>((r) => setTimeout(r, 1));

describe('runStaggered', () => {
  test('never exceeds the concurrency cap — the thundering-herd bound', async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let inFlight = 0;
    let maxInFlight = 0;
    const seen: number[] = [];

    await runStaggered(
      items,
      async (item) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await tick();
        seen.push(item);
        inFlight--;
      },
      { concurrency: 3, staggerMs: 0 },
    );

    expect(maxInFlight).toBe(3);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    // Every tab restored exactly once.
    expect(seen.slice().sort((a, b) => a - b)).toEqual(items);
  });

  test('serializes at concurrency 1 (max one restore in flight)', async () => {
    const items = [0, 1, 2, 3, 4];
    let inFlight = 0;
    let maxInFlight = 0;
    await runStaggered(
      items,
      async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await tick();
        inFlight--;
      },
      { concurrency: 1, staggerMs: 0 },
    );
    expect(maxInFlight).toBe(1);
  });

  test('staggers every start after the first', async () => {
    const items = Array.from({ length: 6 }, (_, i) => i);
    const delays: number[] = [];
    const sleep = async (ms: number) => { delays.push(ms); };
    await runStaggered(items, async () => {}, { concurrency: 2, staggerMs: 250, sleep });
    // items.length - 1 starts are staggered (index 0 is not), each by staggerMs.
    expect(delays).toHaveLength(items.length - 1);
    expect(delays.every((d) => d === 250)).toBe(true);
  });

  test('a throwing worker does not strand the rest of the batch, and is logged', async () => {
    const items = [0, 1, 2, 3];
    const done: number[] = [];
    const logged: string[] = [];
    const errSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    try {
      await runStaggered(
        items,
        async (item) => {
          if (item === 1) throw new Error('un-resumable tab');
          done.push(item);
        },
        { concurrency: 1, staggerMs: 0 },
      );
    } finally {
      errSpy.mockRestore();
    }
    expect(done.sort((a, b) => a - b)).toEqual([0, 2, 3]);
    // The failure is not swallowed silently — it is logged so a permanently
    // dropped (clearPersistedSessions) tab is diagnosable.
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('un-resumable tab');
  });

  test('empty input is a no-op', async () => {
    let called = false;
    await runStaggered([], async () => { called = true; }, { staggerMs: 0 });
    expect(called).toBe(false);
  });

  test('defaults keep the herd bounded', () => {
    expect(RESTORE_MAX_CONCURRENCY).toBeGreaterThanOrEqual(1);
    expect(RESTORE_MAX_CONCURRENCY).toBeLessThanOrEqual(4);
  });
});
