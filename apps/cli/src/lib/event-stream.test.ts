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
    emit('secrets.get', { module: 'secrets', command: 'secrets get', item: 'prod' });
    appendActivityEvent(
      { ts: new Date(Date.now() + 1000).toISOString(), event: 'pr.opened', sessionId: 's1', mailboxId: 's1', host: 'zion', runtime: 'headless', agent: 'claude', detail: 'gh pr create', url: 'https://x/pull/1' },
      activityRoot,
    );

    const events = readUnifiedEvents({ activityRoot, limit: 50 });
    const kinds = events.map((e) => e.event);
    expect(kinds).toContain('secrets.get');
    expect(kinds).toContain('pr.opened');
    // Newest-first: the activity event is stamped 1s in the future.
    expect(events[0].event).toBe('pr.opened');
    // Timestamps are monotonically non-increasing.
    const ts = events.map((e) => Date.parse(e.ts));
    expect(ts).toEqual([...ts].sort((a, b) => b - a));
  });

  it('--audit (includeActivity:false) returns operational events only', () => {
    const { activityRoot } = setup();
    emit('secrets.get', { module: 'secrets', command: 'secrets get' });
    appendActivityEvent(
      { ts: new Date().toISOString(), event: 'pr.opened', sessionId: 's1', mailboxId: 's1', host: 'h', runtime: 'headless' },
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
      { ts: new Date().toISOString(), event: 'worktree.created', sessionId: 's1', mailboxId: 's1', host: 'h', runtime: 'headless' },
      activityRoot,
    );
    expect(readUnifiedEvents({ activityRoot, module: 'activity' }).map((e) => e.event)).toEqual(['worktree.created']);
    expect(readUnifiedEvents({ activityRoot, module: 'secrets' }).map((e) => e.event)).toEqual(['secrets.get']);
  });

  it('event-type and agent filters apply to activity records too', () => {
    const { activityRoot } = setup();
    for (const [event, agent] of [['pr.opened', 'claude'], ['commit.created', 'codex']] as const) {
      appendActivityEvent(
        { ts: new Date().toISOString(), event, sessionId: `s-${event}`, mailboxId: 's', host: 'h', runtime: 'headless', agent },
        activityRoot,
      );
    }
    expect(readUnifiedEvents({ activityRoot, eventTypes: ['pr.opened'] }).map((e) => e.event)).toEqual(['pr.opened']);
    expect(readUnifiedEvents({ activityRoot, agent: 'codex' }).map((e) => e.event)).toEqual(['commit.created']);
  });

  it('respects the limit across the merged stream', () => {
    const { activityRoot } = setup();
    emit('info', { module: 'test' });
    for (let i = 0; i < 5; i++) {
      appendActivityEvent(
        { ts: new Date(Date.now() + i * 1000).toISOString(), event: 'file.edited', sessionId: `s${i}`, mailboxId: 's', host: 'h', runtime: 'headless' },
        activityRoot,
      );
    }
    expect(readUnifiedEvents({ activityRoot, limit: 3 })).toHaveLength(3);
  });
});
