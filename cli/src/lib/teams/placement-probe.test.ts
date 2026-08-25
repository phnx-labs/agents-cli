/**
 * Probe-module degrade path + cache (RUSH-2002). The ranking logic these signals
 * feed is unit-tested in scheduler.test.ts; here we pin the two behaviors that do
 * NOT need a live fleet: a pool of devices absent from the registry probes nothing
 * (empty signal map, no SSH), and a probed snapshot is reused within the TTL.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { probePoolSignals, clearPlacementSignalCache, SIGNAL_TTL_MS } from './placement-probe.js';

describe('probePoolSignals — degrade + cache', () => {
  beforeEach(() => clearPlacementSignalCache());

  it('a pool of unregistered devices yields an empty signal map (no probe)', async () => {
    const signals = await probePoolSignals(['no-such-device-xyz', 'also-not-real-abc'], 'claude', {
      now: 1_000,
    });
    expect(signals.size).toBe(0);
  });

  it('reuses the cached snapshot within the TTL, refreshes after it', async () => {
    const pool = ['no-such-device-xyz'];
    const first = await probePoolSignals(pool, 'claude', { now: 1_000 });
    // Same object identity within the TTL → the cache short-circuited the probe.
    const withinTtl = await probePoolSignals(pool, 'claude', { now: 1_000 + SIGNAL_TTL_MS - 1 });
    expect(withinTtl).toBe(first);
    // Past the TTL → a fresh map.
    const afterTtl = await probePoolSignals(pool, 'claude', { now: 1_000 + SIGNAL_TTL_MS + 1 });
    expect(afterTtl).not.toBe(first);
  });

  it('force bypasses the cache', async () => {
    const pool = ['no-such-device-xyz'];
    const first = await probePoolSignals(pool, 'claude', { now: 2_000 });
    const forced = await probePoolSignals(pool, 'claude', { now: 2_000, force: true });
    expect(forced).not.toBe(first);
  });
});
