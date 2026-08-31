import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ActiveSession } from '../active.js';
import { sessionAgentSupportsResume } from '../recovery.js';
import type { SessionMeta } from '../types.js';
import {
  SessionWatchState,
  sessionWatchRowKey,
  toPreviousSessionWatchRow,
  watchLocalSessions,
  toSessionWatchRow,
} from './watch.js';

const row = (sessionId: string, status: ActiveSession['status'] = 'running'): ActiveSession => ({
  context: 'terminal', kind: 'codex', sessionId, status, cwd: '/repo', lastActivityMs: 10,
});

const indexed = (id: string, over: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  shortId: id.slice(0, 8),
  agent: 'codex',
  timestamp: '2026-08-30T20:00:00.000Z',
  lastActivity: '2026-08-30T20:02:00.000Z',
  filePath: `/sessions/${id}.jsonl`,
  cwd: '/repo',
  machine: 'zion',
  ...over,
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
    expect(r.previous).toBe(true);
  });

  it('projects the indexed first user message on the streamed row', () => {
    const r = toSessionWatchRow('zion', {
      context: 'terminal', kind: 'codex', sessionId: 'x', status: 'idle',
      firstUserMessage: 'Implement the full request\nwith all acceptance criteria.',
    });
    expect(r.firstUserMessage).toBe('Implement the full request\nwith all acceptance criteria.');
  });
});

describe('durable Previous rows on the canonical watch stream', () => {
  it('projects indexed history with the real request and recovery tuple', () => {
    const projected = toPreviousSessionWatchRow('zion', indexed('history-1', {
      firstUserMessage: 'Implement the full request\nwith every acceptance criterion.',
      topic: 'Implement the full request',
      gitBranch: 'agents/history',
      ticketId: 'PHNX-3621',
      prUrl: 'https://github.com/phnx-labs/agi-ext/pull/26',
      prNumber: 26,
    }));
    expect(projected).toMatchObject({
      context: 'recent', sessionId: 'history-1', previous: true, status: 'closed',
      sourceDevice: 'zion', resumable: true, viewingIn: null,
      firstUserMessage: 'Implement the full request\nwith every acceptance criterion.',
      branch: 'agents/history',
      ticket: { id: 'PHNX-3621' },
      pr: { url: 'https://github.com/phnx-labs/agi-ext/pull/26', number: 26 },
      recovery: { command: 'agents', args: ['sessions', 'resume', 'history-1', '--device', 'zion'], cwd: '/repo' },
    });
    expect(projected.lastActivityMs - projected.startedAtMs!).toBe(120_000);
  });

  it('uses the same faithful-resume harness boundary as session recovery', () => {
    expect(sessionAgentSupportsResume('codex')).toBe(true);
    expect(sessionAgentSupportsResume('kimi')).toBe(false);
    expect(toPreviousSessionWatchRow('zion', indexed('kimi', { agent: 'kimi' })).recovery).toBeNull();
  });
});

describe('session watch protocol', () => {
  it('emits a versioned reset followed by stable-key deltas with monotonic sequence numbers', () => {
    const state = new SessionWatchState('stream-1');
    const reset = state.reset('zion', [row('a'), row('b')]);
    expect(reset).toMatchObject({ version: 1, type: 'reset', streamId: 'stream-1', sequence: 1, scope: 'zion' });
    const events = state.update('zion', [row('a', 'idle'), row('c')]);
    expect(events.map((event) => [event.type, event.sequence])).toEqual([
      ['upsert', 2], ['upsert', 3], ['remove', 4], ['upsert', 5],
    ]);
    expect(sessionWatchRowKey('zion', row('a'))).toBe(sessionWatchRowKey('zion', row('a')));
  });

  it('keeps indexed Previous rows distinct from live rows and demotes new removals', () => {
    const state = new SessionWatchState('stream-history');
    const reset = state.reset('zion', [row('same'), row('new')], [indexed('same'), indexed('old')]);
    expect(reset.type).toBe('reset');
    if (reset.type !== 'reset') throw new Error('expected reset');
    expect(reset.rows.filter((candidate) => candidate.sessionId === 'same')).toHaveLength(2);
    expect(reset.rows.find((candidate) => candidate.sessionId === 'old')?.previous).toBe(true);

    const events = state.update('zion', [row('same')]);
    expect(events.map((event) => event.type)).toEqual(['remove', 'upsert']);
    const demoted = events.find((event) => event.type === 'upsert');
    expect(demoted && demoted.type === 'upsert' ? demoted.row : null).toMatchObject({
      sessionId: 'new', previous: true, status: 'closed',
    });
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
      readPrevious: () => [],
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
      readPrevious: () => [],
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

  it('performs one bounded history read and includes it in the startup reset', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-watch-history-'));
    const journalPath = path.join(dir, 'active.jsonl');
    const controller = new AbortController();
    let historyReads = 0;
    let resetRows: ReturnType<typeof toSessionWatchRow>[] = [];
    const watching = watchLocalSessions({
      scope: 'zion', signal: controller.signal, journalPath, heartbeatMs: 1_000,
      readCache: () => ({ version: 1, scope: 'local', capturedAt: 1, sessions: [row('live')] }),
      readPrevious: () => {
        historyReads++;
        return [indexed('history')];
      },
      emit: (event) => {
        if (event.type !== 'reset') return;
        resetRows = event.rows;
        controller.abort();
      },
    });
    await watching;
    expect(historyReads).toBe(1);
    expect(resetRows.map((candidate) => [candidate.sessionId, candidate.previous])).toEqual([
      ['live', false],
      ['history', true],
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
