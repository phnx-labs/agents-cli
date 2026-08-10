/**
 * Tests for parsing a peer's `--active --json` output during cross-machine
 * fan-out. The parser must be defensive: a peer may run an older/newer agents
 * whose stdout is truncated, non-JSON, or shaped slightly differently, and one
 * bad peer must never throw and blank the whole merged view.
 */

import { describe, it, expect } from 'vitest';
import { parseRemoteActive } from '../remote-active.js';

describe('parseRemoteActive', () => {
  it('tags every parsed session with the source machine', () => {
    const stdout = JSON.stringify([
      { context: 'terminal', kind: 'claude', status: 'running', sessionId: 'a' },
      { context: 'cloud', kind: 'codex', status: 'queued' },
    ]);
    const out = parseRemoteActive(stdout, 'zion');
    expect(out).toHaveLength(2);
    expect(out.every((s) => s.machine === 'zion')).toBe(true);
    expect(out[0].sessionId).toBe('a');
  });

  it('returns [] on non-JSON (a login-shell banner leaked into stdout)', () => {
    expect(parseRemoteActive('bash: agents: command not found\n', 'zion')).toEqual([]);
  });

  it('returns [] when the top level is not an array', () => {
    expect(parseRemoteActive(JSON.stringify({ error: 'nope' }), 'zion')).toEqual([]);
  });

  it('drops non-object entries but keeps the valid ones', () => {
    const stdout = JSON.stringify([null, 'weird', 42, { kind: 'claude', context: 'teams', status: 'idle' }]);
    const out = parseRemoteActive(stdout, 'mark');
    expect(out).toHaveLength(1);
    expect(out[0].machine).toBe('mark');
  });

  it('returns [] on empty stdout (peer produced nothing)', () => {
    expect(parseRemoteActive('', 'zion')).toEqual([]);
  });
});

describe('parseRemoteActive viewingIn normalization', () => {
  it('turns a peer label back into the internal viewer shape', () => {
    const rows = parseRemoteActive(JSON.stringify([{ sessionId: 'a', viewingIn: 'codium tab 3' }]), 'peer');
    expect(rows[0].viewingIn).toEqual({ app: 'codium', tab: 3 });
  });

  it('treats a detached peer row as having no viewer', () => {
    const rows = parseRemoteActive(JSON.stringify([{ sessionId: 'a', viewingIn: 'detached' }]), 'peer');
    expect(rows[0].viewingIn).toBeUndefined();
  });

  it('accepts the object shape a peer on an older version emits', () => {
    const rows = parseRemoteActive(JSON.stringify([{ sessionId: 'a', viewingIn: { app: 'ghostty', tab: 2 } }]), 'peer');
    expect(rows[0].viewingIn).toEqual({ app: 'ghostty', tab: 2 });
  });

  // RUSH-2479: a peer answering the fan-out may report a THIRD box, because a
  // host-dispatched run executes where it was sent, not where it was launched.
  // Stamping the dialed peer over that would re-claim the session for the wrong
  // machine and undo foldExecutionMachine's correction.
  it("keeps an OFFLOADED row's own machine — its execution host is a third box", () => {
    const stdout = JSON.stringify([
      { context: 'terminal', kind: 'claude', status: 'running', sessionId: 'off', machine: 'yosemite-s0', offloadedFrom: 'zion' },
    ]);
    const out = parseRemoteActive(stdout, 'zion');
    expect(out[0].machine).toBe('yosemite-s0');
    expect(out[0].offloadedFrom).toBe('zion');
  });

  it('still stamps the dialed device over a peer\'s own hostname (the name we key scopes on)', () => {
    // The peer reports machineId() (its hostname); we dial and scope by the
    // REGISTERED device name. Stamping ours is what reconciles the two — drop it
    // and a device whose registered name differs from its hostname answers a
    // `--device <name>` scope with zero rows.
    const stdout = JSON.stringify([
      { context: 'terminal', kind: 'claude', status: 'running', sessionId: 'a', machine: 'mark.local' },
    ]);
    expect(parseRemoteActive(stdout, 'mark')[0].machine).toBe('mark');
  });

  it('still stamps the dialed peer when the row reports no machine at all', () => {
    const stdout = JSON.stringify([
      { context: 'terminal', kind: 'claude', status: 'running', sessionId: 'a' },
    ]);
    expect(parseRemoteActive(stdout, 'zion')[0].machine).toBe('zion');
  });
});
