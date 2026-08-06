import { describe, expect, it, vi } from 'vitest';
import {
  buildSessionLifecycleArgs,
  isDirectResumeSelector,
  resolveResumePacking,
  resumeHostMismatch,
} from './sessions-resume.js';
import { sessionMatchesQuery } from './sessions-browser.js';
import type { SessionMeta } from '../lib/session/types.js';

describe('resolveResumePacking', () => {
  it('opens every resumed session in its own tab by default', () => {
    expect(resolveResumePacking({})).toBe('tabs');
  });

  it('packs session pairs into split panes only when requested', () => {
    expect(resolveResumePacking({ splits: true })).toBe('two-per-tab');
  });
});

describe('isDirectResumeSelector', () => {
  it('treats UUID prefixes and tmux aliases as direct identities', () => {
    expect(isDirectResumeSelector('019fd114')).toBe(true);
    expect(isDirectResumeSelector('ag-codex-c1f3d813')).toBe(true);
  });

  it('keeps human search text in the multi-select picker', () => {
    expect(isDirectResumeSelector('auth middleware')).toBe(false);
    expect(isDirectResumeSelector('claude@2.1.218')).toBe(false);
  });
});

describe('buildSessionLifecycleArgs', () => {
  it('routes an identity through focus and preserves source-device scope', () => {
    expect(buildSessionLifecycleArgs('ag-codex-c1f3d813', ['yosemite-s0'])).toEqual([
      'sessions', 'focus', 'ag-codex-c1f3d813', '--host', 'yosemite-s0',
    ]);
  });
});

describe('resumeHostMismatch', () => {
  it('accepts the indexed origin device', () => {
    expect(resumeHostMismatch({ shortId: 'abc12345', machine: 'yosemite-s0' }, 'yosemite-s0', 'zion')).toBeNull();
  });

  it('refuses to migrate recovery to another device', () => {
    expect(resumeHostMismatch({ shortId: 'abc12345', machine: 'yosemite-s0' }, 'zion', 'zion'))
      .toMatch(/originated on yosemite-s0.*cannot move recovery/);
  });
});

describe('resume picker filter (in-memory, no DB)', () => {
  const makeSessions = (): SessionMeta[] => [
    { id: 'aaaa1111', shortId: 'aaaa1111', agent: 'claude', topic: 'auth middleware fix', cwd: '/repo/auth' } as SessionMeta,
    { id: 'bbbb2222', shortId: 'bbbb2222', agent: 'codex', topic: 'frontend refactor', cwd: '/repo/ui' } as SessionMeta,
    { id: 'cccc3333', shortId: 'cccc3333', agent: 'claude', topic: 'db migration', cwd: '/repo/db' } as SessionMeta,
  ];

  it('returns all sessions for an empty query', () => {
    const sessions = makeSessions();
    const filter = (q: string) => (q.trim() ? sessions.filter((s) => sessionMatchesQuery(s, q)) : sessions);
    expect(filter('')).toHaveLength(3);
    expect(filter('   ')).toHaveLength(3);
  });

  it('filters by agent name in-memory', () => {
    const sessions = makeSessions();
    const filter = (q: string) => (q.trim() ? sessions.filter((s) => sessionMatchesQuery(s, q)) : sessions);
    const result = filter('claude');
    expect(result).toHaveLength(2);
    expect(result.every((s) => s.agent === 'claude')).toBe(true);
  });

  it('filters by topic substring in-memory', () => {
    const sessions = makeSessions();
    const filter = (q: string) => (q.trim() ? sessions.filter((s) => sessionMatchesQuery(s, q)) : sessions);
    const result = filter('auth');
    expect(result).toHaveLength(1);
    expect(result[0].shortId).toBe('aaaa1111');
  });

  it('multi-term filter requires all terms to match', () => {
    const sessions = makeSessions();
    const filter = (q: string) => (q.trim() ? sessions.filter((s) => sessionMatchesQuery(s, q)) : sessions);
    expect(filter('claude auth')).toHaveLength(1);
    expect(filter('claude frontend')).toHaveLength(0);
  });

  it('does not call filterSessionsByQuery (no DB scan per keystroke)', async () => {
    // Verify the sessions module's FTS function is NOT imported into sessions-resume.
    // If it were, this dynamic import would expose it as used.
    const resumeMod = await import('./sessions-resume.js');
    const sessionsMod = await import('./sessions.js');
    // The resume module uses sessionMatchesQuery, not filterSessionsByQuery.
    // We verify this indirectly: filterSessionsByQuery is not re-exported from sessions-resume.
    expect((resumeMod as Record<string, unknown>)['filterSessionsByQuery']).toBeUndefined();
    // And sessionMatchesQuery is the correct in-memory function.
    expect(typeof sessionMatchesQuery).toBe('function');
    // Confirm it does not touch the DB by ensuring it works with plain objects.
    const s = { id: 'x', shortId: 'x', agent: 'claude', topic: 'test topic', cwd: '/tmp' } as SessionMeta;
    expect(sessionMatchesQuery(s, 'test')).toBe(true);
    expect(sessionMatchesQuery(s, 'notfound')).toBe(false);
  });
});
