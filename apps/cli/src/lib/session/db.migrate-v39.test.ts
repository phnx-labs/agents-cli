import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate a fresh HOME BEFORE importing state/db. db.ts captures DB_PATH at module
// load (db.ts:30), so redirecting it after the import silently opens the wrong
// database. Every migration test in this directory uses this pattern.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migv39-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

/**
 * v38 -> v39: durable tool-session metadata (RUSH-2549).
 *
 * The upgrade is driven the way production drives it, not by hand-writing an
 * older schema: open the DB (current schema), drop the two new tables, stamp
 * `user_version = 38`, close, reopen. `getDB` then replays exactly what a real
 * pre-v39 machine replays — `db.exec(SCHEMA)` followed by `migrateSchema(38)`.
 *
 * Two things have to be true afterwards. The tables and their indexes must
 * exist, and an UPGRADED database must end up identical to a FRESH one — a
 * column present in `SCHEMA` but missing from the v39 migration block (or the
 * reverse) is invisible until a query fails on exactly one person's machine.
 * The migration is purely additive, so an existing session row survives.
 */
const { getSessionsDir } = await import('../state.js');
fs.mkdirSync(getSessionsDir(), { recursive: true });

const {
  getDB,
  closeDB,
  SCHEMA_VERSION,
  upsertSession,
  recordBrowserSession,
  listBrowserSessionRecords,
} = await import('./db.js');

const TOOL_TABLES = ['browser_sessions', 'computer_sessions'] as const;

/** Column names for a table, sorted — the comparison unit for schema drift. */
function columnsOf(table: string): string[] {
  return (getDB().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((c) => c.name)
    .sort();
}

// A fresh, fully-migrated database: capture what the tables SHOULD look like.
const transcript = path.join(TEST_HOME, 'pre-v39.jsonl');
fs.writeFileSync(transcript, '');
upsertSession(
  {
    id: 'pre-v39-session',
    shortId: 'prev39',
    agent: 'claude',
    timestamp: '2026-08-01T00:00:00.000Z',
    filePath: transcript,
  } as unknown as Parameters<typeof upsertSession>[0],
  'a session indexed before v39 shipped',
);
const freshColumns = Object.fromEntries(TOOL_TABLES.map((t) => [t, columnsOf(t)]));

// Rewind to v38: drop what v39 adds, stamp the old version, reopen.
// The version lives in the `meta` table (db.ts:1224 reads
// `SELECT value FROM meta WHERE key = 'schema_version'`), NOT the sqlite
// user_version pragma — stamping the pragma leaves the recorded version
// untouched, so `migrateSchema` never runs and the test silently proves nothing.
{
  const db = getDB();
  for (const t of TOOL_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
  db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)`).run('38');
}
closeDB();

/** The recorded schema version, read the same way db.ts records it. */
function recordedVersion(): string | undefined {
  const row = getDB()
    .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
    .get() as { value: string } | undefined;
  return row?.value;
}

describe('db migration v38 -> v39 (durable tool sessions, RUSH-2549)', () => {
  it('recreates both tool-session tables on a pre-v39 database and stamps the new version', () => {
    const db = getDB();
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(39);

    const tables = (db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as Array<{ name: string }>).map((r) => r.name);
    for (const t of TOOL_TABLES) expect(tables).toContain(t);

    expect(recordedVersion()).toBe(String(SCHEMA_VERSION));
  });

  it('is non-destructive — a session indexed before the upgrade survives', () => {
    const row = getDB()
      .prepare(`SELECT id FROM sessions WHERE id = ?`)
      .get('pre-v39-session') as { id: string } | undefined;
    expect(row?.id).toBe('pre-v39-session');
  });

  it('creates the lookup indexes the listing path relies on', () => {
    const indexes = (getDB()
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
      .all() as Array<{ name: string }>).map((r) => r.name);
    expect(indexes).toContain('idx_browser_sessions_session');
    expect(indexes).toContain('idx_computer_sessions_session');
  });

  it('an upgraded database has the SAME columns as a fresh one (no schema drift)', () => {
    for (const t of TOOL_TABLES) {
      expect(columnsOf(t), `${t} drifted between SCHEMA and the v39 migration`).toEqual(freshColumns[t]);
    }
  });

  it('the migrated tables accept a write and read it back', () => {
    recordBrowserSession({ task: 'post-migration', profile: 'p@endpoint-0', sessionId: 'sess-after-migrate' });
    const rows = listBrowserSessionRecords('p@endpoint-0');
    expect(rows.find((r) => r.task === 'post-migration')?.sessionId).toBe('sess-after-migrate');
  });
});
