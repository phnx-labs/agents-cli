import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import {
  readState,
  writeState,
  hasChanged,
  dedupeSignature,
  recordFireTime,
  writeFireRecord,
  listFires,
  readLiveness,
  recordCheck,
  markDroughtNotified,
  getMonitorHistoryDir,
  resolveFireOutcome,
} from './state.js';
import type { MonitorEvent } from './config.js';
import { writeRunMeta, getJobRunsDir, type RunMeta } from '../scheduling/routines.js';

const NAME = `test-state-${process.pid}-${Date.now()}`;

afterEach(() => {
  try {
    fs.rmSync(getMonitorHistoryDir(NAME), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(getJobRunsDir(NAME), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('state-diff round-trip', () => {
  it('round-trips a value through writeState/readState', () => {
    expect(readState(NAME)).toBeNull();
    writeState(NAME, 'value-1');
    const state = readState(NAME);
    expect(state).not.toBeNull();
    expect(state!.monitorName).toBe(NAME);
    expect(state!.lastValue).toBe('value-1');
    expect(state!.lastHash.length).toBeGreaterThan(0);
  });

  it('preserves fire bookkeeping across a plain re-observation', () => {
    writeState(NAME, 'v1', undefined, { lastFiredAt: '2026-01-01T00:00:00.000Z', fireTimes: [1, 2] });
    writeState(NAME, 'v2');
    const state = readState(NAME);
    expect(state!.lastValue).toBe('v2');
    expect(state!.lastFiredAt).toBe('2026-01-01T00:00:00.000Z');
    expect(state!.fireTimes).toEqual([1, 2]);
  });
});

describe('hasChanged', () => {
  it('is true when there is no prior state (first observation)', () => {
    expect(hasChanged(NAME, 'anything')).toBe(true);
  });

  it('is false when the observation matches the stored value', () => {
    writeState(NAME, 'same');
    expect(hasChanged(NAME, 'same')).toBe(false);
  });

  it('is true when the observation differs', () => {
    writeState(NAME, 'old');
    expect(hasChanged(NAME, 'new')).toBe(true);
  });

  it('dedupes on the matched token when a dedupeKey is given', () => {
    // Two different full outputs whose dedupeKey match is identical → no change.
    writeState(NAME, 'status: issued at 10:00', 'status: (\\w+)');
    expect(hasChanged(NAME, 'status: issued at 11:59', 'status: (\\w+)')).toBe(false);
    // A different matched token → change.
    expect(hasChanged(NAME, 'status: pending at 12:00', 'status: (\\w+)')).toBe(true);
  });
});

describe('dedupeSignature', () => {
  it('returns the full observation when no key', () => {
    expect(dedupeSignature('abc')).toBe('abc');
  });
  it('returns the first capture group of the key', () => {
    expect(dedupeSignature('build 42 failed', 'build (\\d+)')).toBe('42');
  });
  it('returns the whole match when there is no capture group', () => {
    expect(dedupeSignature('build 42 failed', 'failed')).toBe('failed');
  });
  it('falls back to the full observation on no match', () => {
    expect(dedupeSignature('all good', 'failed')).toBe('all good');
  });
});

describe('recordFireTime', () => {
  it('appends and prunes to the window', () => {
    const now = 1_000_000;
    writeState(NAME, 'v', undefined, { fireTimes: [now - 120_000, now - 10_000] });
    const times = recordFireTime(NAME, now, 60_000); // 60s window
    // The 120s-old entry is pruned; the 10s-old one and now remain.
    expect(times).toEqual([now - 10_000, now]);
  });
});

describe('liveness heartbeat (RUSH-2485)', () => {
  it('is null until the engine records a check', () => {
    expect(readLiveness(NAME)).toBeNull();
  });

  it('records a check and increments checkCount on each poll', () => {
    recordCheck(NAME, '2026-03-01T00:00:00.000Z');
    let live = readLiveness(NAME);
    expect(live!.checkCount).toBe(1);
    expect(live!.lastCheckedAt).toBe('2026-03-01T00:00:00.000Z');
    expect(live!.consecutiveErrors).toBe(0);
    expect(live!.lastError).toBeUndefined();

    recordCheck(NAME, '2026-03-01T00:01:00.000Z');
    live = readLiveness(NAME);
    expect(live!.checkCount).toBe(2);
    expect(live!.lastCheckedAt).toBe('2026-03-01T00:01:00.000Z');
  });

  it('does NOT write change-detection state — a polled-but-never-matched monitor still has no state.json', () => {
    recordCheck(NAME, '2026-03-01T00:00:00.000Z');
    // This is the core bug: heartbeat present, but the monitor never fired, so
    // change-detection state must remain absent (not conflated with the poll).
    expect(readLiveness(NAME)).not.toBeNull();
    expect(readState(NAME)).toBeNull();
  });

  it('accumulates consecutive errors and clears them on a good poll', () => {
    recordCheck(NAME, '2026-03-01T00:00:00.000Z', 'boom');
    recordCheck(NAME, '2026-03-01T00:01:00.000Z', 'boom');
    let live = readLiveness(NAME);
    expect(live!.consecutiveErrors).toBe(2);
    expect(live!.lastError).toBe('boom');

    recordCheck(NAME, '2026-03-01T00:02:00.000Z'); // success
    live = readLiveness(NAME);
    expect(live!.consecutiveErrors).toBe(0);
    expect(live!.lastError).toBeUndefined();
    expect(live!.checkCount).toBe(3); // count still advances
  });

  it('keeps the drought marker across failures and drops it on recovery', () => {
    recordCheck(NAME, '2026-03-01T00:00:00.000Z', 'boom');
    markDroughtNotified(NAME, '2026-03-01T00:00:05.000Z');
    expect(readLiveness(NAME)!.droughtNotifiedAt).toBe('2026-03-01T00:00:05.000Z');

    // Another failure preserves the marker (so we don't re-notify).
    recordCheck(NAME, '2026-03-01T00:01:00.000Z', 'boom');
    expect(readLiveness(NAME)!.droughtNotifiedAt).toBe('2026-03-01T00:00:05.000Z');

    // A good poll clears it, so a fresh drought can escalate again.
    recordCheck(NAME, '2026-03-01T00:02:00.000Z');
    expect(readLiveness(NAME)!.droughtNotifiedAt).toBeUndefined();
  });
});

describe('fire history', () => {
  it('writes and lists fire records', () => {
    const event: MonitorEvent = {
      monitorName: NAME,
      firedAt: '2026-02-01T00:00:00.000Z',
      summary: 'CI failed on #1',
      payload: { exitCode: 1 },
    };
    const id = writeFireRecord(event, { runId: 'run-1', action: 'run', ok: true });
    expect(id).toBe('2026-02-01T00-00-00-000Z');

    const fires = listFires(NAME);
    expect(fires.length).toBe(1);
    expect(fires[0].summary).toBe('CI failed on #1');
    expect(fires[0].runId).toBe('run-1');
    expect(fires[0].ok).toBe(true);
  });
});

/**
 * RUSH-2690: a `run` action fires, `dispatchAction` (lib/monitors/dispatch.ts)
 * records `ok: true` from a SYNCHRONOUS 'running' snapshot, and then the
 * dispatched process spawns, fails, and exits with no output — asynchronously,
 * after the fire record is already frozen on disk. `agents monitors runs`
 * showed a healthy `ok` forever because nothing ever revisited it, while
 * `agents monitors logs` (which reads the run record fresh) already told the
 * truth. `resolveFireOutcome` is the render-time fix: it re-reads the run's
 * CURRENT status by runId on every call, so the displayed outcome tracks
 * reality even though the on-disk fire record never changes.
 *
 * Real disk I/O, no mocking: writes an actual RunMeta via `writeRunMeta`
 * (the same writer `settle()` in lib/daemon/runner.ts uses) and an actual fire
 * record via `writeFireRecord`, then reads both back through the real
 * `resolveFireOutcome`.
 */
describe('resolveFireOutcome (RUSH-2690 — reconcile the frozen ok against the run\'s real status)', () => {
  function baseMeta(runId: string, status: RunMeta['status']): RunMeta {
    return {
      jobName: NAME,
      runId,
      agent: 'claude',
      pid: null,
      spawnedAt: Date.now(),
      timeoutMs: 600_000,
      status,
      startedAt: '2026-08-15T08:00:41.400Z',
      completedAt: status === 'running' ? null : '2026-08-15T08:00:41.414Z',
      exitCode: status === 'running' ? null : 1,
    } as RunMeta;
  }

  const event: MonitorEvent = {
    monitorName: NAME,
    firedAt: '2026-08-15T08:00:41.411Z',
    summary: 'FIRE-NOW',
    payload: {},
  };

  it('the async-race case: fire recorded ok:true off a "running" snapshot, run later failed with no output — reconciled read says failed', () => {
    const runId = 'run-async-fail';
    // The fire, as `writeFireRecord` persisted it at dispatch time: ok:true,
    // because `runMeta.status` was 'running' (not yet in dispatchAction's
    // skipped/blocked/failed negative list) when dispatchAction returned.
    const fire = { ...event, runId, action: 'run', ok: true, runStatusAtFire: 'running' as const };
    // The run then finished asynchronously — no output, exit code 1 — a few
    // ms later, exactly like the ticket's reproduction (fire ok, run skipped
    // 3ms later). `failed` stands in for that class of async-settled outcome.
    writeRunMeta(baseMeta(runId, 'failed'));

    const outcome = resolveFireOutcome(NAME, fire);
    expect(outcome.ok).toBe(false);
    expect(outcome.runStatus).toBe('failed');
  });

  it('a run still genuinely in flight (status: running) still reads ok — not everything running is a bug', () => {
    const runId = 'run-still-running';
    const fire = { ...event, runId, action: 'run', ok: true };
    writeRunMeta(baseMeta(runId, 'running'));

    const outcome = resolveFireOutcome(NAME, fire);
    expect(outcome.ok).toBe(true);
    expect(outcome.runStatus).toBe('running');
  });

  it('a run that settled clean (completed) reads ok', () => {
    const runId = 'run-completed';
    const fire = { ...event, runId, action: 'run', ok: true };
    writeRunMeta(baseMeta(runId, 'completed'));

    const outcome = resolveFireOutcome(NAME, fire);
    expect(outcome.ok).toBe(true);
    expect(outcome.runStatus).toBe('completed');
  });

  it('a run that was skipped/blocked/timeout at settle time still reads failed, not just the async-failed case', () => {
    for (const status of ['skipped', 'blocked', 'timeout'] as const) {
      const runId = `run-${status}`;
      const fire = { ...event, runId, action: 'run', ok: true };
      writeRunMeta(baseMeta(runId, status));
      expect(resolveFireOutcome(NAME, fire).runStatus, status).toBe(status);
      expect(resolveFireOutcome(NAME, fire).ok, status).toBe(false);
    }
  });

  it('a fire with no runId (notify/webhook-out) has nothing to reconcile against — the frozen ok is returned as-is', () => {
    expect(resolveFireOutcome(NAME, { ...event, action: 'notify', ok: true })).toEqual({ ok: true });
    expect(resolveFireOutcome(NAME, { ...event, action: 'notify', ok: false, error: 'no channel' })).toEqual({ ok: false });
  });

  it('a runId whose run record is missing/unreadable falls back to the frozen ok rather than throwing', () => {
    const fire = { ...event, runId: 'run-does-not-exist-on-disk', action: 'run', ok: true };
    expect(resolveFireOutcome(NAME, fire)).toEqual({ ok: true });
  });
});
