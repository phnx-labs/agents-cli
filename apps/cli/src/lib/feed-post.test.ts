import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  normalizeStatusText,
  postFeedStatus,
  resolvePostIdentity,
  walkPidRegistry,
  STATUS_POST_MAX_CHARS,
} from './feed-post.js';
import { readSessionActivity, tierForEvent } from './activity.js';
import type { PidSessionEntry } from './session/pid-registry.js';

function tmpActivityDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-post-'));
}

describe('normalizeStatusText', () => {
  it('collapses whitespace and rejects empty', () => {
    expect(normalizeStatusText('  hello   world  ')).toBe('hello world');
    expect(normalizeStatusText(' \n\t ')).toBe('');
  });

  it('caps length with an ellipsis', () => {
    const long = 'x'.repeat(STATUS_POST_MAX_CHARS + 50);
    const out = normalizeStatusText(long);
    expect(out.length).toBe(STATUS_POST_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('resolvePostIdentity', () => {
  it('prefers explicit session over env', () => {
    const id = resolvePostIdentity({
      sessionId: 'sess-explicit',
      env: {
        AGENT_SESSION_ID: 'sess-env',
        AGENTS_AGENT_NAME: 'claude',
        AGENTS_RUNTIME: 'teams',
        AGENTS_SYNC_MACHINE_ID: 'zion',
      },
    });
    expect(id?.sessionId).toBe('sess-explicit');
    expect(id?.agent).toBe('claude');
    expect(id?.runtime).toBe('teams');
    expect(id?.host).toBe('zion');
  });

  it('resolves session from AGENTS_MAILBOX_DIR basename', () => {
    const id = resolvePostIdentity({
      env: {
        AGENTS_MAILBOX_DIR: '/home/u/.agents/.history/mailbox/sess-from-box',
        AGENTS_AGENT_NAME: 'grok',
      },
    });
    expect(id?.sessionId).toBe('sess-from-box');
    expect(id?.mailboxId).toBe('sess-from-box');
    expect(id?.agent).toBe('grok');
  });

  it('matches AGENT_LAUNCH_ID in the pid registry', () => {
    const entries: PidSessionEntry[] = [
      {
        pid: 4242,
        agent: 'claude',
        sessionId: 'sess-launch',
        launchId: 'launch-abc',
        cwd: '/repo',
        tmuxPane: '%3',
        startedAtMs: 1,
      },
    ];
    const id = resolvePostIdentity({
      env: { AGENT_LAUNCH_ID: 'launch-abc' },
      listEntries: () => entries,
      readEntry: () => undefined,
      startPid: 1,
    });
    expect(id?.sessionId).toBe('sess-launch');
    expect(id?.pid).toBe(4242);
    expect(id?.launchId).toBe('launch-abc');
    expect(id?.tmuxPane).toBe('%3');
    expect(id?.cwd).toBe('/repo');
  });

  it('walks parent pids to find a registry entry', () => {
    const entries = new Map<number, PidSessionEntry>([
      [100, { pid: 100, agent: 'codex', sessionId: 'sess-parent', cwd: '/w', startedAtMs: 1 }],
    ]);
    const parents = new Map<number, number>([[200, 100], [100, 1]]);
    const id = resolvePostIdentity({
      env: {},
      startPid: 200,
      getParentPid: (p) => parents.get(p),
      readEntry: (p) => entries.get(p),
      listEntries: () => [],
    });
    expect(id?.sessionId).toBe('sess-parent');
    expect(id?.agent).toBe('codex');
    expect(id?.pid).toBe(100);
  });

  it('returns undefined when nothing resolves', () => {
    expect(resolvePostIdentity({
      env: {},
      startPid: 1,
      getParentPid: () => undefined,
      readEntry: () => undefined,
      listEntries: () => [],
    })).toBeUndefined();
  });
});

describe('walkPidRegistry', () => {
  it('returns the first ancestor with a sessionId', () => {
    const entries = new Map<number, PidSessionEntry>([
      [50, { pid: 50, agent: 'claude', startedAtMs: 1 }],
      [10, { pid: 10, agent: 'claude', sessionId: 's10', startedAtMs: 1 }],
    ]);
    const parents = new Map<number, number>([[90, 50], [50, 10], [10, 1]]);
    const hit = walkPidRegistry(90, (p) => parents.get(p), (p) => entries.get(p));
    expect(hit?.sessionId).toBe('s10');
  });
});

describe('postFeedStatus', () => {
  it('writes a status.posted milestone with auto identity', () => {
    const dir = tmpActivityDir();
    const { event } = postFeedStatus({
      text: '  Track complete  ',
      sessionId: 'sess-post-1',
      activityRoot: dir,
      env: {
        AGENTS_AGENT_NAME: 'grok',
        AGENTS_RUNTIME: 'teams',
        AGENTS_SYNC_MACHINE_ID: 'yosemite-s1',
        AGENTS_CWD: '/repo/foreman',
        AGENT_LAUNCH_ID: 'launch-1',
      },
      ts: '2026-07-31T12:00:00.000Z',
      listEntries: () => [],
      readEntry: () => undefined,
      startPid: 1,
    });

    expect(event.event).toBe('status.posted');
    expect(tierForEvent(event.event)).toBe('milestone');
    expect(event.detail).toBe('Track complete');
    expect(event.sessionId).toBe('sess-post-1');
    expect(event.agent).toBe('grok');
    expect(event.runtime).toBe('teams');
    expect(event.host).toBe('yosemite-s1');
    expect(event.cwd).toBe('/repo/foreman');
    expect(event.tool).toBe('feed.post');
    expect(event.launchId).toBe('launch-1');
    expect(event.tier).toBe('milestone');

    const stored = readSessionActivity('sess-post-1', dir);
    expect(stored).toHaveLength(1);
    expect(stored[0].event).toBe('status.posted');
    expect(stored[0].detail).toBe('Track complete');
    expect(stored[0].agent).toBe('grok');
    expect(stored[0].launchId).toBe('launch-1');
  });

  it('throws on empty text', () => {
    expect(() => postFeedStatus({
      text: '   ',
      sessionId: 's',
      activityRoot: tmpActivityDir(),
    })).toThrow(/empty/i);
  });

  it('throws when session cannot be resolved', () => {
    expect(() => postFeedStatus({
      text: 'hello',
      activityRoot: tmpActivityDir(),
      env: {},
      startPid: 1,
      getParentPid: () => undefined,
      readEntry: () => undefined,
      listEntries: () => [],
    })).toThrow(/No session id/i);
  });

  it('does not invent domain-specific meta fields', () => {
    const dir = tmpActivityDir();
    const { event } = postFeedStatus({
      text: 'done',
      sessionId: 'sess-no-meta',
      activityRoot: dir,
      env: { AGENTS_AGENT_NAME: 'claude' },
      listEntries: () => [],
      readEntry: () => undefined,
      startPid: 1,
    });
    expect(event).not.toHaveProperty('meta');
    expect(event).not.toHaveProperty('ticket');
    expect(event).not.toHaveProperty('url');
  });
});
