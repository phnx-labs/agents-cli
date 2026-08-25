import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  REFRESH_INTERVAL_MS,
  REFRESH_MIN_MS,
  REFRESH_MAX_MS,
  REFRESH_BURN_DIVISOR,
  HOURLY_CALL_CAP,
  USAGE_REFRESH_TICK_MS,
  FAILURE_QUARANTINE_MS,
  FAILURE_QUARANTINE_THRESHOLD,
  computeNextRefreshDelayMs,
  pruneCallTimestamps,
  shouldRefreshAccount,
  nextHeadroomEntry,
  orderUsageAccounts,
  runUsageRefresh,
  readHeadroomEntry,
  writeHeadroomEntries,
  setHeadroomCachePathForTest,
  type HeadroomEntry,
} from './usage-refresh.js';
import { setClaudeUsageCachePathForTest, writeClaudeUsageCache, readClaudeUsageCache, type UsageSnapshot } from './accounting/usage.js';

const NOW = 1_800_000_000_000;

const sessionSnap = (usedPercent: number, capturedAtMs: number): UsageSnapshot => ({
  source: 'live',
  sourceLabel: 'live',
  capturedAt: new Date(capturedAtMs),
  windows: [
    { key: 'session', label: '5h', shortLabel: 'S', usedPercent, resetsAt: null, windowMinutes: 300 },
  ],
});

describe('computeNextRefreshDelayMs — fixed 5-minute production cadence', () => {
  it('defaults to the 5-minute interval regardless of burn projection', () => {
    expect(REFRESH_INTERVAL_MS).toBe(5 * 60 * 1000);
    expect(REFRESH_MIN_MS).toBe(REFRESH_INTERVAL_MS);
    expect(REFRESH_MAX_MS).toBe(REFRESH_INTERVAL_MS);
    expect(USAGE_REFRESH_TICK_MS).toBe(60_000);
    expect(computeNextRefreshDelayMs(600)).toBe(REFRESH_INTERVAL_MS);
    expect(computeNextRefreshDelayMs(20)).toBe(REFRESH_INTERVAL_MS);
    expect(computeNextRefreshDelayMs(0)).toBe(REFRESH_INTERVAL_MS);
    expect(computeNextRefreshDelayMs(null)).toBe(REFRESH_INTERVAL_MS);
  });

  it('still supports a wider clamp when a test/caller passes min/max', () => {
    // minutesToLimit / K with an explicit wide range: 20/4 = 5min.
    const near = computeNextRefreshDelayMs(20, {
      minMs: 90_000,
      maxMs: 15 * 60_000,
      divisor: REFRESH_BURN_DIVISOR,
    });
    expect(near).toBe((20 / REFRESH_BURN_DIVISOR) * 60_000);
    const far = computeNextRefreshDelayMs(600, { minMs: 90_000, maxMs: 15 * 60_000 });
    expect(far).toBe(15 * 60_000);
  });
});

describe('the rolling-hour call cap bounds provider load', () => {
  it('prunes timestamps outside the trailing hour', () => {
    const ts = [NOW - 2 * 60 * 60_000, NOW - 30 * 60_000, NOW - 1000];
    expect(pruneCallTimestamps(ts, NOW)).toEqual([NOW - 30 * 60_000, NOW - 1000]);
  });

  it('refuses a due account that already hit the hourly cap', () => {
    const atCap: HeadroomEntry = {
      status: 'available', minutesToLimit: 10, sessionUsedPercent: 80, capturedAt: NOW - 60_000,
      nextRefreshAt: NOW - 1, // due
      callTimestamps: Array.from({ length: HOURLY_CALL_CAP }, (_, i) => NOW - i * 60_000),
      computedAt: NOW - 60_000,
    };
    expect(shouldRefreshAccount(atCap, NOW)).toBe(false);
  });

  it('allows a due account under the cap, and refuses one not yet due', () => {
    const underCap: HeadroomEntry = {
      status: 'available', minutesToLimit: 10, sessionUsedPercent: 80, capturedAt: NOW - 60_000,
      nextRefreshAt: NOW - 1, callTimestamps: [NOW - 60_000], computedAt: NOW - 60_000,
    };
    expect(shouldRefreshAccount(underCap, NOW)).toBe(true);
    expect(shouldRefreshAccount({ ...underCap, nextRefreshAt: NOW + 60_000 }, NOW)).toBe(false);
  });

  it('always refreshes an account with no prior entry (cold cache)', () => {
    expect(shouldRefreshAccount(null, NOW)).toBe(true);
  });
});

