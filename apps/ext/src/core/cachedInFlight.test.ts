import { describe, test, expect } from 'bun:test';
import { createTimedCache, cachedInFlight } from './cachedInFlight';

describe('cachedInFlight', () => {
  test('coalesces concurrent calls for the same key into ONE invocation', async () => {
    const store = createTimedCache<number>();
    let calls = 0;
    const fn = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return 42;
    };
    // Five callers fire at the same instant (the full-fleet fan-out from
    // several uncoordinated timers) — they must share one in-flight run.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => cachedInFlight(store, 'host-a', 6000, fn, 1000)),
    );
    expect(calls).toBe(1);
    expect(results).toEqual([42, 42, 42, 42, 42]);
  });

  test('serves the cache within the TTL instead of re-invoking', async () => {
    const store = createTimedCache<number>();
    let calls = 0;
    const fn = async () => (++calls, calls);
    expect(await cachedInFlight(store, 'h', 6000, fn, 1000)).toBe(1);
    // A later caller still inside the TTL window gets the cached value.
    expect(await cachedInFlight(store, 'h', 6000, fn, 1000 + 5999)).toBe(1);
    expect(calls).toBe(1);
  });

  test('re-invokes once the TTL has elapsed', async () => {
    const store = createTimedCache<number>();
    let calls = 0;
    const fn = async () => (++calls, calls);
    expect(await cachedInFlight(store, 'h', 6000, fn, 1000)).toBe(1);
    expect(await cachedInFlight(store, 'h', 6000, fn, 1000 + 6001)).toBe(2);
    expect(calls).toBe(2);
  });

  test('a zero TTL still coalesces concurrent callers but never serves a stale value', async () => {
    // The contract pushFloorUpdate relies on: overlapping floor rebuilds share
    // one run, but a later refresh must always re-scan. Giving that call site a
    // non-zero TTL would post a stale terminal snapshot to the panel.
    const store = createTimedCache<number>();
    let calls = 0;
    const fn = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return calls;
    };
    const concurrent = await Promise.all(
      Array.from({ length: 4 }, () => cachedInFlight(store, 'floor', 0, fn, 1000)),
    );
    expect(concurrent).toEqual([1, 1, 1, 1]);
    expect(calls).toBe(1);

    // Same instant, but no longer in flight — must re-run rather than cache-hit.
    expect(await cachedInFlight(store, 'floor', 0, fn, 1000)).toBe(2);
    expect(calls).toBe(2);
  });

  test('keys are independent — one host in flight does not block another', async () => {
    const store = createTimedCache<string>();
    const seen: string[] = [];
    const make = (id: string) => async () => {
      seen.push(id);
      return id;
    };
    const [a, b] = await Promise.all([
      cachedInFlight(store, 'a', 6000, make('a'), 1000),
      cachedInFlight(store, 'b', 6000, make('b'), 1000),
    ]);
    expect(a).toBe('a');
    expect(b).toBe('b');
    expect(seen.sort()).toEqual(['a', 'b']);
  });
});
