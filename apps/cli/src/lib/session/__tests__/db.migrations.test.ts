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
