import { describe, it, expect } from 'vitest';
import { runFailureReason } from './routines.js';
import type { RunMeta } from '../lib/scheduling/routines.js';

/** Minimal RunMeta with the fields runFailureReason reads; the rest are inert. */
function meta(over: Partial<RunMeta>): RunMeta {
  return {
    jobName: 'r',
    runId: '2026-08-28T09-00-00-000Z',
    status: 'failed',
    startedAt: '2026-08-28T09:00:00.000Z',
    completedAt: '2026-08-28T09:00:01.000Z',
    exitCode: 1,
    ...over,
  } as RunMeta;
}

describe('runFailureReason', () => {
  it('returns null for a healthy run (completed/running need no annotation)', () => {
    expect(runFailureReason(meta({ status: 'completed', exitCode: 0 }))).toBeNull();
    expect(runFailureReason(meta({ status: 'running', completedAt: null, exitCode: null }))).toBeNull();
  });

  it('surfaces the auth-failure text verbatim from errorMessage', () => {
    const r = runFailureReason(meta({ status: 'failed', errorMessage: 'auth_failed: Please run /login' }));
    expect(r).toBe('auth_failed: Please run /login');
  });

  it('names a wedged (active_run) skip in human terms, not the verbose errorMessage', () => {
    // A wedged skip stores no errorMessage on some paths; the skipReason is the signal.
    const r = runFailureReason(meta({ status: 'skipped', skipReason: 'active_run', exitCode: null }));
    expect(r).toBe('wedged: a prior run is still active');
  });

  it('prefers errorMessage when present, even for a skip', () => {
    const r = runFailureReason(meta({
      status: 'skipped', skipReason: 'active_run', exitCode: null,
      errorMessage: "skipped — 'x' already has an active run (2026-08-08T21-24-00-005Z)",
    }));
    expect(r).toContain('already has an active run');
  });

  it('uses the readiness message for a blocked run', () => {
    const r = runFailureReason(meta({
      status: 'blocked', exitCode: null,
      readiness: { code: 'agent_auth_failed', message: 'the selected account failed a live auth check' },
    }));
    expect(r).toBe('the selected account failed a live auth check');
  });

  it('explains a missed fire', () => {
    expect(runFailureReason(meta({ status: 'missed', exitCode: null }))).toBe(
      'scheduler was not running when it came due',
    );
  });

  it('compacts and truncates a long, multiline errorMessage', () => {
    const long = 'x'.repeat(200) + '\n\tmore';
    const r = runFailureReason(meta({ status: 'failed', errorMessage: long }))!;
    expect(r.length).toBeLessThanOrEqual(80);
    expect(r.endsWith('…')).toBe(true);
    expect(r).not.toContain('\n');
  });
});
