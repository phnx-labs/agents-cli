import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDB, readSessionTopics } from '../session/db.js';
import { getRuntimeStateDir } from '../state.js';
import type { ClassifiedTopic } from './classify.js';
import { buildIndexShard, syncTraces, type SyncRow } from './sync.js';

const id = 'trace-rich-fixture';
const transcript = path.join(import.meta.dirname, '../session/testdata/codex-fixture.jsonl');

function row(mtime: number, size: number): SyncRow {
  return {
    id, short_id: 'trace-ri', agent: 'codex', origin: 'cli', routine_name: null,
    routine_run_id: null, version: null, account: null, account_key: null,
    account_org: null, mode: 'auto', timestamp: '2026-08-25T00:00:00.000Z',
    last_activity: null, project: 'agents-cli', cwd: '/redacted/agents-cli',
    git_branch: 'feat/trace-sync', topic: null, label: 'Fix trace sync',
    message_count: null, token_count: null, output_tokens: null, input_tokens: null,
    cache_read_tokens: null, cache_write_tokens: null, cost_usd: null,
    cost_usd_nocache: null, duration_ms: 9000, model: 'gpt-test',
    tool_call_count: 3, file_path: transcript, file_mtime_ms: mtime,
    file_size: size, machine: 'test-device',
  };
}

describe('rich traces index shard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T00:00:00.000Z'));
    const db = getDB();
    db.prepare('DELETE FROM tool_calls WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM session_topics WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM session_insights WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('matches the committed console fixture, self-heals topics, and preserves the ledger', async () => {
    const stat = fs.statSync(transcript);
    const first = row(stat.mtimeMs, stat.size);
    const db = getDB();
    db.prepare(`
      INSERT INTO sessions
        (id, short_id, agent, timestamp, project, cwd, git_branch, label, duration_ms,
         model, file_path, file_mtime_ms, file_size, machine)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      first.id, first.short_id, first.agent, first.timestamp, first.project, first.cwd,
      first.git_branch, first.label, first.duration_ms, first.model, first.file_path,
      first.file_mtime_ms, first.file_size, first.machine,
    );
    const insertCall = db.prepare(`
      INSERT INTO tool_calls
        (call_key, session_id, ordinal, timestamp, tool, input, outcome, exit_code,
         error, evidence_bytes)
      VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, 0)
    `);
    insertCall.run('trace-call-1', id, 1, first.timestamp, 'exec_command', 'error', 1, 'command failed');
    insertCall.run('trace-call-2', id, 2, first.timestamp, 'exec_command', 'error', 1, 'git-guard blocked');
    insertCall.run('trace-call-3', id, 3, first.timestamp, 'Read', 'ok', null, null);
    db.prepare(`
      INSERT INTO session_insights
        (session_id, file_mtime_ms, file_size, extractor_version, computed_at, facets)
      VALUES (?, ?, ?, 6, ?, ?)
    `).run(
      id,
      first.file_mtime_ms,
      first.file_size,
      Date.now(),
      JSON.stringify({ frictionSignals: { 'failed tool loop: exec_command': 1 }, correctionSignals: {} }),
    );

    const shard = buildIndexShard([first], 'test-device', 'owner-1');
    const expected = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'testdata/rich-index.json'), 'utf8'));
    expect(shard).toEqual(expected);

    expect(readSessionTopics<ClassifiedTopic>([id]).get(id)?.key).toBe('engineering');
    db.prepare('UPDATE sessions SET file_size = file_size + 1 WHERE id = ?').run(id);
    expect(readSessionTopics<ClassifiedTopic>([id]).has(id)).toBe(false);
    buildIndexShard([{ ...first, file_size: first.file_size! + 1 }], 'test-device', 'owner-1');
    expect(readSessionTopics<ClassifiedTopic>([id]).get(id)?.key).toBe('engineering');
    db.prepare('UPDATE sessions SET file_mtime_ms = file_mtime_ms + 1 WHERE id = ?').run(id);
    expect(readSessionTopics<ClassifiedTopic>([id]).has(id)).toBe(false);
    buildIndexShard([{
      ...first,
      file_mtime_ms: first.file_mtime_ms! + 1,
      file_size: first.file_size! + 1,
    }], 'test-device', 'owner-1');
    expect(readSessionTopics<ClassifiedTopic>([id]).get(id)?.key).toBe('engineering');
    db.prepare(`
      UPDATE session_insights
      SET file_mtime_ms = ?, file_size = ?,
          facets = '{"frictionSignals":{"failed tool loop: exec_command":1},"correctionSignals":{}}'
      WHERE session_id = ?
    `).run(first.file_mtime_ms! + 1, first.file_size! + 1, id);
    process.env.AGENTS_TRACE_FIXTURE_SECRET = 'phoenix-secret-value';
    try {
      const redacted = buildIndexShard([{
        ...first,
        label: 'Fix phoenix-secret-value',
        file_mtime_ms: first.file_mtime_ms! + 1,
        file_size: first.file_size! + 1,
      }], 'test-device', 'owner-1');
      expect(redacted.needsAttention[0].title).not.toContain('phoenix-secret-value');
    } finally {
      delete process.env.AGENTS_TRACE_FIXTURE_SECRET;
    }

    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url ?? '');
      req.resume();
      res.writeHead(200).end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server has no TCP address');
    process.env.AGENTS_TRACES_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.AGENTS_TRACES_WRITE_TOKEN = 'test-token';
    process.env.AGENTS_SYNC_MACHINE_ID = 'test-device';
    fs.rmSync(path.join(getRuntimeStateDir(), 'traces-sync.json'), { force: true });
    try {
      expect(await syncTraces()).toMatchObject({ uploaded: 1, errors: 0 });
      expect(await syncTraces()).toMatchObject({ uploaded: 0, errors: 0 });
    } finally {
      delete process.env.AGENTS_TRACES_BASE_URL;
      delete process.env.AGENTS_TRACES_WRITE_TOKEN;
      delete process.env.AGENTS_SYNC_MACHINE_ID;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    expect(requests.filter((url) => url.includes(`/sessions/${id}.json`))).toHaveLength(1);
  });
});
