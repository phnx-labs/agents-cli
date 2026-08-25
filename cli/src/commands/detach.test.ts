import { describe, it, expect } from 'vitest';
import { buildBackgroundArgv, resolveDetachTarget, resolveOne, BACKGROUND_NUDGE } from './detach-core.js';
import type { ActiveSession } from '../lib/session/active.js';

function session(sessionId: string): ActiveSession {
  return { context: 'terminal', kind: 'claude', sessionId, status: 'running' } as ActiveSession;
}

describe('buildBackgroundArgv', () => {
  it('resumes the session headless with the nudge, agent-agnostic', () => {
    expect(buildBackgroundArgv('codex', 'sess-123', '/repo')).toEqual([
      'run',
      'codex',
      BACKGROUND_NUDGE,
      '--resume',
      'sess-123',
      '--headless',
      '--cwd',
      '/repo',
    ]);
  });

  it('omits --cwd when the session has none', () => {
    expect(buildBackgroundArgv('claude', 'sess-9')).toEqual([
      'run',
      'claude',
      BACKGROUND_NUDGE,
      '--resume',
      'sess-9',
      '--headless',
    ]);
  });

  it('the nudge tells the agent it is unattended and not to ask', () => {
    expect(BACKGROUND_NUDGE).toMatch(/background/i);
    expect(BACKGROUND_NUDGE).toMatch(/don'?t ask/i);
  });
});

describe('resolveOne', () => {
  const map = new Map<string, ActiveSession>([
    ['1', session('abc12345-aaaa')],
    ['2', session('abc99999-bbbb')],
    ['3', session('def00000-cccc')],
  ]);

  it('resolves a unique prefix to that session', () => {
    const r = resolveOne(map, 'def');
    expect('error' in r).toBe(false);
    expect((r as ActiveSession).sessionId).toBe('def00000-cccc');
  });

  it('is case-insensitive', () => {
    const r = resolveOne(map, 'DEF0');
    expect((r as ActiveSession).sessionId).toBe('def00000-cccc');
  });

  it('errors (ambiguous) when a prefix matches more than one', () => {
    const r = resolveOne(map, 'abc');
    expect('error' in r && r.error).toMatch(/ambiguous/i);
  });

  it('errors (none) when nothing matches', () => {
    const r = resolveOne(map, 'zzz');
    expect('error' in r && r.error).toMatch(/no live session/i);
  });
});

describe('resolveDetachTarget', () => {
  it('detaches a local session (same machine) locally', () => {
    const s = { context: 'terminal', kind: 'claude', sessionId: 'abc-1', machine: 'zion' } as ActiveSession;
    expect(resolveDetachTarget(s, 'zion')).toEqual({ kind: 'local', sessionId: 'abc-1' });
  });

  it('treats a session with no machine as local', () => {
    const s = { context: 'terminal', kind: 'claude', sessionId: 'abc-2' } as ActiveSession;
    expect(resolveDetachTarget(s, 'zion')).toEqual({ kind: 'local', sessionId: 'abc-2' });
  });

  it('delegates a session on another host to that host over SSH', () => {
    const s = { context: 'terminal', kind: 'claude', sessionId: 'abc-3', machine: 'yosemite-s0' } as ActiveSession;
    expect(resolveDetachTarget(s, 'zion')).toEqual({
      kind: 'remote',
      machine: 'yosemite-s0',
      sessionId: 'abc-3',
    });
  });

  it('refuses cloud sessions (they run remotely with their own lifecycle)', () => {
    const s = { context: 'cloud', kind: 'claude', sessionId: 'abc-4' } as ActiveSession;
    const t = resolveDetachTarget(s, 'zion');
    expect(t.kind).toBe('refuse');
    expect(t.kind === 'refuse' && t.reason).toMatch(/cloud/i);
  });

  it('refuses team sessions so it can\'t bypass the team stop path', () => {
    const s = { context: 'teams', kind: 'claude', sessionId: 'abc-5', pid: 4321 } as ActiveSession;
    const t = resolveDetachTarget(s, 'zion');
    expect(t.kind).toBe('refuse');
    expect(t.kind === 'refuse' && t.reason).toMatch(/team/i);
  });

  it('refuses a session with no id to resume', () => {
    const s = { context: 'terminal', kind: 'claude', sessionId: '' } as ActiveSession;
    const t = resolveDetachTarget(s, 'zion');
    expect(t.kind).toBe('refuse');
    expect(t.kind === 'refuse' && t.reason).toMatch(/no id/i);
  });
});
