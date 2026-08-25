import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ActiveSession } from '../active.js';
import { SessionWatchState, sessionWatchRowKey, watchLocalSessions, toSessionWatchRow } from './watch.js';

const row = (sessionId: string, status: ActiveSession['status'] = 'running'): ActiveSession => ({
  context: 'terminal', kind: 'codex', sessionId, status, cwd: '/repo', lastActivityMs: 10,
});

describe('toSessionWatchRow resumable gating (reap dead crash-orphans)', () => {
  it('marks a dead, days-stale orphan non-resumable with no recovery command', () => {
    const r = toSessionWatchRow('zion', { context: 'terminal', kind: 'codex', sessionId: 'x', status: 'abandoned', pidAlive: false, cwd: '/repo' });
    expect(r.resumable).toBe(false);
    expect(r.recovery).toBeNull();
  });

  it('keeps a live/idle-unfinished session resumable', () => {
    const r = toSessionWatchRow('zion', { context: 'terminal', kind: 'codex', sessionId: 'x', status: 'idle', pidAlive: true, cwd: '/repo' });
    expect(r.resumable).toBe(true);
    expect(r.recovery).toMatchObject({ command: 'agents', args: ['sessions', 'resume', 'x', '--device', 'zion'] });
  });

  it('keeps a recently-closed session resumable (not yet stale)', () => {
    const r = toSessionWatchRow('zion', { context: 'terminal', kind: 'codex', sessionId: 'x', status: 'closed', pidAlive: false, cwd: '/repo' });
    expect(r.resumable).toBe(true);
  });
});

describe('session watch protocol', () => {
  it('emits a versioned reset followed by stable-key deltas with monotonic sequence numbers', () => {
    const state = new SessionWatchState('stream-1');
    const reset = state.reset('zion', [row('a'), row('b')]);
    expect(reset).toMatchObject({ version: 1, type: 'reset', streamId: 'stream-1', sequence: 1, scope: 'zion' });
    const events = state.update('zion', [row('a', 'idle'), row('c')]);
    expect(events.map((event) => [event.type, event.sequence])).toEqual([['upsert', 2], ['upsert', 3], ['remove', 4]]);
    expect(sessionWatchRowKey('zion', row('a'))).toBe(sessionWatchRowKey('zion', row('a')));
  });

  it('marks a scope unavailable without removing its retained rows', () => {
    const state = new SessionWatchState('stream-2');
    state.reset('box', [row('retained', 'crashed')]);
    expect(state.scope('box', 'unavailable', 'ssh closed')).toMatchObject({ type: 'scope', status: 'unavailable', sequence: 2 });
    expect(state.update('box', [row('retained', 'crashed')])).toEqual([]);
  });

  it('reads one reset then consumes multiple writer ticks with zero repeated gathers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-watch-'));
    const journalPath = path.join(dir, 'active.jsonl');
    const controller = new AbortController();
    let snapshotReads = 0;
    const events: Array<{ type: string }> = [];
    const watching = watchLocalSessions({
      scope: 'local', signal: controller.signal, journalPath, journalPollMs: 5, heartbeatMs: 1_000,
      readCache: () => {
        snapshotReads++;
        return { version: 1, scope: 'local', capturedAt: 1, sessions: [row('a')] };
      },
      emit: (event) => {
        events.push(event);
        if (events.filter((candidate) => candidate.type === 'upsert').length === 2) controller.abort();
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.appendFileSync(journalPath, `${JSON.stringify({ version: 1, scope: 'local', capturedAt: 2, upserts: [row('a', 'idle')], removes: [] })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.appendFileSync(journalPath, `${JSON.stringify({ version: 1, scope: 'local', capturedAt: 3, upserts: [row('a', 'running'), row('b')], removes: [] })}\n`);
    await watching;
    expect(snapshotReads).toBe(1);
    expect(events.filter((event) => event.type === 'upsert')).toHaveLength(3);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('consumes a first publication written during the startup handoff', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-watch-handoff-'));
    const journalPath = path.join(dir, 'active.jsonl');
    const controller = new AbortController();
    const statuses: string[] = [];
    const watching = watchLocalSessions({
      scope: 'local', signal: controller.signal, journalPath, journalPollMs: 5,
      readCache: () => {
        fs.appendFileSync(journalPath, `${JSON.stringify({
          version: 1, scope: 'local', capturedAt: 2, upserts: [], removes: [],
        })}\n`);
        return undefined;
      },
      emit: (event) => {
        if (event.type === 'scope') {
          statuses.push(event.status);
          if (event.status === 'available') controller.abort();
        }
      },
    });
    await watching;
    expect(statuses).toEqual(['unavailable', 'available']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
