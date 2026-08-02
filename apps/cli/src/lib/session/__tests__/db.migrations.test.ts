import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Set HOME before db.js loads so its module-level DB path picks up the override.
// (Plain top-level statements run before the dynamic `await import` below.)
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-db-migrations-'));
process.env.HOME = TEST_HOME;

const { getDB, closeDB, upsertSession, getSessionById } = await import('../db.js');
type SessionMeta = import('../types.js').SessionMeta;

afterAll(() => {
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('empty-shortId repair migration (v16)', () => {
  it('heals a row the pre-fix parser left with an empty short_id', () => {
    // Reproduce the corruption: a bare-prefix id whose shortId stripped to ''.
    // upsertSession binds meta.shortId verbatim (deriveShortId lives in the
    // parsers, not here), so '' lands in the index exactly as the old code did.
    const corrupt = {
      id: 'session_',
      shortId: '',
      agent: 'rush',
      timestamp: '2026-07-31T20:00:00.000Z',
      filePath: '/tmp/gone/session_/messages.jsonl',
    } as SessionMeta;
    upsertSession(corrupt, 'hello bare prefix');
    expect(getSessionById('session_')?.shortId).toBe(''); // corruption reproduced

    // Simulate an un-migrated (pre-v16) DB and reopen so migrateSchema runs.
    const db = getDB();
    db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '15')`).run();
    closeDB();

    getDB(); // reopen -> currentVersion 15 < SCHEMA_VERSION -> v16 repair runs
    const healed = getSessionById('session_');
    expect(healed?.shortId).toBe('session_'); // substr(id,1,8), non-empty + addressable
    expect(healed?.shortId).not.toBe('');
  });
});

describe('model column migration (v20)', () => {
  it('adds the model column to a v19 index', () => {
    const db = getDB();
    db.exec(`ALTER TABLE sessions DROP COLUMN model`);
    db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '19')`).run();
    closeDB();

    const reopened = getDB();
    const cols = (reopened.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('model');
  });
});

describe('spawned_team column migration (v21)', () => {
  it('adds the spawned_team column to a v20 index', () => {
    const db = getDB();
    db.exec(`ALTER TABLE sessions DROP COLUMN spawned_team`);
    db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '20')`).run();
    closeDB();

    const reopened = getDB();
    const cols = (reopened.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('spawned_team');
  });

  it('clears BOTH ledgers so already-scanned dirs get re-parsed for the new column', () => {
    // scan_ledger alone is not enough: with dir_ledger intact,
    // collectChangedFilesInLeafDirs treats an unchanged dir's files as cold and
    // skips them, so their spawned_team would stay NULL forever.
    const db = getDB();
    db.prepare(
      `INSERT OR REPLACE INTO scan_ledger(file_path, file_mtime_ms, file_size, scanned_at) VALUES (?, ?, ?, ?)`
    ).run('/tmp/stale/session.jsonl', 1, 1, 1);
    db.prepare(
      `INSERT OR REPLACE INTO dir_ledger(dir_path, dir_mtime_ms, entry_count, scanned_at) VALUES (?, ?, ?, ?)`
    ).run('/tmp/stale', 1, 1, 1);
    db.exec(`ALTER TABLE sessions DROP COLUMN spawned_team`);
    db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '20')`).run();
    closeDB();

    const reopened = getDB();
    expect((reopened.prepare(`SELECT COUNT(*) AS n FROM scan_ledger`).get() as { n: number }).n).toBe(0);
    expect((reopened.prepare(`SELECT COUNT(*) AS n FROM dir_ledger`).get() as { n: number }).n).toBe(0);
  });
});

describe('spawned_team round-trip', () => {
  it('persists the team a session spawned and reads it back', () => {
    // Before this column existed the value was derived at scan time, set on the
    // meta, and then silently dropped by the writer — so every read came back
    // undefined. This pins the whole write -> read path.
    upsertSession(
      {
        id: 'orchestrator-1',
        shortId: 'orchestr',
        agent: 'claude',
        timestamp: '2026-08-01T10:00:00.000Z',
        filePath: '/tmp/orchestrator-1.jsonl',
        spawnedTeam: 'redesign',
      } as SessionMeta,
      'agents teams create redesign'
    );
    expect(getSessionById('orchestrator-1')?.spawnedTeam).toBe('redesign');
  });

  it('leaves spawnedTeam undefined for a session that spawned nothing', () => {
    upsertSession(
      {
        id: 'plain-1',
        shortId: 'plain-1a',
        agent: 'claude',
        timestamp: '2026-08-01T10:00:00.000Z',
        filePath: '/tmp/plain-1.jsonl',
      } as SessionMeta,
      'just a normal session'
    );
    expect(getSessionById('plain-1')?.spawnedTeam).toBeUndefined();
  });
});
