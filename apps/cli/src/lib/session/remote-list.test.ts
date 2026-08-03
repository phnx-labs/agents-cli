/**
 * Tests for parsing a peer's `sessions --json` output during the browse-listing
 * fan-out. Like the --active parser, this must be defensive: a peer may run an
 * older/newer agents whose stdout is truncated, non-JSON, or carries its own
 * `machine` tag — one bad peer must never throw and blank the merged list, and
 * the machine we dialed must win so grouping keys off the computer we asked.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { parseRemoteList, remoteListCaptureResult, remoteListCommand } from './remote-list.js';

function runPeer(source: string, ...args: string[]) {
  return spawnSync(process.execPath, ['--eval', source, ...args], { encoding: 'utf8' });
}

describe('parseRemoteList', () => {
  it('tags every parsed session with the source machine', () => {
    const stdout = JSON.stringify([
      { id: 'a', shortId: 'a', agent: 'claude', timestamp: '2026-07-01T00:00:00Z', filePath: '/r/a.jsonl' },
      { id: 'b', shortId: 'b', agent: 'codex', timestamp: '2026-07-02T00:00:00Z', filePath: '/r/b.jsonl' },
    ]);
    const out = parseRemoteList(stdout, 'zion');
    expect(out).toHaveLength(2);
    expect(out.every((s) => s.machine === 'zion')).toBe(true);
    expect(out[0].id).toBe('a');
  });

  it('marks every parsed row _remote so it routes read/resume back over SSH', () => {
    const stdout = JSON.stringify([
      { id: 'a', shortId: 'a', agent: 'claude', timestamp: '2026-07-01T00:00:00Z', filePath: '/peer/a.jsonl' },
    ]);
    const out = parseRemoteList(stdout, 'zion');
    expect(out[0]._remote).toBe(true);
  });

  it('overrides any machine tag the peer set on its own rows', () => {
    // The peer's discover tags rows with ITS local id; we must relabel to the
    // machine we dialed, else two peers that both call themselves "local" collide.
    const stdout = JSON.stringify([
      { id: 'a', shortId: 'a', agent: 'claude', timestamp: '2026-07-01T00:00:00Z', filePath: '/r/a.jsonl', machine: 'their-local-name' },
    ]);
    const out = parseRemoteList(stdout, 'mark');
    expect(out[0].machine).toBe('mark');
  });

  it('returns [] on non-JSON (a login-shell banner leaked into stdout)', () => {
    expect(parseRemoteList('bash: agents: command not found\n', 'zion')).toEqual([]);
  });

  it('returns [] when the top level is not an array', () => {
    expect(parseRemoteList(JSON.stringify({ error: 'nope' }), 'zion')).toEqual([]);
  });

  it('drops non-object entries but keeps the valid ones', () => {
    const stdout = JSON.stringify([null, 'weird', 42, { id: 'x', shortId: 'x', agent: 'claude', timestamp: '2026-07-01T00:00:00Z', filePath: '/r/x.jsonl' }]);
    const out = parseRemoteList(stdout, 'mark');
    expect(out).toHaveLength(1);
    expect(out[0].machine).toBe('mark');
  });

  it('returns [] on empty stdout (peer produced nothing)', () => {
    expect(parseRemoteList('', 'zion')).toEqual([]);
  });
});

describe('remoteListCaptureResult', () => {
  it('accepts real child output and tags the owning machine', () => {
    const peer = runPeer("process.stdout.write(JSON.stringify([{id:'abcd7777',shortId:'abcd7777',agent:'claude',timestamp:'2026-08-03T00:00:00Z'}]))");

    expect(remoteListCaptureResult(peer.status, peer.stdout, 'peer-one', 'Peer One', true)).toEqual({
      sessions: [{
        id: 'abcd7777', shortId: 'abcd7777', agent: 'claude',
        timestamp: '2026-08-03T00:00:00Z', machine: 'peer-one', _remote: true,
      }],
    });
  });

  it('marks an exit-0 structurally invalid resolver row incomplete', () => {
    expect(remoteListCaptureResult(0, '[{}]', 'peer', 'peer', true)).toEqual({
      sessions: [],
      unreachable: 'peer',
    });
  });

  it('rejects unsafe fields from a versioned resolver peer', () => {
    const unsafe = JSON.stringify([{
      id: 'abcd7777', shortId: 'abcd7777', agent: 'claude',
      timestamp: '2026-08-03T00:00:00Z', filePath: '/private/transcript.jsonl',
    }]);
    expect(remoteListCaptureResult(0, unsafe, 'peer', 'peer', true)).toEqual({
      sessions: [],
      unreachable: 'peer',
    });
  });

  it('accepts an exit-0 empty array as a complete peer response', () => {
    expect(remoteListCaptureResult(0, '[]', 'peer', 'peer')).toEqual({ sessions: [] });
  });

});

describe('remoteListCommand', () => {
  it('passes the recursion guard so the peer stays local and never re-fans-out', () => {
    const cmd = remoteListCommand(['sessions', 'auth bug', '--json']);
    expect(cmd).toContain('AGENTS_SESSIONS_LOCAL=1');
    expect(cmd).toContain('agents');
  });

  it('carries the caller query + filters over to the peer', () => {
    const cmd = remoteListCommand(['sessions', 'deploy', '--since', '2d', '--json']);
    expect(cmd).toContain('deploy');
    expect(cmd).toContain('--since');
    expect(cmd).toContain('--json');
  });
});
