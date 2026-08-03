/**
 * Tests for parsing a peer's `sessions --json` output during the browse-listing
 * fan-out. Like the --active parser, this must be defensive: a peer may run an
 * older/newer agents whose stdout is truncated, non-JSON, or carries its own
 * `machine` tag — one bad peer must never throw and blank the merged list, and
 * the machine we dialed must win so grouping keys off the computer we asked.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import {
  REMOTE_STDOUT_MAX_BYTES,
  REMOTE_TOOL_AGGREGATE_MAX_BYTES,
  consumeParsedRemoteToolSearchBudget,
  consumeRemoteToolByteBudget,
  parseRemoteList,
  parseRemoteToolSearch,
  RemoteUtf8Accumulator,
  remoteListCaptureResult,
  remoteListCommand,
} from './remote-list.js';
import { TOOL_QUERY_MAX_CALL_ROWS } from './tool-index.js';

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

describe('parseRemoteToolSearch', () => {
  it('preserves a multibyte code point split across SSH stdout chunks', () => {
    const bytes = Buffer.from('before 界 after', 'utf8');
    const split = bytes.indexOf(Buffer.from('界')) + 1;
    const decoded = new RemoteUtf8Accumulator();
    decoded.write(bytes.subarray(0, split));
    decoded.write(bytes.subarray(split));
    expect(decoded.end()).toBe('before 界 after');
  });

  it('accepts only the versioned envelope and stamps the peer machine', () => {
    const credential = 'opaque-session-credential-123456';
    const payload = JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-08-03T00:00:00Z',
      query: { clauses: ['program:git'] },
      coverage: { indexedFiles: 0, indexedCalls: 0, skippedFiles: 0, limitedFiles: 0, remainingFiles: 0, complete: true },
      sessions: [{
        id: 'one', shortId: 'one', agent: 'codex', timestamp: '2026-08-03T00:00:00Z',
        filePath: '/peer/one.jsonl', calls: [{
          id: 'call', ordinal: 0, timestamp: '2026-08-03T00:00:01Z', tool: 'exec_command',
          programs: ['git'], input: `git status\u001b]52;c;payload\u0007 -H "Cookie: sid=${credential}" --proxy-user=user:${credential}`, outcome: 'unknown',
        }],
      }],
    });
    const parsed = parseRemoteToolSearch(payload, 'mac-mini');
    expect(parsed?.sessions[0].machine).toBe('mac-mini');
    expect(parsed?.sessions[0].filePath).toBeUndefined();
    expect(parsed?.sessions[0].calls[0].input).toContain('git status');
    expect(parsed?.sessions[0].calls[0].input).not.toContain(credential);
    expect(parsed?.sessions[0].calls[0].input).not.toContain('\u001b');
    expect(parseRemoteToolSearch('[]', 'mac-mini')).toBeUndefined();
    expect(parseRemoteToolSearch('{broken', 'mac-mini')).toBeUndefined();
    expect(parseRemoteToolSearch(payload, 'mac-mini', ['program:gh'])).toBeUndefined();
    expect(parseRemoteToolSearch(payload, 'mac-mini', ['program:git'])?.sessions).toHaveLength(1);
  });

  it('rejects oversized or structurally invalid peer evidence before merging', () => {
    expect(parseRemoteToolSearch('x'.repeat(REMOTE_STDOUT_MAX_BYTES + 1), 'peer')).toBeUndefined();
    expect(parseRemoteToolSearch(JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-08-03T00:00:00Z',
      query: { clauses: [] },
      coverage: { indexedFiles: 0, indexedCalls: 0, skippedFiles: 0, limitedFiles: 0, remainingFiles: 0, complete: true },
      sessions: [{ id: 'one', shortId: 'one', agent: 'codex', timestamp: '2026-08-03T00:00:00Z', calls: [{}] }],
    }), 'peer')).toBeUndefined();

    const envelope = {
      schemaVersion: 1,
      generatedAt: '2026-08-03T00:00:00Z',
      query: { clauses: [] },
      coverage: { indexedFiles: 0, indexedCalls: 0, skippedFiles: 0, limitedFiles: 0, remainingFiles: 0, complete: true },
      sessions: [{
        id: 'one', shortId: 'one', agent: 'codex', timestamp: '2026-08-03T00:00:00Z',
        calls: Array.from({ length: TOOL_QUERY_MAX_CALL_ROWS + 1 }, () => ({})),
      }],
    };
    expect(parseRemoteToolSearch(JSON.stringify(envelope), 'peer')).toBeUndefined();

    const half = Math.ceil(TOOL_QUERY_MAX_CALL_ROWS / 2);
    envelope.sessions = ['one', 'two'].map((id) => ({
      id, shortId: id, agent: 'codex', timestamp: '2026-08-03T00:00:00Z',
      calls: Array.from({ length: half }, () => ({})),
    }));
    expect(parseRemoteToolSearch(JSON.stringify(envelope), 'peer')).toBeUndefined();

    envelope.sessions = [{
      id: 'one', shortId: 'one', agent: 'codex', timestamp: '2026-08-03T00:00:00Z', calls: [],
    }];
    envelope.sessions[0].calls = [{
      id: 'call', ordinal: 0, timestamp: '2026-08-03T00:00:01Z', tool: 'exec_command',
      programs: Array.from({ length: 129 }, () => 'git'), input: 'git status', outcome: 'unknown',
    }];
    expect(parseRemoteToolSearch(JSON.stringify(envelope), 'peer')).toBeUndefined();
  });
});

describe('fleet tool-result byte budget', () => {
  it('stops retaining peer bytes at the global fleet-query ceiling', () => {
    const budget = { remainingBytes: REMOTE_TOOL_AGGREGATE_MAX_BYTES, exhausted: false };
    expect(consumeRemoteToolByteBudget(budget, REMOTE_TOOL_AGGREGATE_MAX_BYTES - 1)).toBe(true);
    expect(consumeRemoteToolByteBudget(budget, 2)).toBe(false);
    expect(budget).toEqual({ remainingBytes: 0, exhausted: true });
  });

  it('charges the sanitized envelope so redaction expansion cannot overflow the merge', () => {
    const raw = JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-08-03T00:00:00Z',
        query: { clauses: [] },
        coverage: { indexedFiles: 1, indexedCalls: 1, skippedFiles: 0, limitedFiles: 0, remainingFiles: 0, complete: true },
        sessions: [{
          id: 'one', shortId: 'one', agent: 'codex', timestamp: '2026-08-03T00:00:00Z',
          calls: [{
            id: 'one:0', ordinal: 0, timestamp: '2026-08-03T00:00:00Z',
            tool: 'exec_command', programs: ['printf'], input: 'printf TOKEN=abcdef', outcome: 'unknown',
          }],
        }],
      }, null, 2) + '\n';
    const parsed = parseRemoteToolSearch(raw, 'peer');
    expect(parsed?.sessions[0].calls[0].input).toContain('TOKEN=[REDACTED]');
    const budget = { remainingBytes: Buffer.byteLength(raw), exhausted: false };
    expect(consumeParsedRemoteToolSearchBudget(budget, parsed!)).toBe(false);
    expect(budget.exhausted).toBe(true);
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
