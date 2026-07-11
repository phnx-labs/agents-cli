import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Set HOME before db.js loads so its module-level base dir picks up the
// override. Plain top-level statements run before the dynamic `await import`
// below, so vi.hoisted is not needed (and is also not supported by Bun's
// native test runner).
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-db-test-'));
process.env.HOME = TEST_HOME;

const {
  getDB,
  getDBPath,
  querySessions,
  findSessionsById,
  closeDB,
  upsertSession,
  upsertSessionsBatch,
  queryUsageRollup,
  topSessionsByCost,
  syncTopics,
  ftsSearch,
} = await import('../db.js');
const { costOfUsage } = await import('../../pricing/index.js');
type SessionMeta = import('../types.js').SessionMeta;

// JSONL files live under TEST_HOME so they're isolated and torn down with it.
// querySessions filters out rows whose file_path no longer exists on disk
// (defense against phantom rows after a config-symlink swap, see #136), so
// every seeded row needs a real backing file.
const SEED_FILES_DIR = path.join(TEST_HOME, 'seed-files');
fs.mkdirSync(SEED_FILES_DIR, { recursive: true });

function seed(id: string, version: string | null, timestamp: string): void {
  const filePath = path.join(SEED_FILES_DIR, `${id}.jsonl`);
  fs.writeFileSync(filePath, '');
  const db = getDB();
  db.prepare(`
    INSERT INTO sessions (
      id, short_id, agent, version, timestamp, project, cwd,
      file_path, file_mtime_ms, file_size, scanned_at, is_team_origin
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    id,
    id.slice(0, 8),
    'claude',
    version,
    timestamp,
    'agents-cli',
    SEED_FILES_DIR,
    filePath,
    0,
    0,
    0,
  );
}

describe('querySessions version filter', () => {
  beforeAll(() => {
    seed('s1-older', '2.1.111', '2026-04-19T10:00:00.000Z');
    seed('s2-newer', '2.1.112', '2026-04-19T11:00:00.000Z');
    seed('s3-same',  '2.1.112', '2026-04-19T12:00:00.000Z');
    seed('s4-null',  null,      '2026-04-19T13:00:00.000Z');
  });

  it('returns only sessions matching the requested version', () => {
    const rows = querySessions({ version: '2.1.112' });
    expect(rows.map(r => r.id).sort()).toEqual(['s2-newer', 's3-same']);
  });

  it('stores the sessions database under ~/.agents/.history/sessions', () => {
    expect(getDBPath()).toBe(path.join(TEST_HOME, '.agents', '.history', 'sessions', 'sessions.db'));
  });

  it('returns no sessions for an unknown version', () => {
    const rows = querySessions({ version: '99.99.99' });
    expect(rows).toEqual([]);
  });

  it('returns all sessions when version is omitted', () => {
    const rows = querySessions({});
    expect(rows.map(r => r.id).sort()).toEqual(['s1-older', 's2-newer', 's3-same', 's4-null']);
  });

  it('filters by version even when agent is also set', () => {
    const rows = querySessions({ agent: 'claude', version: '2.1.111' });
    expect(rows.map(r => r.id)).toEqual(['s1-older']);
  });
});

// ---------------------------------------------------------------------------
// Cost + duration (issue #323) — real SQLite, migration v6 columns, sort,
// rollup grouping for a multi-model session.
// ---------------------------------------------------------------------------

// Single teardown for the whole file (the per-describe teardown was removed so
// later describe blocks still have a live DB and an intact TEST_HOME).
afterAll(() => {
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

const COST_FILES_DIR = path.join(TEST_HOME, 'cost-files');
fs.mkdirSync(COST_FILES_DIR, { recursive: true });

/** Upsert a costed session through the public API (exercises the v6 schema). */
function seedCosted(
  id: string,
  agent: SessionMeta['agent'],
  timestamp: string,
  costUsd: number | undefined,
  durationMs: number | undefined,
  project = 'agents-cli',
): void {
  const filePath = path.join(COST_FILES_DIR, `${id}.jsonl`);
  fs.writeFileSync(filePath, '');
  const meta: SessionMeta = {
    id,
    shortId: id.slice(0, 8),
    agent,
    timestamp,
    project,
    cwd: COST_FILES_DIR,
    filePath,
    costUsd,
    durationMs,
  };
  upsertSession(meta, '');
}

describe('migration v5 -> v6 adds cost/duration columns', () => {
  it('sessions table has cost_usd and duration_ms columns', () => {
    const db = getDB();
    const cols = (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('cost_usd');
    expect(cols).toContain('duration_ms');
  });

  it('schema_version is recorded as the current version', () => {
    const db = getDB();
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string };
    expect(row.value).toBe('11');
  });

  it('v10 unifies name into label — the separate `name` column is dropped', () => {
    const db = getDB();
    const cols = (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).not.toContain('name');
    expect(cols).toContain('label');
  });

  it('v7 adds the session-state columns (pr_url, worktree_slug, ticket_id)', () => {
    const db = getDB();
    const cols = (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('pr_url');
    expect(cols).toContain('pr_number');
    expect(cols).toContain('worktree_slug');
    expect(cols).toContain('ticket_id');
  });

  it('v8 adds the last_activity column', () => {
    const db = getDB();
    const cols = (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('last_activity');
  });

  it('v11 adds the plan column (ExitPlanMode markdown)', () => {
    const db = getDB();
    const cols = (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('plan');
  });
});

// ---------------------------------------------------------------------------
// last_activity (v8) — the listing sorts and labels by last-message time, not
// creation time. A session created long ago but active recently must lead.
// ---------------------------------------------------------------------------
const ACTIVITY_FILES_DIR = path.join(TEST_HOME, 'activity-files');
fs.mkdirSync(ACTIVITY_FILES_DIR, { recursive: true });

function seedActive(id: string, timestamp: string, lastActivity: string | undefined): void {
  const filePath = path.join(ACTIVITY_FILES_DIR, `${id}.jsonl`);
  fs.writeFileSync(filePath, '');
  upsertSession(
    { id, shortId: id.slice(0, 8), agent: 'claude', timestamp, lastActivity, project: 'agents-cli', cwd: ACTIVITY_FILES_DIR, filePath },
    '',
  );
}

describe('default sort orders by last_activity (v8)', () => {
  beforeAll(() => {
    // Creation order and activity order deliberately disagree.
    seedActive('la-oldcreate-newactive', '2026-01-01T00:00:00.000Z', '2026-07-04T12:00:00.000Z');
    seedActive('la-midcreate-midactive', '2026-06-01T00:00:00.000Z', '2026-06-15T00:00:00.000Z');
    seedActive('la-newcreate-oldactive', '2026-07-01T00:00:00.000Z', '2026-07-01T00:05:00.000Z');
    seedActive('la-noactivity', '2026-05-20T00:00:00.000Z', undefined); // no lastActivity → falls back to timestamp
  });

  it('round-trips last_activity through SQLite', () => {
    const rows = querySessions({ cwdPrefix: ACTIVITY_FILES_DIR });
    expect(rows.find(r => r.id === 'la-oldcreate-newactive')!.lastActivity).toBe('2026-07-04T12:00:00.000Z');
  });

  it('ranks by last activity, not creation time (fallback = timestamp)', () => {
    const rows = querySessions({ cwdPrefix: ACTIVITY_FILES_DIR });
    expect(rows.map(r => r.id)).toEqual([
      'la-oldcreate-newactive', // active Jul 4 (though created back in Jan)
      'la-newcreate-oldactive', // active Jul 1
      'la-midcreate-midactive', // active Jun 15
      'la-noactivity',          // no activity → creation ts May 20
    ]);
  });
});

describe('cost/duration upsert round-trip', () => {
  beforeAll(() => {
    seedCosted('c1-cheap', 'claude', '2026-05-01T10:00:00.000Z', 0.50, 60_000, 'proj-a');
    seedCosted('c2-pricey', 'claude', '2026-05-02T10:00:00.000Z', 12.34, 3_600_000, 'proj-b');
    seedCosted('c3-mid', 'codex', '2026-05-03T10:00:00.000Z', 3.00, 600_000, 'proj-a');
    seedCosted('c4-null', 'claude', '2026-05-04T10:00:00.000Z', undefined, undefined, 'proj-b');
  });

  it('round-trips cost_usd and duration_ms through SQLite', () => {
    const rows = querySessions({ cwdPrefix: COST_FILES_DIR });
    const pricey = rows.find(r => r.id === 'c2-pricey')!;
    expect(pricey.costUsd).toBeCloseTo(12.34, 10);
    expect(pricey.durationMs).toBe(3_600_000);
    const nullRow = rows.find(r => r.id === 'c4-null')!;
    expect(nullRow.costUsd).toBeUndefined();
    expect(nullRow.durationMs).toBeUndefined();
  });

  it('--sort cost orders by cost desc with NULLs last', () => {
    const rows = querySessions({ cwdPrefix: COST_FILES_DIR, sortBy: 'cost' });
    expect(rows.map(r => r.id)).toEqual(['c2-pricey', 'c3-mid', 'c1-cheap', 'c4-null']);
  });

  it('--sort duration orders by duration desc with NULLs last', () => {
    const rows = querySessions({ cwdPrefix: COST_FILES_DIR, sortBy: 'duration' });
    expect(rows.map(r => r.id)).toEqual(['c2-pricey', 'c3-mid', 'c1-cheap', 'c4-null']);
  });

  it('topSessionsByCost returns priciest first and excludes NULL-cost rows', () => {
    const top = topSessionsByCost(10, { cwdPrefix: COST_FILES_DIR });
    expect(top.map(t => t.meta.id)).toEqual(['c2-pricey', 'c3-mid', 'c1-cheap']);
    expect(top[0].costUsd).toBeCloseTo(12.34, 10);
  });

  it('queryUsageRollup groups by agent with summed cost', () => {
    const rows = queryUsageRollup({ cwdPrefix: COST_FILES_DIR, groupBy: 'agent' });
    const byKey = new Map(rows.map(r => [r.key, r]));
    expect(byKey.get('claude')!.costUsd).toBeCloseTo(0.50 + 12.34, 10);
    expect(byKey.get('claude')!.sessionCount).toBe(3);
    expect(byKey.get('codex')!.costUsd).toBeCloseTo(3.00, 10);
  });

  it('queryUsageRollup groups by project across agents', () => {
    const rows = queryUsageRollup({ cwdPrefix: COST_FILES_DIR, groupBy: 'project' });
    const byKey = new Map(rows.map(r => [r.key, r]));
    // proj-a = c1-cheap (claude) + c3-mid (codex) = 0.50 + 3.00
    expect(byKey.get('proj-a')!.costUsd).toBeCloseTo(3.50, 10);
    expect(byKey.get('proj-a')!.sessionCount).toBe(2);
    // proj-b = c2-pricey + c4-null (null cost contributes 0)
    expect(byKey.get('proj-b')!.costUsd).toBeCloseTo(12.34, 10);
    expect(byKey.get('proj-b')!.sessionCount).toBe(2);
  });

  it('queryUsageRollup groups by day (ISO date prefix)', () => {
    const rows = queryUsageRollup({ cwdPrefix: COST_FILES_DIR, groupBy: 'day' });
    const keys = rows.map(r => r.key);
    expect(keys).toContain('2026-05-01');
    expect(keys).toContain('2026-05-02');
  });
});

describe('multi-model session cost equals sum of per-model usage', () => {
  it('an opus+haiku session sums to the sum of each model cost', () => {
    // Simulate a session that ran two models; the scanner accumulates per-model
    // cost into one costUsd. Verify the rollup reflects that exact sum.
    const opus = costOfUsage({ model: 'claude-opus-4', inputTokens: 10_000, outputTokens: 5_000 });
    const haiku = costOfUsage({ model: 'claude-haiku-4', inputTokens: 20_000, outputTokens: 8_000 });
    const sessionCost = opus + haiku;
    seedCosted('mm1', 'claude', '2026-05-10T10:00:00.000Z', sessionCost, 120_000, 'proj-mm');

    const rows = queryUsageRollup({ cwdPrefix: COST_FILES_DIR, groupBy: 'project' });
    const projMm = rows.find(r => r.key === 'proj-mm')!;
    expect(projMm.costUsd).toBeCloseTo(opus + haiku, 10);
    expect(projMm.costUsd).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// syncTopics — apply externally-sourced titles (Codex thread_name) by id.
// ---------------------------------------------------------------------------

const TOPIC_FILES_DIR = path.join(TEST_HOME, 'topic-files');
fs.mkdirSync(TOPIC_FILES_DIR, { recursive: true });

function seedTopic(id: string, topic: string): void {
  const filePath = path.join(TOPIC_FILES_DIR, `${id}.jsonl`);
  fs.writeFileSync(filePath, '');
  const meta: SessionMeta = {
    id,
    shortId: id.slice(0, 8),
    agent: 'codex',
    timestamp: '2026-06-28T00:00:00.000Z',
    project: 'agents-cli',
    cwd: TOPIC_FILES_DIR,
    filePath,
    topic,
  };
  // Upsert through the public API so session_text (FTS) is populated too.
  upsertSession(meta, 'searchable body text');
}

describe('syncTopics', () => {
  beforeAll(() => {
    seedTopic('codex-rename', 'first prompt fallback');
    seedTopic('codex-keep', 'Already correct');
  });

  it('updates topic in sessions + FTS only for ids whose title differs', () => {
    const updated = syncTopics(
      new Map([
        ['codex-rename', 'Review skill placement'],
        ['codex-keep', 'Already correct'], // identical -> no update
        ['codex-missing', 'No such session'], // not in DB -> no update
      ]),
    );
    expect(updated).toBe(1);

    const rows = querySessions({ agent: 'codex' });
    expect(rows.find(r => r.id === 'codex-rename')?.topic).toBe('Review skill placement');
    expect(rows.find(r => r.id === 'codex-keep')?.topic).toBe('Already correct');

    // The new title is searchable via FTS (topic column was updated, not just sessions).
    const hits = ftsSearch('Review skill placement');
    expect(hits.some(h => h.sessionId === 'codex-rename')).toBe(true);
  });

  it('never clears an existing topic with an empty value', () => {
    const updated = syncTopics(new Map([['codex-keep', '']]));
    expect(updated).toBe(0);
    const rows = querySessions({ agent: 'codex' });
    expect(rows.find(r => r.id === 'codex-keep')?.topic).toBe('Already correct');
  });

  it('returns 0 for an empty map', () => {
    expect(syncTopics(new Map())).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// findSessionsById — exact-then-prefix id resolution over the index (the
// DB-backed equivalent of resolveSessionById, used by `agents run --resume`).
// ---------------------------------------------------------------------------

const ID_FILES_DIR = path.join(TEST_HOME, 'id-files');
fs.mkdirSync(ID_FILES_DIR, { recursive: true });

/** Seed a session with explicit id / short_id / agent / version / cwd. */
function seedId(
  id: string,
  shortId: string,
  agent: string,
  version: string | null,
  cwd: string,
  timestamp: string,
): void {
  const filePath = path.join(ID_FILES_DIR, `${id}.jsonl`);
  fs.writeFileSync(filePath, '');
  getDB().prepare(`
    INSERT INTO sessions (
      id, short_id, agent, version, timestamp, project, cwd,
      file_path, file_mtime_ms, file_size, scanned_at, is_team_origin
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(id, shortId, agent, version, timestamp, 'proj-id', cwd, filePath, 0, 0, 0);
}

describe('findSessionsById', () => {
  const HERE = path.join(ID_FILES_DIR, 'here');
  const ELSEWHERE = path.join(ID_FILES_DIR, 'elsewhere');

  beforeAll(() => {
    // Two sessions sharing the prefix "80af" in THIS project's cwd.
    seedId('80af76ca-b734-4f45-8833-ef1142219568', '80af76ca', 'claude', '2.1.180', HERE, '2026-06-01T10:00:00.000Z');
    seedId('80af0000-0000-4000-8000-000000000001', '80af0000', 'claude', '2.1.181', HERE, '2026-06-02T10:00:00.000Z');
    // A non-overlapping id in a DIFFERENT project's cwd (for widen test).
    seedId('cccccccc-0000-4000-8000-000000000002', 'cccccccc', 'claude', '2.1.181', ELSEWHERE, '2026-06-03T10:00:00.000Z');
    // A codex session whose id collides on prefix with the claude ones.
    seedId('80af9999-0000-4000-8000-000000000003', '80af9999', 'codex', '0.50.0', HERE, '2026-06-04T10:00:00.000Z');
  });

  it('resolves a full id exactly (no prefix siblings dragged in)', () => {
    const r = findSessionsById('80af76ca-b734-4f45-8833-ef1142219568', { agent: 'claude' });
    expect(r.map(s => s.id)).toEqual(['80af76ca-b734-4f45-8833-ef1142219568']);
  });

  it('resolves a short id exactly', () => {
    const r = findSessionsById('80af0000', { agent: 'claude' });
    expect(r.map(s => s.id)).toEqual(['80af0000-0000-4000-8000-000000000001']);
  });

  it('is case-insensitive', () => {
    const r = findSessionsById('80AF76CA', { agent: 'claude' });
    expect(r.map(s => s.id)).toEqual(['80af76ca-b734-4f45-8833-ef1142219568']);
  });

  it('returns all prefix matches when ambiguous, newest first', () => {
    const r = findSessionsById('80af', { agent: 'claude' });
    expect(r.map(s => s.id)).toEqual([
      '80af0000-0000-4000-8000-000000000001',
      '80af76ca-b734-4f45-8833-ef1142219568',
    ]);
  });

  it('scopes by agent — codex prefix sibling does not leak into a claude lookup', () => {
    const claude = findSessionsById('80af', { agent: 'claude' });
    expect(claude.some(s => s.agent === 'codex')).toBe(false);
    const codex = findSessionsById('80af', { agent: 'codex' });
    expect(codex.map(s => s.id)).toEqual(['80af9999-0000-4000-8000-000000000003']);
  });

  it('scopes by version', () => {
    const r = findSessionsById('80af', { agent: 'claude', version: '2.1.180' });
    expect(r.map(s => s.id)).toEqual(['80af76ca-b734-4f45-8833-ef1142219568']);
  });

  it('cwd scope finds in-project, and dropping cwd widens to other projects', () => {
    const scoped = findSessionsById('cccccccc', { agent: 'claude', cwd: HERE });
    expect(scoped).toEqual([]); // lives in ELSEWHERE, not HERE
    const widened = findSessionsById('cccccccc', { agent: 'claude' });
    expect(widened.map(s => s.id)).toEqual(['cccccccc-0000-4000-8000-000000000002']);
  });

  it('returns empty for an unknown id and a blank query', () => {
    expect(findSessionsById('deadbeef', { agent: 'claude' })).toEqual([]);
    expect(findSessionsById('   ', { agent: 'claude' })).toEqual([]);
  });
});

describe('upsertSessionsBatch per-row guard', () => {
  it('skips a row that violates a NOT NULL column and still indexes the rest', () => {
    const goodFile = path.join(SEED_FILES_DIR, 'batch-good.jsonl');
    const badFile = path.join(SEED_FILES_DIR, 'batch-bad.jsonl');
    fs.writeFileSync(goodFile, '');
    fs.writeFileSync(badFile, '');
    const mk = (id: string, timestamp: string, filePath: string) => ({
      meta: { id, shortId: id.slice(0, 8), agent: 'kimi' as const, timestamp, filePath } as SessionMeta,
      content: '',
      scan: { fileMtimeMs: 0, fileSize: 0 },
    });
    const good = mk('batch-good-0000-4000-8000-000000000001', '2026-07-01T00:00:00.000Z', goodFile);
    // A NULL timestamp violates `timestamp TEXT NOT NULL`. Before the guard this threw
    // and rolled back the whole batch; now it must skip just this row.
    const bad = mk('batch-bad-00000-4000-8000-000000000002', null as unknown as string, badFile);

    expect(() => upsertSessionsBatch([bad, good])).not.toThrow();

    const ids = querySessions({}).map((s) => s.id);
    expect(ids).toContain('batch-good-0000-4000-8000-000000000001');
    expect(ids).not.toContain('batch-bad-00000-4000-8000-000000000002');
  });
});
