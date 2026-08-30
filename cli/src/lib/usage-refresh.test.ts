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
  PROVIDER_HOURLY_BUDGET,
  STATUSLINE_FRESH_MS,
  USAGE_REFRESH_TICK_MS,
  FAILURE_QUARANTINE_MS,
  FAILURE_QUARANTINE_THRESHOLD,
  computeNextRefreshDelayMs,
  pruneCallTimestamps,
  shouldRefreshAccount,
  nextHeadroomEntry,
  orderUsageAccounts,
  providerRecentCalls,
  runUsageRefresh,
  readHeadroomEntry,
  writeHeadroomEntries,
  setHeadroomCachePathForTest,
  type HeadroomEntry,
} from './usage-refresh.js';
import { setClaudeUsageCachePathForTest, writeClaudeUsageCache, readClaudeUsageCache, type UsageSnapshot } from './accounting/usage.js';

const NOW = 1_800_000_000_000;

/** A minimal cached headroom entry the new budget/ordering tests clone and tweak. */
const baseEntry: HeadroomEntry = {
  status: 'available',
  minutesToLimit: 10,
  sessionUsedPercent: 50,
  capturedAt: NOW - 60_000,
  nextRefreshAt: NOW - 1,
  callTimestamps: [],
  computedAt: NOW - 60_000,
};

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

  it('publishes a freshly collected local-event snapshot', async () => {
    const key = 'grok:user=local-event';
    const snapshot = {
      ...sessionSnap(21, NOW),
      source: 'last_seen' as const,
      plan: 'SuperGrok Heavy',
    };
    const result = await runUsageRefresh({
      now: NOW,
      listAccounts: async () => [
        { usageKey: key, agentId: 'grok', fetch: async () => ({ snapshot, error: null }) },
      ],
      writeUsageCache: writeClaudeUsageCache,
      backoffUntil: () => null,
    });

    expect(result.refreshed).toBe(1);
    expect(result.failed).toBe(0);
    expect(readClaudeUsageCache(key)).toEqual(expect.objectContaining({ plan: 'SuperGrok Heavy' }));
    expect(readClaudeUsageCache(key)?.windows[0]?.usedPercent).toBe(21);
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

describe('orderUsageAccounts — stalest account first', () => {
  it('orders cached accounts oldest-capture first, cold accounts lead', () => {
    const accounts = ['fresh', 'stalest', 'mid', 'cold'].map((k) => ({
      usageKey: `claude:org=${k}`,
      agentId: 'claude' as const,
      fetch: async () => ({ snapshot: sessionSnap(10, NOW), error: null }),
    }));
    const cache: Record<string, HeadroomEntry> = {
      'claude:org=fresh': { ...baseEntry, capturedAt: NOW - 60_000 },
      'claude:org=stalest': { ...baseEntry, capturedAt: NOW - 40 * 60_000 },
      'claude:org=mid': { ...baseEntry, capturedAt: NOW - 10 * 60_000 },
      // 'cold' has no entry → maximally stale, leads the pass.
    };
    const ordered = orderUsageAccounts(accounts, cache, 0).map((a) => a.usageKey);
    expect(ordered).toEqual([
      'claude:org=cold',
      'claude:org=stalest',
      'claude:org=mid',
      'claude:org=fresh',
    ]);
  });

  it('treats a null capturedAt as maximally stale among cached accounts', () => {
    const accounts = ['hasCapture', 'nullCapture'].map((k) => ({
      usageKey: `claude:org=${k}`,
      agentId: 'claude' as const,
      fetch: async () => ({ snapshot: sessionSnap(10, NOW), error: null }),
    }));
    const cache: Record<string, HeadroomEntry> = {
      'claude:org=hasCapture': { ...baseEntry, capturedAt: NOW - 5 * 60_000 },
      'claude:org=nullCapture': { ...baseEntry, capturedAt: null },
    };
    const ordered = orderUsageAccounts(accounts, cache, 0).map((a) => a.usageKey);
    expect(ordered).toEqual(['claude:org=nullCapture', 'claude:org=hasCapture']);
  });
});

describe('providerRecentCalls — aggregate rolling-hour spend per network provider', () => {
  it('sums only network providers, only calls inside the trailing hour', () => {
    const accounts = [
      { usageKey: 'claude:org=a', agentId: 'claude' as const, fetch: async () => ({ snapshot: null, error: null }) },
      { usageKey: 'claude:org=b', agentId: 'claude' as const, fetch: async () => ({ snapshot: null, error: null }) },
      // grok is network:false — no rate-limited endpoint, excluded from the budget.
      { usageKey: 'grok:user=g', agentId: 'grok' as const, fetch: async () => ({ snapshot: null, error: null }) },
    ];
    const cache: Record<string, HeadroomEntry> = {
      'claude:org=a': { ...baseEntry, callTimestamps: [NOW - 10 * 60_000, NOW - 90 * 60_000, NOW - 1_000] },
      'claude:org=b': { ...baseEntry, callTimestamps: [NOW - 5 * 60_000] },
      'grok:user=g': { ...baseEntry, callTimestamps: [NOW - 1_000, NOW - 2_000] },
    };
    const counts = providerRecentCalls(accounts, cache, NOW);
    // claude: 2 recent from a (the 90-min-old one is pruned) + 1 from b = 3.
    expect(counts.get('claude')).toBe(3);
    expect(counts.has('grok')).toBe(false);
  });
});

describe('provider budget — aggregate endpoint pressure does not scale with N', () => {
  let cacheDir: string;
  let prevHeadroom: string | null;
  let prevUsage: string | null;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-budget-'));
    prevHeadroom = setHeadroomCachePathForTest(path.join(cacheDir, '.usage-headroom.json'));
    prevUsage = setClaudeUsageCachePathForTest(path.join(cacheDir, 'claude-usage.json'));
  });

  afterEach(() => {
    setHeadroomCachePathForTest(prevHeadroom);
    setClaudeUsageCachePathForTest(prevUsage);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('caps one tick at PROVIDER_HOURLY_BUDGET fetches even with far more due accounts', async () => {
    const n = PROVIDER_HOURLY_BUDGET + 12; // 8+ accounts is the real case; go well over.
    let fetches = 0;
    const accounts = Array.from({ length: n }, (_, i) => ({
      usageKey: `claude:org=acct-${i}`,
      agentId: 'claude' as const,
      fetch: async () => { fetches += 1; return { snapshot: sessionSnap(10, NOW), error: null }; },
    }));
    const result = await runUsageRefresh({
      now: NOW,
      listAccounts: async () => accounts,
      writeUsageCache: writeClaudeUsageCache,
      backoffUntil: () => null,
    });
    expect(result.refreshed).toBe(PROVIDER_HOURLY_BUDGET);
    expect(result.skippedBudget).toBe(n - PROVIDER_HOURLY_BUDGET);
    expect(fetches).toBe(PROVIDER_HOURLY_BUDGET);
  });

  it('holds the aggregate under the budget across multiple ticks in one hour', async () => {
    const n = PROVIDER_HOURLY_BUDGET + 12;
    let fetches = 0;
    const accounts = Array.from({ length: n }, (_, i) => ({
      usageKey: `claude:org=acct-${i}`,
      agentId: 'claude' as const,
      fetch: async () => { fetches += 1; return { snapshot: sessionSnap(10, NOW), error: null }; },
    }));
    // Three ticks 60s apart — all inside one rolling hour. Budget-skipped accounts
    // stay due and compete again, but the rolling-hour aggregate must not exceed
    // the budget (the endpoint would 429 otherwise).
    for (let tick = 0; tick < 3; tick += 1) {
      await runUsageRefresh({
        now: NOW + tick * USAGE_REFRESH_TICK_MS,
        listAccounts: async () => accounts,
        writeUsageCache: writeClaudeUsageCache,
        backoffUntil: () => null,
      });
    }
    expect(fetches).toBe(PROVIDER_HOURLY_BUDGET);
  });

  it('spends the budget on the STALEST accounts, deferring the freshest', async () => {
    const n = PROVIDER_HOURLY_BUDGET + 1; // exactly one account must be deferred.
    const fetched = new Set<string>();
    const accounts = Array.from({ length: n }, (_, i) => ({
      usageKey: `claude:org=acct-${i}`,
      agentId: 'claude' as const,
      fetch: async () => { fetched.add(`claude:org=acct-${i}`); return { snapshot: sessionSnap(10, NOW), error: null }; },
    }));
    // Seed staggered capture times: acct-0 freshest (NOW-1m), acct-n stalest.
    const seed: Record<string, HeadroomEntry> = {};
    accounts.forEach((a, i) => {
      seed[a.usageKey] = { ...baseEntry, capturedAt: NOW - (i + 1) * 60_000, nextRefreshAt: NOW - 1 };
    });
    writeHeadroomEntries(seed);

    const result = await runUsageRefresh({
      now: NOW,
      listAccounts: async () => accounts,
      writeUsageCache: writeClaudeUsageCache,
      backoffUntil: () => null,
    });
    expect(result.refreshed).toBe(PROVIDER_HOURLY_BUDGET);
    expect(result.skippedBudget).toBe(1);
    // The single deferred account is the FRESHEST one (acct-0, captured 1m ago).
    expect(fetched.has('claude:org=acct-0')).toBe(false);
  });

  it('never calls a parked (backed-off) account, and it does not consume budget', async () => {
    let parkedCalled = false;
    let liveCalled = false;
    const result = await runUsageRefresh({
      now: NOW,
      listAccounts: async () => [
        { usageKey: 'claude:org=parked', agentId: 'claude', fetch: async () => { parkedCalled = true; return { snapshot: sessionSnap(10, NOW), error: null }; } },
        { usageKey: 'claude:org=live', agentId: 'claude', fetch: async () => { liveCalled = true; return { snapshot: sessionSnap(10, NOW), error: null }; } },
      ],
      writeUsageCache: writeClaudeUsageCache,
      backoffUntil: (_agent, usageKey) => (usageKey === 'claude:org=parked' ? NOW + 30 * 60_000 : null),
    });
    expect(parkedCalled).toBe(false);
    expect(liveCalled).toBe(true);
    expect(result.skippedBackoff).toBe(1);
    expect(result.refreshed).toBe(1);
  });

  it('does not API-refresh an account a statusline ingest just captured for free', async () => {
    let fetched = false;
    const key = 'claude:org=statusline-fresh';
    const result = await runUsageRefresh({
      now: NOW,
      listAccounts: async () => [
        { usageKey: key, agentId: 'claude', fetch: async () => { fetched = true; return { snapshot: sessionSnap(10, NOW), error: null }; } },
      ],
      writeUsageCache: writeClaudeUsageCache,
      backoffUntil: () => null,
      // Captured 1 minute ago by the free statusline ingest (< STATUSLINE_FRESH_MS).
      lastCapturedAt: () => NOW - 60_000,
    });
    expect(fetched).toBe(false);
    expect(result.skippedFresh).toBe(1);
    expect(result.refreshed).toBe(0);
    // Rescheduled one interval past the free capture, not re-attempted every tick.
    expect(readHeadroomEntry(key)?.nextRefreshAt).toBe(NOW - 60_000 + STATUSLINE_FRESH_MS);
  });

  it('DOES API-refresh an account whose statusline capture has aged past the window', async () => {
    let fetched = false;
    const result = await runUsageRefresh({
      now: NOW,
      listAccounts: async () => [
        { usageKey: 'claude:org=stale-statusline', agentId: 'claude', fetch: async () => { fetched = true; return { snapshot: sessionSnap(10, NOW), error: null }; } },
      ],
      writeUsageCache: writeClaudeUsageCache,
      backoffUntil: () => null,
      lastCapturedAt: () => NOW - (STATUSLINE_FRESH_MS + 60_000), // older than the window
    });
    expect(fetched).toBe(true);
    expect(result.refreshed).toBe(1);
    expect(result.skippedFresh).toBe(0);
  });
});
