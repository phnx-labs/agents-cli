import { describe, it, expect } from 'vitest';
import { foldHostLink, type ActiveSession } from './active';
import { HOST_HEARTBEAT_STALE_MS } from './host-link';

const staleWindow = Date.now() - HOST_HEARTBEAT_STALE_MS - 1;
const freshWindow = Date.now() - 30_000;

function row(over: Partial<ActiveSession>): ActiveSession {
  return { context: 'terminal', kind: 'claude', status: 'idle', ...over };
}

/**
 * `foldHostLink` is where a lost host actually changes what the user reads in the
 * status column, so the tests are about PRECEDENCE: the new statuses must replace
 * exactly the ones they improve on and leave the rest alone. Over-reporting is
 * the failure mode that would make the feature worthless — a listing where every
 * headless run says "orphan" trains the user to ignore the word.
 */
describe('foldHostLink status precedence', () => {
  it('turns a dead agent under a dead window into `crashed` instead of a bare `closed`', () => {
    const rows = [row({ status: 'closed', windowHeartbeatMs: staleWindow })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('crashed');
    expect(rows[0].hostLink).toBe('host-gone');
  });

  it('leaves an ordinary close as `closed` — the window is alive and just had not republished', () => {
    const rows = [row({ status: 'closed', windowHeartbeatMs: freshWindow })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('closed');
  });

  it('turns an idle session with nothing attached into `orphaned`', () => {
    const rows = [row({ status: 'idle', tmuxClients: 0 })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('orphaned');
    expect(rows[0].hostLink).toBe('no-client');
  });

  it('turns a session WAITING on input with nothing attached into `orphaned` — nobody is coming', () => {
    const rows = [row({ status: 'input_required', tmuxClients: 0 })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('orphaned');
  });

  it('leaves a WORKING session alone even with no client — that is a normal headless run', () => {
    const rows = [row({ status: 'running', tmuxClients: 0 })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('running');
    // The link is still recorded, so a consumer can see it; only the status is untouched.
    expect(rows[0].hostLink).toBe('no-client');
  });

  it('leaves a deliberately detached session alone — no client is the point of detaching', () => {
    const rows = [row({ status: 'idle', tmuxClients: 0, presence: 'background' })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('idle');
    expect(rows[0].hostLink).toBe('connected');
  });

  it('lets `abandoned` win outright and claims no host link for it', () => {
    const rows = [row({ status: 'abandoned', tmuxClients: 0, windowHeartbeatMs: staleWindow })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('abandoned');
    expect(rows[0].hostLink).toBeUndefined();
  });

  it('skips cloud rows — they have no local pid, window, or tmux server to lose', () => {
    const rows = [row({ context: 'cloud', status: 'idle' })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('idle');
    expect(rows[0].hostLink).toBeUndefined();
  });

  it('leaves a healthy attached session untouched', () => {
    const rows = [row({ status: 'idle', tmuxClients: 1, windowHeartbeatMs: freshWindow })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('idle');
    expect(rows[0].hostLink).toBe('connected');
  });
});

describe('foldHostLink presence honesty', () => {
  it('drops the derived `attached` presence when the host is gone — nobody is watching it', () => {
    const rows = [row({ status: 'closed', windowHeartbeatMs: staleWindow, presence: 'attached' })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('crashed');
    expect(rows[0].presence).toBeUndefined();
  });

  it('keeps a STORED detach record intact — only the derived `attached` is cleared', () => {
    const rows = [row({ status: 'idle', tmuxClients: 0, presence: 'parked' })];
    foldHostLink(rows);
    expect(rows[0].presence).toBe('parked');
  });
});
