import { describe, it, expect } from 'vitest';
import { resolveMessageTarget, mailboxIdForActiveSession } from './mailbox-target.js';
import type { ActiveSession } from './session/active.js';

/** Minimal live-session builder (only the fields the resolver reads). */
function mk(over: Partial<ActiveSession>): ActiveSession {
  return { context: 'headless', kind: 'claude', status: 'running', ...over };
}

const noCloud = () => false;

describe('resolveMessageTarget', () => {
  it('routes a cloud task id to the cloud path (checked first)', () => {
    const res = resolveMessageTarget('task-123', [], (id) => id === 'task-123');
    expect(res).toEqual({ kind: 'cloud', id: 'task-123' });
  });

  it('resolves an exact sessionId to that one local box', () => {
    const sessions = [mk({ sessionId: 'aaaa-1111' }), mk({ sessionId: 'bbbb-2222' })];
    expect(resolveMessageTarget('aaaa-1111', sessions, noCloud)).toEqual({ kind: 'local', id: 'aaaa-1111' });
  });

  it('resolves a unique prefix to one box', () => {
    const sessions = [mk({ sessionId: 'aaaa-1111' }), mk({ sessionId: 'bbbb-2222' })];
    expect(resolveMessageTarget('aaaa', sessions, noCloud)).toEqual({ kind: 'local', id: 'aaaa-1111' });
  });

  it('errors (never guesses) when a prefix matches more than one agent', () => {
    const sessions = [
      mk({ sessionId: 'aaaa-1111', topic: 'refactor' }),
      mk({ sessionId: 'aaaa-2222', topic: 'tests' }),
    ];
    const res = resolveMessageTarget('aaaa', sessions, noCloud);
    expect(res.kind).toBe('ambiguous');
    if (res.kind === 'ambiguous') {
      expect(res.candidates.map((c) => c.id).sort()).toEqual(['aaaa-1111', 'aaaa-2222']);
      expect(res.candidates[0].label).toBeTruthy();
    }
  });

  it('returns none when nothing matches', () => {
    expect(resolveMessageTarget('zzzz', [mk({ sessionId: 'aaaa-1111' })], noCloud)).toEqual({ kind: 'none' });
  });

  it('keys a teams teammate box by agentId', () => {
    const s = mk({ context: 'teams', agentId: 'agent-uuid', sessionId: 'agent-uuid', teamName: 'feat' });
    expect(mailboxIdForActiveSession(s)).toBe('agent-uuid');
    expect(resolveMessageTarget('agent-uuid', [s], noCloud)).toEqual({ kind: 'local', id: 'agent-uuid' });
  });

  it('routes to agentId even when sessionId differs (RUSH-1534 regression)', () => {
    const s = mk({
      context: 'teams',
      agentId: 'teams-minted-uuid',
      sessionId: 'runtime-session-uuid',
      teamName: 'feat',
    });
    expect(mailboxIdForActiveSession(s)).toBe('teams-minted-uuid');
    expect(resolveMessageTarget('teams-minted-uuid', [s], noCloud)).toEqual({
      kind: 'local',
      id: 'teams-minted-uuid',
    });
    expect(resolveMessageTarget('runtime-session-uuid', [s], noCloud)).toEqual({
      kind: 'local',
      id: 'teams-minted-uuid',
    });
  });

  it('collapses multiple rows that share one canonical id (subagents/forks) to a single box', () => {
    const sessions = [
      mk({ sessionId: 'aaaa-1111', pidCount: 2 }),
      mk({ sessionId: 'aaaa-1111', pidCount: 2 }),
    ];
    expect(resolveMessageTarget('aaaa-1111', sessions, noCloud)).toEqual({ kind: 'local', id: 'aaaa-1111' });
  });

  it('treats an empty target as no match (no startsWith-matches-everything footgun)', () => {
    const sessions = [mk({ sessionId: 'aaaa-1111' }), mk({ sessionId: 'bbbb-2222' })];
    expect(resolveMessageTarget('', sessions, noCloud)).toEqual({ kind: 'none' });
    // even with a single running agent, empty must not silently deliver.
    expect(resolveMessageTarget('', [mk({ sessionId: 'only-one' })], noCloud)).toEqual({ kind: 'none' });
  });

  it('exact match wins over a prefix that would be ambiguous', () => {
    const sessions = [mk({ sessionId: 'aaaa' }), mk({ sessionId: 'aaaa-longer' })];
    // 'aaaa' is an exact id of the first AND a prefix of the second — exact wins.
    expect(resolveMessageTarget('aaaa', sessions, noCloud)).toEqual({ kind: 'local', id: 'aaaa' });
  });
});
