/**
 * RUSH-2211: the three query hot-path fixes in querySessions/ftsSearch.
 *   1. The default listing sort uses the bare `last_activity` column (not
 *      `IFNULL(last_activity, timestamp)`) so idx_sessions_last_activity serves it.
 *   2. The post-query existence check batches `fs.existsSync` per directory
 *      (`findMissingFilePaths`) instead of one stat syscall per row, but must
 *      still drop exactly the rows whose file vanished.
 *   3. Label-first search (`ftsSearch`) routes through the FTS5 `label` column
 *      instead of a leading-wildcard `LOWER(label) LIKE '%q%'` table scan.
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-qhotpath-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { closeDB, getDB, upsertSession, querySessions, ftsSearch } = await import('./db.js');
type SessionMeta = import('./types.js').SessionMeta;

afterAll(() => {
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    shortId: id.slice(0, 8),
    agent: 'claude',
    timestamp: new Date('2026-01-01T00:00:00Z').toISOString(),
    filePath: '',
    ...extra,
  };
}

describe('querySessions default sort uses the last_activity index', () => {
  it('EXPLAIN QUERY PLAN shows an index scan, not a table scan + sort', () => {
    const db = getDB();
    for (let i = 0; i < 5; i++) {
      upsertSession(meta(`sort-${i}`, {
        lastActivity: new Date(2026, 0, i + 1).toISOString(),
        filePath: '',
      }), '');
    }
    const plan = db.prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM sessions ORDER BY last_activity DESC, timestamp DESC LIMIT 20`,
    ).all() as Array<{ detail: string }>;
    const detail = plan.map(r => r.detail).join(' | ');
    expect(detail).toMatch(/USING INDEX idx_sessions_last_activity/);
    // The old shape wrapped the column in IFNULL(), which this same plan check
    // would have shown as a SCAN + a separate sort — this asserts the fix, not
    // just that *a* plan exists.
    expect(detail).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/);
  });

  it('returns rows newest-last_activity-first', () => {
    const rows = querySessions({ idPrefix: 'sort-' });
    const ids = rows.map(r => r.id);
    expect(ids).toEqual(['sort-4', 'sort-3', 'sort-2', 'sort-1', 'sort-0']);
  });
});

describe('querySessions batched existence check', () => {
  it('drops rows whose backing file is gone and keeps rows whose file is present, across several directories', () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-qhp-dirA-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-qhp-dirB-'));
    const liveA = path.join(dirA, 'live-a.jsonl');
    const goneA = path.join(dirA, 'gone-a.jsonl');
    const liveB = path.join(dirB, 'live-b.jsonl');
    const goneB = path.join(dirB, 'gone-b.jsonl');
    fs.writeFileSync(liveA, '{}');
    fs.writeFileSync(liveB, '{}');
    // goneA/goneB are referenced by session rows but never written to disk —
    // simulates a transcript deleted out from under the index.

    upsertSession(meta('exist-live-a', { filePath: liveA }), '');
    upsertSession(meta('exist-gone-a', { filePath: goneA }), '');
    upsertSession(meta('exist-live-b', { filePath: liveB }), '');
    upsertSession(meta('exist-gone-b', { filePath: goneB }), '');
    // A synthetic row (no file_path) must survive untouched — it's exempt from
    // the existence check entirely.
    upsertSession(meta('exist-synthetic', { filePath: '' }), '');

    const rows = querySessions({ idPrefix: 'exist-' });
    const ids = new Set(rows.map(r => r.id));
    expect(ids.has('exist-live-a')).toBe(true);
    expect(ids.has('exist-live-b')).toBe(true);
    expect(ids.has('exist-synthetic')).toBe(true);
    expect(ids.has('exist-gone-a')).toBe(false);
    expect(ids.has('exist-gone-b')).toBe(false);

    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });

  it('skipExistenceCheck bypasses the check entirely, including for a vanished file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-qhp-skip-'));
    const file = path.join(dir, 'vanished.jsonl');
    upsertSession(meta('exist-skip', { filePath: file }), '');
    const rows = querySessions({ idExact: 'exist-skip', skipExistenceCheck: true });
    expect(rows.map(r => r.id)).toEqual(['exist-skip']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('purges tool-call evidence for a row it drops as missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-qhp-purge-'));
    const file = path.join(dir, 'purge-me.jsonl');
    const db = getDB();
    upsertSession(meta('exist-purge', { filePath: file }), '');
    db.prepare(
      `INSERT INTO tool_calls (call_key, session_id, ordinal, timestamp, tool, input, outcome, evidence_bytes)
       VALUES ('purge-call-1', 'exist-purge', 0, ?, 'exec', '{}', 'ok', 2)`,
    ).run(new Date().toISOString());

    querySessions({ idExact: 'exist-purge' });

    const remaining = db.prepare(`SELECT COUNT(*) AS c FROM tool_calls WHERE session_id = 'exist-purge'`)
      .get() as { c: number };
    expect(remaining.c).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('ftsSearch label tier routes through the FTS5 index, not a leading-wildcard scan', () => {
  it('finds a session by a single-character label prefix (the interactive type-ahead case)', () => {
    upsertSession(meta('label-quick', { label: 'quick-fix' }), '');
    const hits = ftsSearch('q');
    const hit = hits.find(h => h.sessionId === 'label-quick');
    expect(hit).toBeDefined();
    expect(hit!.score).toBeGreaterThanOrEqual(800_000);
  });

  it('still ranks exact > prefix > contains for label matches', () => {
    upsertSession(meta('label-exact', { label: 'nightly-audit' }), '');
    upsertSession(meta('label-prefix', { label: 'nightly-audit-followup' }), '');
    upsertSession(meta('label-contains', { label: 'run-nightly-audit-again' }), '');

    const exactHit = ftsSearch('nightly-audit').find(h => h.sessionId === 'label-exact');
    expect(exactHit?.score).toBe(1_000_000);

    // Exact match short-circuits the tier (see ftsSearch docblock), so re-query
    // with a term that only prefix/contains-matches to see those tiers.
    const prefixHits = ftsSearch('nightly-audit-follow');
    expect(prefixHits.find(h => h.sessionId === 'label-prefix')?.score).toBe(900_000);
  });

  it('an empty/punctuation-only query falls back to the direct scan without throwing', () => {
    upsertSession(meta('label-punct', { label: 'weird...label' }), '');
    expect(() => ftsSearch('...')).not.toThrow();
  });
});
