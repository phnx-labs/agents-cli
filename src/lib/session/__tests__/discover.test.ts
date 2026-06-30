import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from '../../sqlite.js';
import { buildFtsQuery } from '../db.js';
import { scanClaudeSession, parseCodexThreadNameIndex, shouldDeferRecentAppend } from '../discover.js';

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
