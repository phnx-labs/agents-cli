import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { emit, _resetForTest } from './events.js';
import { appendActivityEvent } from './activity.js';
import { readUnifiedEvents } from './event-stream.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-eventstream-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }
  tempDirs.length = 0;
  _resetForTest();
});

/** Point events.ts at a temp global log and return {eventsPath, activityRoot}. */
function setup(): { activityRoot: string } {
  const dir = makeTempDir();
  _resetForTest(path.join(dir, 'events.jsonl'));
  const activityRoot = path.join(dir, 'activity');
  fs.mkdirSync(activityRoot, { recursive: true });
  return { activityRoot };
}

describe('readUnifiedEvents', () => {
  it('merges operational and agent-semantic events into one newest-first stream', () => {
    const { activityRoot } = setup();
    // Activity event 5s in the past; the ops event is stamped ~now by emit().
    appendActivityEvent(
      { ts: new Date(Date.now() - 5000).toISOString(), event: 'pr.opened', sessionId: 's1', mailboxId: 's1', host: 'zion', runtime: 'headless', agent: 'claude', detail: 'gh pr create', url: 'https://x/pull/1' },
      activityRoot,
    );
    emit('secrets.get', { module: 'secrets', command: 'secrets get', item: 'prod' });

    const events = readUnifiedEvents({ activityRoot, limit: 50 });
    const kinds = events.map((e) => e.event);
    expect(kinds).toContain('secrets.get');
    expect(kinds).toContain('pr.opened');
    // Newest-first: the just-emitted ops event leads the older activity event.
    expect(events[0].event).toBe('secrets.get');
    // Timestamps are monotonically non-increasing.
    const ts = events.map((e) => Date.parse(e.ts));
    expect(ts).toEqual([...ts].sort((a, b) => b - a));
  });

  it('filters secrets events by bundle (the ops audit path)', () => {
    setup();
    // secrets.get is an operational event; it carries `bundle` in its payload.
    emit('secrets.get', { module: 'secrets', command: 'secrets get', bundle: 'share' });
    emit('secrets.get', { module: 'secrets', command: 'secrets get', bundle: 'prod' });
    const share = readUnifiedEvents({ bundle: 'share', includeActivity: false, limit: 50 });
    expect(share.length).toBe(1);
    expect(share[0].bundle).toBe('share');
    expect(share.some((r) => r.bundle === 'prod')).toBe(false);
  });

  it('filters secrets events by sessionId + bundle — trace which session read a bundle', () => {
    setup();
    emit('secrets.get', { module: 'secrets', command: 'secrets get', bundle: 'share', sessionId: 'sess-A' });
    emit('secrets.get', { module: 'secrets', command: 'secrets get', bundle: 'share', sessionId: 'sess-B' });
    const onlyA = readUnifiedEvents({ sessionId: 'sess-A', bundle: 'share', includeActivity: false, limit: 50 });
    expect(onlyA.length).toBe(1);
    expect(onlyA[0].sessionId).toBe('sess-A');
  });

  it('--audit (includeActivity:false) returns operational events only', () => {
    const { activityRoot } = setup();
    emit('secrets.get', { module: 'secrets', command: 'secrets get' });
    appendActivityEvent(
      { ts: new Date(Date.now() - 1000).toISOString(), event: 'pr.opened', sessionId: 's1', mailboxId: 's1', host: 'h', runtime: 'headless' },
      activityRoot,
    );
    const events = readUnifiedEvents({ activityRoot, includeActivity: false });
    expect(events.map((e) => e.event)).toContain('secrets.get');
    expect(events.map((e) => e.event)).not.toContain('pr.opened');
  });

  it('module filter partitions the two: --module activity vs --module secrets', () => {
    const { activityRoot } = setup();
    emit('secrets.get', { module: 'secrets', command: 'secrets get' });
    appendActivityEvent(
      { ts: new Date(Date.now() - 1000).toISOString(), event: 'worktree.created', sessionId: 's1', mailboxId: 's1', host: 'h', runtime: 'headless' },
      activityRoot,
    );
    expect(readUnifiedEvents({ activityRoot, module: 'activity' }).map((e) => e.event)).toEqual(['worktree.created']);
    expect(readUnifiedEvents({ activityRoot, module: 'secrets' }).map((e) => e.event)).toEqual(['secrets.get']);
  });

  it('event-type and agent filters apply to activity records too', () => {
    const { activityRoot } = setup();
    for (const [event, agent] of [['pr.opened', 'claude'], ['commit.created', 'codex']] as const) {
      appendActivityEvent(
        { ts: new Date(Date.now() - 1000).toISOString(), event, sessionId: `s-${event}`, mailboxId: 's', host: 'h', runtime: 'headless', agent },
        activityRoot,
      );
    }
    expect(readUnifiedEvents({ activityRoot, eventTypes: ['pr.opened'] }).map((e) => e.event)).toEqual(['pr.opened']);
    expect(readUnifiedEvents({ activityRoot, agent: 'codex' }).map((e) => e.event)).toEqual(['commit.created']);
  });

  it('sessionId filters BOTH the operational and activity halves — the scoped read enrichCachedSessionMeta relies on', () => {
    // browser.navigate/computer.action land in the operational log via emit();
    // this filter is what lets db.ts read "did session X touch browser/computer"
    // without re-scanning that session's whole transcript.
    const { activityRoot } = setup();
    emit('browser.navigate', { sessionId: 's-target', profile: 'default', url: 'https://x' });
    emit('browser.navigate', { sessionId: 's-other', profile: 'default', url: 'https://y' });
    appendActivityEvent(
      { ts: new Date(Date.now() - 1000).toISOString(), event: 'pr.opened', sessionId: 's-target', mailboxId: 's-target', host: 'h', runtime: 'headless' },
      activityRoot,
    );
    appendActivityEvent(
      { ts: new Date(Date.now() - 1000).toISOString(), event: 'commit.created', sessionId: 's-other', mailboxId: 's-other', host: 'h', runtime: 'headless' },
      activityRoot,
    );

    const events = readUnifiedEvents({ activityRoot, sessionId: 's-target' });
    expect(events.every((e) => e.sessionId === 's-target')).toBe(true);
    expect(events.map((e) => e.event).sort()).toEqual(['browser.navigate', 'pr.opened']);
  });

  it('respects the limit across the merged stream', () => {
    const { activityRoot } = setup();
    emit('info', { module: 'test' });
    for (let i = 0; i < 5; i++) {
      appendActivityEvent(
        { ts: new Date(Date.now() - i * 1000).toISOString(), event: 'file.edited', sessionId: `s${i}`, mailboxId: 's', host: 'h', runtime: 'headless' },
        activityRoot,
      );
    }
    expect(readUnifiedEvents({ activityRoot, limit: 3 })).toHaveLength(3);
  });

  it('carries checklist activity events into the unified stream', () => {
    const { activityRoot } = setup();
    appendActivityEvent(
      { ts: new Date(Date.now() - 1000).toISOString(), event: 'task.completed', sessionId: 's-check', mailboxId: 's-check', host: 'h', runtime: 'headless', agent: 'claude', detail: 'Write tests 2/3 done' },
      activityRoot,
    );
    appendActivityEvent(
      { ts: new Date(Date.now() - 2000).toISOString(), event: 'checklist.created', sessionId: 's-check', mailboxId: 's-check', host: 'h', runtime: 'headless', agent: 'claude', detail: '3 tasks' },
      activityRoot,
    );
    const events = readUnifiedEvents({ activityRoot, eventTypes: ['task.completed', 'checklist.created'] });
    expect(events.map((e) => e.event)).toEqual(['task.completed', 'checklist.created']);
    expect(events[0].detail).toBe('Write tests 2/3 done');
    expect(events[0].module).toBe('activity');
  });
});
