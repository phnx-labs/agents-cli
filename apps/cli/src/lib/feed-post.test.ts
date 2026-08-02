import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildAttachment,
  buildAttachments,
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

describe('buildAttachment', () => {
  const ctx = { sessionId: 's', updateId: 'u' };

  it('classifies a remote URL as a link, media by extension', () => {
    const link = buildAttachment('https://x.dev/thread/1', ctx);
    expect(link).toEqual({ kind: 'link', href: 'https://x.dev/thread/1', name: '1' });
    const vid = buildAttachment('https://x.dev/preview.mp4', ctx);
    expect(vid?.kind).toBe('video');
    expect(vid?.mediaType).toBe('video/mp4');
  });

  it('classifies + copies a local file, and stat sizes it', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-attach-src-'));
    const copyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-attach-store-'));
    const wav = path.join(src, 'draft.wav');
    fs.writeFileSync(wav, 'RIFFxxxx');

    const att = buildAttachment(wav, { sessionId: 'sess-a', updateId: 'up-1', copyRoot });
    expect(att?.kind).toBe('audio');
    expect(att?.mediaType).toBe('audio/wav');
    expect(att?.name).toBe('draft.wav');
    expect(att?.bytes).toBe(8);
    // href points at the durable copy under <copyRoot>/<sessionId>/<updateId>/
    expect(att?.href).toBe(path.join(copyRoot, 'sess-a', 'up-1', 'draft.wav'));
    expect(fs.existsSync(att!.href)).toBe(true);
  });

  it('drops a missing local file / blank token (fail-open)', () => {
    expect(buildAttachment('/no/such/file.png', ctx)).toBeUndefined();
    expect(buildAttachment('   ', ctx)).toBeUndefined();
  });

  it('buildAttachments filters out the failures', () => {
    const list = buildAttachments(['https://a/b', '/no/such.png'], ctx);
    expect(list).toHaveLength(1);
    expect(list[0].href).toBe('https://a/b');
    expect(buildAttachments(undefined, ctx)).toEqual([]);
  });
});

describe('postFeedStatus attachments + project', () => {
  it('writes one line with both attachments and project, round-trips', () => {
    const dir = tmpActivityDir();
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-attach-store-'));
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-attach-src-'));
    const wav = path.join(src, 'take.wav');
    fs.writeFileSync(wav, 'RIFF');

    const { event } = postFeedStatus({
      text: 'listen',
      sessionId: 'sess-attach',
      activityRoot: dir,
      attachmentsRoot: store,
      attach: [wav, 'https://x/preview.mp4'],
      cwd: '/repo/song-factory',
      env: { AGENTS_AGENT_NAME: 'grok', AGENTS_SYNC_MACHINE_ID: 'yosemite-s1' },
      ts: '2026-07-31T12:00:00.000Z',
      listEntries: () => [],
      readEntry: () => undefined,
      startPid: 1,
    });

    expect(event.project).toBe('song-factory');
    expect(event.attachments).toHaveLength(2);
    expect(event.attachments?.[0].kind).toBe('audio');
    expect(event.attachments?.[1]).toMatchObject({ kind: 'video', href: 'https://x/preview.mp4' });

    // Parse round-trip preserves attachments + project.
    const stored = readSessionActivity('sess-attach', dir);
    expect(stored).toHaveLength(1);
    expect(stored[0].project).toBe('song-factory');
    expect(stored[0].attachments).toHaveLength(2);
    expect(stored[0].attachments?.[0].name).toBe('take.wav');
  });

  it('omits attachments when none given', () => {
    const dir = tmpActivityDir();
    const { event } = postFeedStatus({
      text: 'no attachments',
      sessionId: 'sess-noattach',
      activityRoot: dir,
      cwd: '/repo/foo',
      env: { AGENTS_AGENT_NAME: 'claude' },
      listEntries: () => [],
      readEntry: () => undefined,
      startPid: 1,
    });
    expect(event).not.toHaveProperty('attachments');
    expect(readSessionActivity('sess-noattach', dir)[0].attachments).toBeUndefined();
  });
});
