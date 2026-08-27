import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDB, readSessionTopics, INSIGHTS_EXTRACTOR_VERSION } from '../session/db.js';
import { getRuntimeStateDir } from '../state.js';
import type { ClassifiedTopic } from './classify.js';
import { buildIndexShard, buildSessionDetail, readSyncLedger, syncTraces, type SyncRow } from './sync.js';

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
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      first.file_mtime_ms,
      first.file_size,
      // Seed at the current extractor version so this cache row is read, not treated
      // as stale — otherwise a version bump silently drops these facets from the shard.
      INSIGHTS_EXTRACTOR_VERSION,
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

    // Seed the test server with 7 days of low-error history so the live GET path
    // produces a non-empty driftSignals when today's 2/3-error session lands.
    const seededShard = JSON.stringify({
      schema: 1, device: 'test-device', syncedAt: 0, owner: 'owner-1',
      stats: { sessionsImported: 1, medianMs: 0, p90Ms: 0, needAttention: 0, toolErrorRate: 0.1 },
      needsAttention: [],
      topics: [{ key: 'engineering', label: 'Engineering', count: 10, group: 'code' }],
      failures: { byToolError: [], byCause: { real: 0, guard: 0, hook: 0 } },
      bucketHistory: Array.from({ length: 7 }, (_, i) => [
        { key: 'engineering', date: `2026-08-${String(i + 18).padStart(2, '0')}`, count: 10, errorRate: 0.1, stallRate: 0 },
      ]),
      driftSignals: [],
    });
    const requests: string[] = [];
    const reqLog: string[] = [];
    const indexPutBodies: string[] = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url ?? '');
      reqLog.push(`${req.method} ${req.url ?? ''}`);
      if (req.method === 'GET' && req.url?.endsWith('/index.json')) {
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' }).end(seededShard);
      } else if (req.method === 'PUT' && req.url?.endsWith('/index.json')) {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => { indexPutBodies.push(Buffer.concat(chunks).toString()); res.writeHead(200).end('ok'); });
      } else {
        req.resume();
        res.writeHead(200).end('ok');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server has no TCP address');
    process.env.AGENTS_TRACES_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.AGENTS_TRACES_WRITE_TOKEN = 'test-token';
    process.env.AGENTS_SYNC_MACHINE_ID = 'test-device';
    fs.rmSync(path.join(getRuntimeStateDir(), 'traces-sync.json'), { force: true });
    // The BYO write token bypasses Phoenix auth (backend.userId === 'byo') and must
    // never be sent to the Prix link endpoint. Pass real calls through to the local
    // test server; only intercept to prove no request ever targets prix.dev.
    const realFetch = globalThis.fetch;
    const outboundUrls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      outboundUrls.push(typeof input === 'string' ? input : input.toString());
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      expect(await syncTraces()).toMatchObject({ uploaded: 1, errors: 0 });
      expect(await syncTraces()).toMatchObject({ uploaded: 0, errors: 0 });
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.AGENTS_TRACES_BASE_URL;
      delete process.env.AGENTS_TRACES_WRITE_TOKEN;
      delete process.env.AGENTS_SYNC_MACHINE_ID;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    expect(outboundUrls.some((u) => u.includes('api.prix.dev'))).toBe(false);
    expect(requests.filter((url) => url.includes(`/sessions/${id}.json`))).toHaveLength(1);
    // Verify the GET was issued for the prior shard on each live-sync run.
    expect(reqLog.filter((r) => r.startsWith('GET') && r.includes('/index.json'))).toHaveLength(2);
    // Verify driftSignals is non-empty: today's 2/3-error bucket (errorRate≈0.667)
    // vs the seeded 7-day baseline (errorRate=0.1) → delta≈0.567 → degrading.
    const indexBody = JSON.parse(indexPutBodies[0]);
    expect(indexBody.driftSignals).toHaveLength(1);
    expect(indexBody.driftSignals[0].bucket).toBe('engineering');
    expect(indexBody.driftSignals[0].severity).toBe('degrading');
  });
});

