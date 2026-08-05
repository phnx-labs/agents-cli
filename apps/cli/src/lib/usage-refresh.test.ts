import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  REFRESH_MIN_MS,
  REFRESH_MAX_MS,
  REFRESH_BURN_DIVISOR,
  HOURLY_CALL_CAP,
  computeNextRefreshDelayMs,
  pruneCallTimestamps,
  shouldRefreshAccount,
  nextHeadroomEntry,
  runUsageRefresh,
  readHeadroomEntry,
  setHeadroomCachePathForTest,
  type HeadroomEntry,
} from './usage-refresh.js';
import { setClaudeUsageCachePathForTest, writeClaudeUsageCache, readClaudeUsageCache, type UsageSnapshot } from './usage.js';

const NOW = 1_800_000_000_000;

const sessionSnap = (usedPercent: number, capturedAtMs: number): UsageSnapshot => ({
  source: 'live',
  sourceLabel: 'live',
  capturedAt: new Date(capturedAtMs),
  windows: [
    { key: 'session', label: '5h', shortLabel: 'S', usedPercent, resetsAt: null, windowMinutes: 300 },
  ],
});

describe('computeNextRefreshDelayMs — adaptive cadence clamped to [90s, 15min]', () => {
  it('polls sooner the closer an account is to its cap', () => {
    // minutesToLimit / K minutes, in ms, but never below the 90s floor.
    const far = computeNextRefreshDelayMs(600); // 600/4 = 150min -> clamped to MAX
    const near = computeNextRefreshDelayMs(20); // 20/4 = 5min -> 300_000ms
    expect(far).toBe(REFRESH_MAX_MS);
    expect(near).toBe((20 / REFRESH_BURN_DIVISOR) * 60_000);
    expect(near).toBeLessThan(far);
  });

  it('never polls faster than the floor, even seconds from the cap', () => {
    expect(computeNextRefreshDelayMs(0)).toBe(REFRESH_MIN_MS);
    expect(computeNextRefreshDelayMs(1)).toBe(REFRESH_MIN_MS);
  });

  it('waits the full ceiling when there is no projection', () => {
    expect(computeNextRefreshDelayMs(null)).toBe(REFRESH_MAX_MS);
    expect(computeNextRefreshDelayMs(Number.POSITIVE_INFINITY)).toBe(REFRESH_MAX_MS);
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
  it('carries the burn projection into the schedule', () => {
    const prev: HeadroomEntry = {
      status: 'available', minutesToLimit: null, sessionUsedPercent: 50, capturedAt: NOW - 10 * 60_000,
      nextRefreshAt: NOW - 1, callTimestamps: [], computedAt: NOW - 10 * 60_000,
    };
    // 50 -> 70 over 10min = 2%/min; 30% left => 15min to cap.
    const entry = nextHeadroomEntry(prev, sessionSnap(70, NOW), NOW);
    expect(entry.minutesToLimit).toBeCloseTo(15, 5);
    // Scheduled at minutesToLimit / K.
    expect(entry.nextRefreshAt - NOW).toBe((15 / REFRESH_BURN_DIVISOR) * 60_000);
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
  });
});
