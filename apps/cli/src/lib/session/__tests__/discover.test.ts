import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from '../../sqlite.js';
import { buildFtsQuery, getDB } from '../db.js';
import { scanClaudeSession, parseCodexThreadNameIndex, shouldDeferRecentAppend, machineForSessionFile, discoverSessions, resolveSessionById } from '../discover.js';
import { machineId } from '../sync/config.js';
import { getHistoryDir } from '../../state.js';

describe('machineForSessionFile', () => {
  it('reads the origin machine from the cross-machine mirror path', () => {
    const p = path.join(getHistoryDir(), 'backups', 'claude', 'zion', 'projects', 'foo', 'sess.jsonl');
    expect(machineForSessionFile(p, 'claude')).toBe('zion');
  });

  it('keys the mirror machine off the correct agent segment', () => {
    const p = path.join(getHistoryDir(), 'backups', 'codex', 'yosemite-s1', 'sessions', 'x.jsonl');
    expect(machineForSessionFile(p, 'codex')).toBe('yosemite-s1');
  });

  it('falls back to the local machine for live-home (non-mirror) files', () => {
    const p = path.join(os.homedir(), '.claude', 'projects', 'foo', 'sess.jsonl');
    expect(machineForSessionFile(p, 'claude')).toBe(machineId());
  });
});