describe('buildSessionDetail (per-session drill-down shape)', () => {
  const baseTraj = {
    session: { id: 's1', agent: 'claude', model: 'opus-4-8', cwd: '/home/x/repo', costUsd: 1.5 },
    spanMs: 60_000,
    steps: [
      { ordinal: 1, lane: 'Bash', tool: 'Bash', startMs: 0, durationMs: 100, outcome: 'error', label: 'git rebase' },
      { ordinal: 2, lane: 'Read', tool: 'Read', startMs: 200, durationMs: 50, outcome: 'ok', label: 'read file' },
    ],
    gaps: [{ startMs: 300, durationMs: 130_000, afterOrdinal: 2 }],
    programTimeShare: {},
    errorCount: 1,
    redacted: true,
    stats: { userTurns: 3, assistantTurns: 4, toolCount: 2, outputTokens: 1000 },
    truncatedSteps: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  it('emits the console meta summary from real trajectory fields', () => {
    const d = buildSessionDetail(baseTraj);
    expect(d.schema).toBe(1);
    expect(d.id).toBe('s1');
    expect(d.meta.spanMs).toBe(60_000);
    expect(d.meta.turns).toBe(7); // userTurns + assistantTurns
    expect(d.meta.tools).toBe(2);
    expect(d.meta.errorCount).toBe(1);
    expect(d.meta.tokens).toBe(1000);
    expect(d.meta.costUsd).toBe(1.5);
    expect(d.meta.outcome).toBe('errored');
    expect(d.meta.repo).toBe('repo'); // cwd basename, not the full path (PII)
    expect(d.meta.agent).toBe('claude');
    expect(d.steps).toHaveLength(2);
  });

  it('synthesizes a whereItWentWrong narrative from error steps + stalls', () => {
    const d = buildSessionDetail(baseTraj);
    expect(d.whereItWentWrong).toContain('1 tool error');
    expect(d.whereItWentWrong).toContain('Bash');
    expect(d.whereItWentWrong).toContain('stalled 2m');
  });

  it('returns whereItWentWrong=null for a clean run', () => {
    const clean = buildSessionDetail({
      ...baseTraj,
      steps: [baseTraj.steps[1]],
      gaps: [],
      errorCount: 0,
    });
    expect(clean.whereItWentWrong).toBeNull();
    expect(clean.meta.outcome).toBe('completed');
  });

  it('surfaces every failed step so a run-level view never hides a tool failure', () => {
    const d = buildSessionDetail(baseTraj);
    expect(d.surfacedToolFailures).toEqual([{ tool: 'Bash', label: 'git rebase', detail: undefined }]);

    const clean = buildSessionDetail({ ...baseTraj, steps: [baseTraj.steps[1]], gaps: [], errorCount: 0 });
    expect(clean.surfacedToolFailures).toEqual([]);
  });
});

describe('traces sync --dry-run local export', () => {
  const dryId = 'trace-dryrun-fixture';
  const dryTranscript = path.join(import.meta.dirname, '../session/testdata/codex-fixture.jsonl');

  beforeEach(() => {
    const db = getDB();
    for (const table of ['tool_calls', 'session_topics', 'session_insights']) {
      db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(dryId);
    }
    db.prepare('DELETE FROM sessions WHERE id = ?').run(dryId);
  });

  it('requires --out', async () => {
    await expect(syncTraces({ dryRun: true })).rejects.toThrow(/--out/);
  });

  it('writes shards locally with no backend and never touches the ledger', async () => {
    const stat = fs.statSync(dryTranscript);
    const db = getDB();
    db.prepare(`
      INSERT INTO sessions
        (id, short_id, agent, timestamp, project, cwd, git_branch, label, duration_ms,
         model, file_path, file_mtime_ms, file_size, machine)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      dryId, 'trace-dr', 'codex', '2026-08-25T00:00:00.000Z', 'agents-cli',
      '/home/x/agents-cli', 'main', 'Fix dry run', 9000, 'gpt-test',
      dryTranscript, stat.mtimeMs, stat.size, 'dry-device',
    );
    db.prepare(`
      INSERT INTO tool_calls
        (call_key, session_id, ordinal, timestamp, tool, input, outcome, exit_code, error, evidence_bytes)
      VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, 0)
    `).run('dry-call-1', dryId, 1, '2026-08-25T00:00:00.000Z', 'exec_command', 'error', 1, 'command failed');

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traces-dry-'));
    const ledgerPath = path.join(getRuntimeStateDir(), 'traces-sync.json');
    fs.rmSync(ledgerPath, { force: true });
    // No AGENTS_TRACES_BASE_URL / token set: a dry-run must NOT resolve a backend.
    delete process.env.AGENTS_TRACES_BASE_URL;
    delete process.env.AGENTS_TRACES_WRITE_TOKEN;
    process.env.AGENTS_SYNC_MACHINE_ID = 'dry-device';
    try {
      const result = await syncTraces({ dryRun: true, outDir });
      expect(result.uploaded).toBeGreaterThan(0);

      // index.json — rich shard, owner "local" (no Phoenix userId available).
      const index = JSON.parse(fs.readFileSync(path.join(outDir, 'index.json'), 'utf8'));
      expect(index.schema).toBe(1);
      expect(index.owner).toBe('local');
      expect(index.stats.sessionsImported).toBeGreaterThan(0);

      // sessions/<id>.json — the console's SessionDetail shape.
      const detail = JSON.parse(fs.readFileSync(path.join(outDir, 'sessions', `${dryId}.json`), 'utf8'));
      expect(detail.schema).toBe(1);
      expect(detail.meta).toHaveProperty('spanMs');
      expect(detail).toHaveProperty('whereItWentWrong');
      expect(detail.meta.repo).toBe('agents-cli');

      // The ledger is untouched — a dry-run is a read-only export.
      expect(fs.existsSync(ledgerPath)).toBe(false);
    } finally {
      delete process.env.AGENTS_SYNC_MACHINE_ID;
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe('traces sync failure retry ledger (PHNX-3267)', () => {
  const realTranscript = path.join(import.meta.dirname, '../session/testdata/codex-fixture.jsonl');
  const ids = ['retry-a', 'retry-b', 'retry-c-gone', 'retry-d-ok'];
  const ledgerPath = path.join(getRuntimeStateDir(), 'traces-sync.json');

  function insertSession(sessionId: string, mtimeMs: number, filePath: string): void {
    const db = getDB();
    db.prepare(`
      INSERT INTO sessions
        (id, short_id, agent, timestamp, project, cwd, git_branch, label, duration_ms,
         model, file_path, file_mtime_ms, file_size, machine)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId, sessionId.slice(0, 8), 'codex', '2026-08-25T00:00:00.000Z', 'agents-cli',
      '/home/x/agents-cli', 'main', 'Retry test', 9000, 'gpt-test',
      filePath, mtimeMs, 100, 'retry-device',
    );
  }

  beforeEach(() => {
    const db = getDB();
    for (const table of ['tool_calls', 'session_topics', 'session_insights']) {
      for (const sessionId of ids) db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
    }
    for (const sessionId of ids) db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    fs.rmSync(ledgerPath, { force: true });
  });

  afterEach(() => {
    delete process.env.AGENTS_TRACES_BASE_URL;
    delete process.env.AGENTS_TRACES_WRITE_TOKEN;
    delete process.env.AGENTS_SYNC_MACHINE_ID;
  });

  it('retries an upload-failed session stranded below the watermark, then a stable sync uploads zero', async () => {
    // A (older) and B (newer). B's later success advances the watermark past A —
    // the exact case the plain watermark loses. A must still come back via the ledger.
    insertSession('retry-a', 1000, realTranscript);
    insertSession('retry-b', 2000, realTranscript);

    let failA = true;
    const puts: string[] = [];
    const server = http.createServer((req, res) => {
      if (req.method === 'PUT') puts.push(req.url ?? '');
      req.resume();
      if (req.method === 'PUT' && failA && req.url?.includes('/sessions/retry-a.json')) {
        res.writeHead(500).end('boom');
      } else {
        res.writeHead(200).end('ok');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no TCP address');
    process.env.AGENTS_TRACES_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.AGENTS_TRACES_WRITE_TOKEN = 'test-token';
    process.env.AGENTS_SYNC_MACHINE_ID = 'retry-device';
    try {
      // First sync: B uploads, A's PUT 500s → recorded as an upload-failed retry.
      const first = await syncTraces({ skipIndex: true });
      expect(first.uploaded).toBe(1);
      expect(first.uploadFailed).toBe(1);
      expect(first.errors).toBe(1);
      const afterFirst = readSyncLedger();
      expect(afterFirst.lastSyncMtime).toBe(2000); // watermark advanced PAST A (1000)
      const stranded = (afterFirst.failures ?? []).find((f) => f.id === 'retry-a');
      expect(stranded?.kind).toBe('upload-failed');
      expect(stranded?.detail).toContain('500'); // actionable evidence, not an opaque count

      // A is now below the watermark. Only the union-with-retry-ids re-selects it.
      failA = false;
      puts.length = 0;
      const second = await syncTraces({ skipIndex: true });
      expect(puts.some((u) => u.includes('/sessions/retry-a.json'))).toBe(true); // re-attempted
      expect(second.uploaded).toBe(1); // A recovered
      expect(second.uploadFailed).toBe(0);
      expect((readSyncLedger().failures ?? [])).toHaveLength(0); // cleared on success

      // Third sync of unchanged data uploads nothing (idempotent).
      puts.length = 0;
      const third = await syncTraces({ skipIndex: true });
      expect(third.uploaded).toBe(0);
      expect(third.errors).toBe(0);
      expect(puts).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });

  it('classifies a missing transcript as unavailable and does not re-query it once past the watermark', async () => {
    // C points at a file that does not exist; D is a real, uploadable session with a
    // higher mtime so the watermark advances past C.
    insertSession('retry-c-gone', 1000, '/nonexistent/path/gone.jsonl');
    insertSession('retry-d-ok', 2000, realTranscript);

    const puts: string[] = [];
    const server = http.createServer((req, res) => {
      if (req.method === 'PUT') puts.push(req.url ?? '');
      req.resume();
      res.writeHead(200).end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no TCP address');
    process.env.AGENTS_TRACES_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.AGENTS_TRACES_WRITE_TOKEN = 'test-token';
    process.env.AGENTS_SYNC_MACHINE_ID = 'retry-device';
    try {
      const first = await syncTraces({ skipIndex: true });
      expect(first.transcriptUnavailable).toBe(1);
      expect(first.uploadFailed).toBe(0);
      expect(first.parseFailed).toBe(0);
      expect(first.uploaded).toBe(1); // D
      const recorded = (readSyncLedger().failures ?? []).find((f) => f.id === 'retry-c-gone');
      expect(recorded?.kind).toBe('transcript-unavailable');

      // Second sync: C is below the advanced watermark and unavailable, so it is
      // neither re-selected by the watermark nor by the retry union — no wasted work.
      puts.length = 0;
      const second = await syncTraces({ skipIndex: true });
      expect(second.uploaded).toBe(0);
      expect(second.transcriptUnavailable).toBe(0); // not re-queried, not re-counted
      expect(puts).toHaveLength(0);
      // The evidence is retained in the ledger for the operator even though it is not retried.
      expect((readSyncLedger().failures ?? []).some((f) => f.id === 'retry-c-gone')).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });
});
