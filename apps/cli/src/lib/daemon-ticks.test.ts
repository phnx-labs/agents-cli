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
import { isFreshFleetAuthSnapshot, runActiveSessionsWarmTick } from './daemon-ticks.js';
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

describe('usage refresh publisher/subscriber gate', () => {
  it('publishes locally when this host is primary or the pin is absent', () => {
    expect(usageRefreshRole(undefined, 'zion')).toBe('publisher');
    expect(usageRefreshRole('zion', 'zion')).toBe('publisher');
  });

  it('subscribes without provider refreshes when another host is primary', () => {
    expect(usageRefreshRole('yosemite-s0', 'zion')).toBe('subscriber');
  });
});