describe('routine archive discovery', () => {
  const jobName = '__test_routine_sessions__';
  const runId = '2026-07-21T10-30-00-000Z';
  const sessionId = '11111111-2222-4333-8444-555555555555';
  const runDir = path.join(getHistoryDir(), 'runs', jobName, runId);

  afterEach(() => {
    fs.rmSync(path.join(getHistoryDir(), 'runs', jobName), { recursive: true, force: true });
    const db = getDB();
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
    db.prepare(`DELETE FROM session_text WHERE session_id = ?`).run(sessionId);
    db.prepare(`DELETE FROM scan_ledger WHERE file_path LIKE ?`).run(`${runDir}%`);
  });

  it('indexes archived routine transcripts and resolves them by routine run id', async () => {
    const transcriptDir = path.join(runDir, 'sessions', 'claude', 'projects', 'routine-project');
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(
      path.join(transcriptDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-07-21T10:30:00.000Z',
          cwd: '/tmp/routine-project',
          sessionId,
          message: { role: 'user', content: 'summarize routine result' },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-07-21T10:31:00.000Z',
          cwd: '/tmp/routine-project',
          sessionId,
          message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const sessions = await discoverSessions({
      agent: 'claude',
      origin: 'routine',
      all: true,
      limit: 100,
    });
    const hit = sessions.find((s) => s.id === sessionId);

    expect(hit).toBeDefined();
    expect(hit!.origin).toBe('routine');
    expect(hit!.routineName).toBe(jobName);
    expect(hit!.routineRunId).toBe(runId);
    expect(hit!.project).toBe(jobName);
    expect(hit!.label).toBe(jobName);
    expect(resolveSessionById(sessions, runId).map((s) => s.id)).toContain(sessionId);
  });
});

describe('buildFtsQuery', () => {
  it('returns empty expression for whitespace-only input', () => {
    expect(buildFtsQuery('').expr).toBe('');
    expect(buildFtsQuery('   ').expr).toBe('');
  });

  it('splits on non-alphanumerics, drops 1-char tokens, prefix-matches', () => {
    const { expr, terms } = buildFtsQuery('rush deploy-a2a a b 42');
    expect(terms).toEqual(['rush', 'deploy', 'a2a', '42']);
    expect(expr).toBe('rush* OR deploy* OR a2a* OR 42*');
  });

  it('lowercases tokens', () => {
    const { terms } = buildFtsQuery('RUSH Deploy');
    expect(terms).toEqual(['rush', 'deploy']);
  });
});

describe('FTS5 session_text schema (smoke test)', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-fts-'));
    db = new Database(path.join(tmpDir, 'sessions.db'));
    db.exec(`
      CREATE VIRTUAL TABLE session_text USING fts5(
        session_id UNINDEXED,
        content,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ranks rare terms higher than common ones (IDF)', () => {
    const insert = db.prepare('INSERT INTO session_text (session_id, content) VALUES (?, ?)');
    insert.run('a', 'session bug bug');
    insert.run('b', 'session notes');
    insert.run('c', 'session thoughts');
    insert.run('d', 'session plan');

    const rows = db.prepare(`
      SELECT session_id, bm25(session_text) AS r
      FROM session_text WHERE session_text MATCH ? ORDER BY r ASC
    `).all('bug') as { session_id: string; r: number }[];

    expect(rows[0].session_id).toBe('a');
  });

  it('supports prefix queries for partial typing', () => {
    const insert = db.prepare('INSERT INTO session_text (session_id, content) VALUES (?, ?)');
    insert.run('x', 'rush deploy yaml agent');
    insert.run('y', 'unrelated content');

    const rows = db.prepare(`
      SELECT session_id FROM session_text WHERE session_text MATCH ? ORDER BY bm25(session_text) ASC
    `).all('rush* OR dep*') as { session_id: string }[];

    expect(rows.map(r => r.session_id)).toContain('x');
    expect(rows.map(r => r.session_id)).not.toContain('y');
  });
});

// ---------------------------------------------------------------------------
// Claude session titles: `/rename` (custom-title) > Claude auto (ai-title) >
// first-prompt topic. Both title events can repeat; the last one wins.
// ---------------------------------------------------------------------------

describe('scanClaudeSession title resolution', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-claude-title-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(lines: object[]): string {
    const fp = path.join(dir, 'session.jsonl');
    fs.writeFileSync(fp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return fp;
  }

  const userMsg = (text: string) => ({
    type: 'user',
    timestamp: '2026-06-28T00:00:00.000Z',
    cwd: '/x',
    message: { role: 'user', content: text },
  });

  it('prefers a user custom-title over the auto ai-title and first prompt', async () => {
    const fp = write([
      userMsg('fix the auth refresh bug please'),
      { type: 'ai-title', aiTitle: 'Auth refresh fix', sessionId: 's' },
      { type: 'custom-title', customTitle: 'close-li-outreach-gap', sessionId: 's' },
    ]);
    expect((await scanClaudeSession(fp)).topic).toBe('close-li-outreach-gap');
  });

  it('falls back to ai-title when there is no custom-title', async () => {
    const fp = write([
      userMsg('do the thing'),
      { type: 'ai-title', aiTitle: 'Release new version of agents-cli', sessionId: 's' },
    ]);
    expect((await scanClaudeSession(fp)).topic).toBe('Release new version of agents-cli');
  });

  it('falls back to the first-prompt topic when no title events exist', async () => {
    const fp = write([userMsg('investigate the flaky test')]);
    expect((await scanClaudeSession(fp)).topic).toBe('investigate the flaky test');
  });

  it('takes the last custom-title when renamed more than once', async () => {
    const fp = write([
      userMsg('start'),
      { type: 'custom-title', customTitle: 'first name', sessionId: 's' },
      { type: 'custom-title', customTitle: 'second name', sessionId: 's' },
    ]);
    expect((await scanClaudeSession(fp)).topic).toBe('second name');
  });

  it('ignores whitespace-only title values', async () => {
    const fp = write([
      userMsg('real prompt here'),
      { type: 'ai-title', aiTitle: '   ', sessionId: 's' },
    ]);
    expect((await scanClaudeSession(fp)).topic).toBe('real prompt here');
  });

  it('sets lastActivity to the last event time, distinct from the creation timestamp', async () => {
    const fp = write([
      { type: 'user', timestamp: '2026-06-28T00:00:00.000Z', cwd: '/x', message: { role: 'user', content: 'start' } },
      { type: 'assistant', timestamp: '2026-06-28T02:30:00.000Z', cwd: '/x', message: { role: 'assistant', content: 'done' } },
    ]);
    const scan = await scanClaudeSession(fp);
    expect(scan.timestamp).toBe('2026-06-28T00:00:00.000Z'); // first event = creation
    expect(scan.lastActivity).toBe('2026-06-28T02:30:00.000Z'); // last event = activity
  });
});

// ---------------------------------------------------------------------------
// Codex titles live in session_index.jsonl (thread_name), updated out of band.
// ---------------------------------------------------------------------------

describe('parseCodexThreadNameIndex', () => {
  it('maps id -> thread_name, trims, and skips malformed/empty/id-less lines', () => {
    const raw = [
      JSON.stringify({ id: 'a', thread_name: 'Review skill placement', updated_at: 'x' }),
      '',
      'not json at all',
      JSON.stringify({ id: 'b', thread_name: '   ' }),
      JSON.stringify({ id: '', thread_name: 'no id' }),
      JSON.stringify({ id: 'c', thread_name: '  Find top resource hogs  ' }),
    ].join('\n');

    const map = parseCodexThreadNameIndex(raw);
    expect(map.get('a')).toBe('Review skill placement');
    expect(map.has('b')).toBe(false);
    expect(map.has('')).toBe(false);
    expect(map.get('c')).toBe('Find top resource hogs');
    expect(map.size).toBe(2);
  });

  it('returns an empty map for empty input', () => {
    expect(parseCodexThreadNameIndex('').size).toBe(0);
  });
});

describe('shouldDeferRecentAppend', () => {
  const now = 1_000_000;
  const prev = {
    fileMtimeMs: now - 2_000,
    fileSize: 1_000,
    scannedAt: now - 1_000,
  };

  it('defers append-only growth scanned inside the debounce window', () => {
    expect(shouldDeferRecentAppend(prev, {
      fileMtimeMs: now - 500,
      fileSize: 1_500,
    }, now, 5_000)).toBe(true);
  });

  it('rescans append-only growth after the debounce window expires', () => {
    expect(shouldDeferRecentAppend({ ...prev, scannedAt: now - 6_000 }, {
      fileMtimeMs: now - 500,
      fileSize: 1_500,
    }, now, 5_000)).toBe(false);
  });

  it('does not defer truncates or same-size rewrites', () => {
    expect(shouldDeferRecentAppend(prev, {
      fileMtimeMs: now - 500,
      fileSize: 900,
    }, now, 5_000)).toBe(false);

    expect(shouldDeferRecentAppend(prev, {
      fileMtimeMs: now - 500,
      fileSize: 1_000,
    }, now, 5_000)).toBe(false);
  });
});
