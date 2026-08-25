/**
 * Tests for the `agents reconnect` no-id target selection. The load-bearing logic
 * is pure — which session a bare `agents reconnect` re-enters — so it is exercised
 * directly with real SessionMeta inputs, no mocks. `resolveRecentTarget` takes an
 * injected `discover` so the two-step scope preference (this directory first, then
 * anywhere) is proven without touching the real scanner. The attach-else-resume
 * itself is `focusAction`, covered by focus.test.ts; reconnect only chooses the id.
 */
import { describe, expect, test } from 'vitest';
import type { SessionMeta } from '../lib/session/types.js';
import { sessionRecency, pickMostRecentSession, resolveRecentTarget } from './reconnect.js';

function meta(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    shortId: id.slice(0, 8),
    agent: 'claude',
    timestamp: '2026-08-01T00:00:00.000Z',
    filePath: '',
    ...over,
  };
}

describe('sessionRecency — last activity wins, else creation time', () => {
  test('prefers lastActivity over timestamp', () => {
    expect(sessionRecency({ timestamp: '2026-08-01T00:00:00Z', lastActivity: '2026-08-02T00:00:00Z' }))
      .toBe(Date.parse('2026-08-02T00:00:00Z'));
  });

  test('falls back to timestamp when lastActivity is absent', () => {
    expect(sessionRecency({ timestamp: '2026-08-01T00:00:00Z' })).toBe(Date.parse('2026-08-01T00:00:00Z'));
  });

  test('an unparseable row sorts last, never NaN', () => {
    expect(sessionRecency({ timestamp: 'not-a-date' })).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('pickMostRecentSession — the terminal that most likely just dropped', () => {
  test('returns the most recently active session', () => {
    const chosen = pickMostRecentSession([
      meta('old', { lastActivity: '2026-08-01T00:00:00Z' }),
      meta('newest', { lastActivity: '2026-08-03T00:00:00Z' }),
      meta('mid', { lastActivity: '2026-08-02T00:00:00Z' }),
    ]);
    expect(chosen?.id).toBe('newest');
  });

  test('an empty scope yields undefined (caller prints guidance)', () => {
    expect(pickMostRecentSession([])).toBeUndefined();
  });

  test('a row with no parseable time never beats a real one', () => {
    const chosen = pickMostRecentSession([
      meta('broken', { timestamp: 'nope', lastActivity: undefined }),
      meta('real', { lastActivity: '2026-08-02T00:00:00Z' }),
    ]);
    expect(chosen?.id).toBe('real');
  });
});

describe('resolveRecentTarget — this directory first, then anywhere', () => {
  test('picks the most recent session from the current directory when it has one', async () => {
    const calls: Array<{ cwd?: string; all?: boolean }> = [];
    const target = await resolveRecentTarget('/work/here', async (opts) => {
      calls.push(opts);
      // Scoped-to-cwd query returns a session -> the fleet-wide query never runs.
      return [meta('here-1', { cwd: '/work/here', lastActivity: '2026-08-05T00:00:00Z' })];
    });
    expect(target?.id).toBe('here-1');
    expect(calls).toEqual([{ cwd: '/work/here', since: '7d', limit: 200 }]);
  });

  test('falls back to the most recent session anywhere when this directory has none', async () => {
    const target = await resolveRecentTarget('/empty', async (opts) =>
      opts.cwd ? [] : [meta('somewhere', { lastActivity: '2026-08-04T00:00:00Z' })],
    );
    expect(target?.id).toBe('somewhere');
  });

  test('a discovery failure is best-effort — returns undefined, never throws', async () => {
    const target = await resolveRecentTarget('/x', async () => {
      throw new Error('scanner blew up');
    });
    expect(target).toBeUndefined();
  });
});
