/**
 * daemon-ticks.ts holds the daemon's account-state tick bodies (usage + fleet
 * auth), which the `account-state-service.ts` timers call directly in-process.
 * `isFreshFleetAuthSnapshot` is the freshness predicate the on-demand fleet auth
 * refresh uses to decide whether a recent daemon publication already satisfies a
 * request or a fresh provider probe is needed — the risky bit worth pinning.
 */

import { describe, it, expect } from 'vitest';
import { isFreshFleetAuthSnapshot } from './daemon-ticks.js';

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
