/**
 * daemon-ticks.ts holds the daemon's account-state tick bodies (usage + fleet
 * auth), which the `account-state-service.ts` timers call directly in-process.
 * `isFreshFleetAuthSnapshot` is the freshness predicate the on-demand fleet auth
 * refresh uses to decide whether a recent daemon publication already satisfies a
 * request or a fresh provider probe is needed — the risky bit worth pinning.
 *
 * `runActiveSessionsWarmTick` is the continuous journal writer `sessions watch`
 * depends on (RUSH-2484). Without it Factory freezes after the initial snapshot.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isFreshFleetAuthSnapshot, isCachedFleetAuthProbeFresh, shouldReuseCachedAuthProbe, AUTH_PROBE_MAX_AGE_MS, runActiveSessionsWarmTick } from './daemon-ticks.js';
import {
  readActiveSessionsCache,
  setActiveSessionsSnapshotPathForTest,
  setImmutableMemoPathForTest,
} from './session/session-cache.js';
import { usageRefreshRole } from './usage-fleet.js';

describe('isFreshFleetAuthSnapshot', () => {
  const minimum = 1_000;
  const row = { host: 'host-a', agents: { running: 0, live: 0, byContext: {}, byAgent: {} }, stats: null, capturedAt: minimum };
  const authRow = { agent: 'claude' as const, version: '1.0.0', health: { verdict: 'live' as const, checkedAt: minimum } };

  it('requires auth rows captured in the same freshness window as fleet status', () => {
    expect(isFreshFleetAuthSnapshot({ row, authRows: [] }, minimum)).toBe(false);
    expect(isFreshFleetAuthSnapshot({ row, authRows: [{ ...authRow, health: { ...authRow.health, checkedAt: minimum - 1 } }] }, minimum)).toBe(false);
    expect(isFreshFleetAuthSnapshot({ row, authRows: [authRow] }, minimum)).toBe(true);
  });
});

describe('isCachedFleetAuthProbeFresh — periodic tick reuses a real verdict, does not re-hit /oauth/usage every 3min (RUSH-2998)', () => {
  const now = 100 * 60_000;
  const row = (checkedAt: number) => ({ agent: 'claude' as const, version: '1.0.0', health: { verdict: 'live' as const, checkedAt } });

  it('reuses a verdict probed within the 20-minute window', () => {
    expect(isCachedFleetAuthProbeFresh([row(now - 5 * 60_000)], now)).toBe(true);
    // Exactly at the boundary is stale (strict <), so the tick re-probes.
    expect(isCachedFleetAuthProbeFresh([row(now - AUTH_PROBE_MAX_AGE_MS)], now)).toBe(false);
    expect(isCachedFleetAuthProbeFresh([row(now - (AUTH_PROBE_MAX_AGE_MS + 60_000))], now)).toBe(false);
  });

  it('never reuses an empty cache (nothing to reuse — must probe)', () => {
    expect(isCachedFleetAuthProbeFresh([], now)).toBe(false);
  });

  it('re-probes when ANY row is stale, so one aged account cannot pin the rest to a stale verdict', () => {
    expect(isCachedFleetAuthProbeFresh([row(now - 60_000), row(now - (AUTH_PROBE_MAX_AGE_MS + 1))], now)).toBe(false);
  });

  // force=true is the on-demand `agents devices ping [--strict]` contract: it must
  // NEVER reuse the throttled cached verdict, or --strict silently passes a revoked
  // account whose cache row is still inside the 20-minute window. Both runFleetPing
  // call sites pass force:true for exactly this reason (RUSH-2998).
  it('force always re-probes, even against a perfectly fresh cache', () => {
    const freshCache = [row(now - 60_000)];
    expect(shouldReuseCachedAuthProbe(false, freshCache, now)).toBe(true);  // periodic tick reuses
    expect(shouldReuseCachedAuthProbe(true, freshCache, now)).toBe(false);  // on-demand ping re-probes
  });

  it('force never rescues an empty or stale cache into a reuse either', () => {
    expect(shouldReuseCachedAuthProbe(true, [], now)).toBe(false);
    expect(shouldReuseCachedAuthProbe(false, [], now)).toBe(false);
    expect(shouldReuseCachedAuthProbe(false, [row(now - (AUTH_PROBE_MAX_AGE_MS + 1))], now)).toBe(false);
  });
});

describe('runActiveSessionsWarmTick', () => {
  let dir: string;
  let prevSnap: string | null;
  let prevImm: string | null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'active-warm-'));
    prevSnap = setActiveSessionsSnapshotPathForTest(path.join(dir, 'snap.json'));
    prevImm = setImmutableMemoPathForTest(path.join(dir, 'imm.json'));
  });

  afterEach(() => {
    setActiveSessionsSnapshotPathForTest(prevSnap);
    setImmutableMemoPathForTest(prevImm);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('publishes a local active-sessions snapshot (daemon continuous writer)', async () => {
    const r = await runActiveSessionsWarmTick({ gather: async () => [] });
    expect(r.sessions).toBe(0);
    const cached = readActiveSessionsCache('local');
    expect(cached).not.toBeNull();
    expect(cached!.sessions).toEqual([]);
    const journal = fs.readFileSync(path.join(dir, 'snap.json.journal.jsonl'), 'utf8').trim().split('\n');
    expect(journal.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(journal.at(-1)!)).toMatchObject({ version: 1, scope: 'local', upserts: [], removes: [] });
  });
});

// `runSessionIndexWarmTick` is covered by daemon-ticks.session-index.test.ts,
// which must redirect HOME before the session modules load (they capture it at
// import time) — so it needs its own file rather than a suite here.

describe('usage refresh publisher/subscriber gate', () => {
  it('publishes locally when this host is primary or the pin is absent', () => {
    expect(usageRefreshRole(undefined, 'zion')).toBe('publisher');
    expect(usageRefreshRole('zion', 'zion')).toBe('publisher');
  });

  it('subscribes without provider refreshes when another host is primary', () => {
    expect(usageRefreshRole('yosemite-s0', 'zion')).toBe('subscriber');
  });
});
