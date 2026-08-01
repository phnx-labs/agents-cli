import { describe, it, expect } from 'vitest';
import { buildBackgroundArgv, resolveOne, BACKGROUND_NUDGE } from './detach-core.js';
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
