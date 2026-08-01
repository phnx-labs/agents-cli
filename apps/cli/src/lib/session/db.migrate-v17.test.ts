import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migv17-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { getSessionsDir, getSessionsDbPath } = await import('../state.js');
fs.mkdirSync(getSessionsDir(), { recursive: true });
const Database = (await import('../sqlite.js')).default;
{
  const seed = new Database(getSessionsDbPath());
  seed.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, short_id TEXT NOT NULL, agent TEXT NOT NULL, origin TEXT DEFAULT 'cli',
      routine_name TEXT, routine_run_id TEXT, version TEXT, account TEXT, timestamp TEXT NOT NULL,
      last_activity TEXT, project TEXT, cwd TEXT, git_branch TEXT, topic TEXT, label TEXT,
      message_count INTEGER, token_count INTEGER, output_tokens INTEGER, cost_usd REAL, duration_ms INTEGER,
      file_path TEXT NOT NULL, file_mtime_ms INTEGER, file_size INTEGER, scanned_at INTEGER,
      is_team_origin INTEGER DEFAULT 0, pr_url TEXT, pr_number INTEGER, worktree_slug TEXT, ticket_id TEXT, plan TEXT
    );
    CREATE VIRTUAL TABLE session_text USING fts5(session_id UNINDEXED, label, topic, project, content);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE scan_ledger (
      file_path TEXT PRIMARY KEY, file_mtime_ms INTEGER NOT NULL, file_size INTEGER NOT NULL,
      scanned_at INTEGER NOT NULL, parser_state TEXT, content_text TEXT
    );
    CREATE TABLE dir_ledger (
      dir_path TEXT PRIMARY KEY, dir_mtime_ms INTEGER NOT NULL, entry_count INTEGER NOT NULL, scanned_at INTEGER NOT NULL
    );
    INSERT INTO meta(key, value) VALUES ('schema_version', '16');
    INSERT INTO scan_ledger VALUES ('/cold/session.jsonl', 1, 2, 3, NULL, NULL);
    INSERT INTO dir_ledger VALUES ('/cold', 1, 1, 3);
  `);
  seed.close();
}

const { getDB } = await import('./db.js');

describe('schema migration v16 -> v17', () => {
  it('invalidates both ledgers so cold directories are walked and backfilled', () => {
    const db = getDB();
    expect((db.prepare(`SELECT COUNT(*) AS c FROM scan_ledger`).get() as { c: number }).c).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM dir_ledger`).get() as { c: number }).c).toBe(0);
  });
});
