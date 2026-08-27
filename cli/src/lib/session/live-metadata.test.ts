/**
 * RUSH-2682: the live-registry → SessionMeta bridge. A running session the live
 * registry already knows about must become a resolvable SessionMeta candidate so
 * `preview` / `resume` / `focus` render it instead of "No session matching",
 * even before its transcript reaches the lazy index. Pure — deterministic given
 * `self` + `nowMs`, so it needs no DB or process table.
 */
import { describe, it, expect } from 'vitest';
import { activeSessionToSessionMeta, liveSessionMetas } from './live-metadata.js';
import type { ActiveSession } from './active.js';

function active(partial: Partial<ActiveSession>): ActiveSession {
  return {
    context: 'headless',
    kind: 'claude',
    status: 'running',
    ...partial,
  } as ActiveSession;
}

describe('activeSessionToSessionMeta', () => {
  const self = 'this-box';
  const now = 1_700_000_000_000;

  it('reshapes a running session into a resolvable SessionMeta', () => {
    const meta = activeSessionToSessionMeta(
      active({
        sessionId: 'b947a623-1111-2222-3333-444444444444',
        kind: 'claude',
        cwd: '/home/me/repo',
        project: 'repo',
        label: 'do the thing',
        topic: 'a topic',
        version: '2.1.226',
        sessionFile: '/home/me/.claude/projects/p/b947a623.jsonl',
        startedAtMs: now - 5_000,
        lastActivityMs: now - 1_000,
        ticket: { id: 'RUSH-2682' },
        pr: { url: 'https://github.com/o/r/pull/9', number: 9 },
        worktree: { path: '/w', slug: 'wt', branch: 'feat' },
      }),
      self,
      now,
    );
    expect(meta).not.toBeNull();
    expect(meta!.id).toBe('b947a623-1111-2222-3333-444444444444');
    expect(meta!.shortId).toBe('b947a623');
    expect(meta!.agent).toBe('claude');
    expect(meta!.harness).toBeUndefined();
    // The transcript path rides across, so buildPreview parses the real digest
    // when the file is on disk.
    expect(meta!.filePath).toBe('/home/me/.claude/projects/p/b947a623.jsonl');
    expect(meta!.cwd).toBe('/home/me/repo');
    expect(meta!.project).toBe('repo');
    expect(meta!.label).toBe('do the thing');
    expect(meta!.version).toBe('2.1.226');
    expect(meta!.machine).toBe(self);
    expect(meta!.ticketId).toBe('RUSH-2682');
    expect(meta!.prUrl).toBe('https://github.com/o/r/pull/9');
    expect(meta!.prNumber).toBe(9);
    expect(meta!.worktreeSlug).toBe('wt');
    expect(meta!.gitBranch).toBe('feat');
    expect(meta!.timestamp).toBe(new Date(now - 5_000).toISOString());
    expect(meta!.lastActivity).toBe(new Date(now - 1_000).toISOString());
  });

  it('carries the custom-harness stamp so preview of a live deepseek run is not claude (PHNX-2935)', () => {
    const meta = activeSessionToSessionMeta(
      active({
        sessionId: 'b947a623-1111-2222-3333-444444444444',
        kind: 'claude',
        harness: 'deepseek',
      }),
      self,
      now,
    );
    expect(meta!.agent).toBe('claude');
    expect(meta!.harness).toBe('deepseek');
  });

  it('leaves filePath empty when the transcript has no path yet (renders header + live note)', () => {
    const meta = activeSessionToSessionMeta(
      active({ sessionId: 'aaaa1111-0000-0000-0000-000000000000', sessionFile: undefined }),
      self,
      now,
    );
    expect(meta!.filePath).toBe('');
  });

  it('honors an execution machine already stamped on the row', () => {
    const meta = activeSessionToSessionMeta(
      active({ sessionId: 'aaaa2222-0000-0000-0000-000000000000', machine: 'peer-box' }),
      self,
      now,
    );
    expect(meta!.machine).toBe('peer-box');
  });

  it('drops a row with no session id — nothing durable to resolve', () => {
    expect(activeSessionToSessionMeta(active({ sessionId: undefined }), self, now)).toBeNull();
  });

  it('drops a row whose kind is not a session-tracked harness (cloud/team rows)', () => {
    expect(
      activeSessionToSessionMeta(
        active({ sessionId: 'aaaa3333-0000-0000-0000-000000000000', kind: 'cloud' }),
        self,
        now,
      ),
    ).toBeNull();
  });

  it('falls back to nowMs when the row carries no start time', () => {
    const meta = activeSessionToSessionMeta(
      active({ sessionId: 'aaaa4444-0000-0000-0000-000000000000', startedAtMs: undefined }),
      self,
      now,
    );
    expect(meta!.timestamp).toBe(new Date(now).toISOString());
  });
});

describe('liveSessionMetas', () => {
  it('maps the eligible rows and drops the rest', () => {
    const self = 'this-box';
    const now = 1_700_000_000_000;
    const rows = liveSessionMetas(
      [
        active({ sessionId: 'aaaa0001-0000-0000-0000-000000000000', kind: 'claude' }),
        active({ sessionId: undefined }),                       // dropped: no id
        active({ sessionId: 'aaaa0002-0000-0000-0000-000000000000', kind: 'cloud' }), // dropped: not an agent
        active({ sessionId: 'aaaa0003-0000-0000-0000-000000000000', kind: 'codex' }),
      ],
      self,
      now,
    );
    expect(rows.map(r => r.id)).toEqual([
      'aaaa0001-0000-0000-0000-000000000000',
      'aaaa0003-0000-0000-0000-000000000000',
    ]);
  });
});
