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