describe('nextHeadroomEntry — projects, schedules, and records the call', () => {
  it('records burn projection but schedules the fixed 5-minute cadence', () => {
    const prev: HeadroomEntry = {
      status: 'available', minutesToLimit: null, sessionUsedPercent: 50, capturedAt: NOW - 10 * 60_000,
      nextRefreshAt: NOW - 1, callTimestamps: [], computedAt: NOW - 10 * 60_000,
    };
    // 50 -> 70 over 10min = 2%/min; 30% left => 15min to cap (projection still computed).
    const entry = nextHeadroomEntry(prev, sessionSnap(70, NOW), NOW);
    expect(entry.minutesToLimit).toBeCloseTo(15, 5);
    // Production cadence is fixed 5 minutes (floor = ceiling = REFRESH_INTERVAL_MS).
    expect(entry.nextRefreshAt - NOW).toBe(REFRESH_INTERVAL_MS);
    expect(entry.sessionUsedPercent).toBe(70);
    expect(entry.callTimestamps).toContain(NOW);
  });
});

describe('runUsageRefresh — refreshes only due, uncapped, un-backed-off local accounts', () => {
  let cacheDir: string;
  let prevHeadroom: string | null;
  let prevUsage: string | null;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-refresh-'));
    prevHeadroom = setHeadroomCachePathForTest(path.join(cacheDir, '.usage-headroom.json'));
    prevUsage = setClaudeUsageCachePathForTest(path.join(cacheDir, 'claude-usage.json'));
  });

  afterEach(() => {
    setHeadroomCachePathForTest(prevHeadroom);
    setClaudeUsageCachePathForTest(prevUsage);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('writes the usage cache + headroom for a cold account', async () => {
    const key = 'claude:org=refresh';
    const result = await runUsageRefresh({
      now: NOW,
      listAccounts: async () => [
        { usageKey: key, agentId: 'claude', fetch: async () => ({ snapshot: sessionSnap(70, NOW), error: null }) },
      ],
      writeUsageCache: writeClaudeUsageCache,
      backoffUntil: () => null,
    });

    expect(result.refreshed).toBe(1);
    // The live snapshot landed in the usage cache (the readOnly hot path reads this).
    expect(readClaudeUsageCache(key)?.windows[0]?.usedPercent).toBe(70);
    // And a headroom entry was published + scheduled.
    const entry = readHeadroomEntry(key);
    expect(entry?.sessionUsedPercent).toBe(70);
    expect(entry?.nextRefreshAt).toBeGreaterThan(NOW);
  });

  it('seeds a never-cached account before cached accounts and rotates each tick', async () => {
    const cached = 'claude:org=cached';
    const coldA = 'claude:org=cold-a';
    const coldB = 'claude:org=cold-b';
    writeHeadroomEntries({
      [cached]: nextHeadroomEntry(null, sessionSnap(10, NOW - REFRESH_INTERVAL_MS), NOW - REFRESH_INTERVAL_MS),
    });
    const accounts = [cached, coldA, coldB].map((usageKey) => ({
      usageKey,
      agentId: 'claude' as const,
      fetch: async () => ({ snapshot: sessionSnap(20, NOW), error: null }),
    }));

    const firstTick = orderUsageAccounts(accounts, { [cached]: readHeadroomEntry(cached)! }, 0);
    const secondTick = orderUsageAccounts(accounts, { [cached]: readHeadroomEntry(cached)! }, 1);

    expect(firstTick.map((account) => account.usageKey)).toEqual([coldA, coldB, cached]);
    expect(secondTick.map((account) => account.usageKey)).toEqual([coldB, coldA, cached]);
  });

  it('skips a provider under a live 429 backoff without calling fetch', async () => {
    let called = false;
    const result = await runUsageRefresh({
      now: NOW,
      listAccounts: async () => [
        { usageKey: 'claude:org=x', agentId: 'claude', fetch: async () => { called = true; return { snapshot: sessionSnap(10, NOW), error: null }; } },
      ],
      writeUsageCache: writeClaudeUsageCache,
      backoffUntil: () => NOW + 30 * 60_000, // backed off 30 min
    });
    expect(called).toBe(false);
    expect(result.skippedBackoff).toBe(1);
    expect(result.refreshed).toBe(0);
    expect(readHeadroomEntry('claude:org=x')?.nextRefreshAt).toBeGreaterThan(NOW);
  });

  it('reschedules backed-off accounts at distinct jittered due times', async () => {
    const keys = ['claude:org=a', 'claude:org=b', 'claude:org=c'];
    await runUsageRefresh({
      now: NOW,
      listAccounts: async () => keys.map((usageKey) => ({
        usageKey,
        agentId: 'claude' as const,
        fetch: async () => ({ snapshot: sessionSnap(10, NOW), error: null }),
      })),
      writeUsageCache: writeClaudeUsageCache,
      backoffUntil: () => NOW + 30 * 60_000,
    });

    const dueTimes = keys.map((key) => readHeadroomEntry(key)?.nextRefreshAt);
    expect(new Set(dueTimes).size).toBe(keys.length);
    expect(dueTimes.every((due) => due !== undefined && due > NOW)).toBe(true);
    expect(dueTimes.every((due) => due !== undefined && due <= NOW + keys.length * 5_000)).toBe(true);
  });

  it('quarantines a chronic failure while healthy siblings keep refreshing', async () => {
    const chronic = 'claude:org=chronic';
    const healthy = 'claude:org=healthy';
    let chronicCalls = 0;
    let healthyCalls = 0;
    const runAt = async (now: number) => runUsageRefresh({
      now,
      listAccounts: async () => [
        {
          usageKey: chronic,
          agentId: 'claude',
          fetch: async () => {
            chronicCalls += 1;
            return { snapshot: null, error: 'rate limited' };
          },
        },
        {
          usageKey: healthy,
          agentId: 'claude',
          fetch: async () => {
            healthyCalls += 1;
            return { snapshot: sessionSnap(20 + healthyCalls, now), error: null };
          },
        },
      ],
      writeUsageCache: writeClaudeUsageCache,
      backoffUntil: () => null,
    });

    for (let cycle = 0; cycle < FAILURE_QUARANTINE_THRESHOLD; cycle += 1) {
      await runAt(NOW + cycle * REFRESH_INTERVAL_MS);
    }
    const quarantined = readHeadroomEntry(chronic);
    expect(quarantined?.consecutiveFailures).toBe(FAILURE_QUARANTINE_THRESHOLD);
    expect(quarantined?.nextRefreshAt).toBe(
      NOW + (FAILURE_QUARANTINE_THRESHOLD - 1) * REFRESH_INTERVAL_MS + FAILURE_QUARANTINE_MS,
    );

    await runAt(NOW + FAILURE_QUARANTINE_THRESHOLD * REFRESH_INTERVAL_MS);
    expect(chronicCalls).toBe(FAILURE_QUARANTINE_THRESHOLD);
    expect(healthyCalls).toBe(FAILURE_QUARANTINE_THRESHOLD + 1);
    expect(readClaudeUsageCache(healthy)?.windows[0]?.usedPercent).toBe(24);
  });

  it('schedules the next attempt 5 minutes out after a successful refresh', async () => {
    const key = 'claude:org=sched';
    await runUsageRefresh({
      now: NOW,
      listAccounts: async () => [
        { usageKey: key, agentId: 'claude', fetch: async () => ({ snapshot: sessionSnap(40, NOW), error: null }) },
      ],
      writeUsageCache: writeClaudeUsageCache,
      backoffUntil: () => null,
    });
    const entry = readHeadroomEntry(key);
    expect(entry?.nextRefreshAt).toBe(NOW + REFRESH_INTERVAL_MS);
  });

  it('does not lose concurrent cache writes for different accounts (lock merge)', async () => {
    // Two serial writeClaudeUsageCache calls under lock must both land.
    writeClaudeUsageCache('claude:org=a', sessionSnap(10, NOW));
    writeClaudeUsageCache('claude:org=b', sessionSnap(20, NOW));
    expect(readClaudeUsageCache('claude:org=a')?.windows[0]?.usedPercent).toBe(10);
    expect(readClaudeUsageCache('claude:org=b')?.windows[0]?.usedPercent).toBe(20);
  });
});
