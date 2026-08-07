import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate the sessions DB under a temp HOME before db.js/state.js capture the
// path at import time.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-opencode-composite-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { upsertSession, querySessions, getSessionById } = await import('./db.js');
type SessionMeta = import('./types.js').SessionMeta;

// A composite OpenCode-shaped file_path: one shared SQLite container, an in-DB id.
function opencodeMeta(id: string, containerDbPath: string): SessionMeta {
  return {
    id,
    shortId: id.slice(0, 8),
    agent: 'opencode',
    timestamp: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    filePath: `${containerDbPath}#${id}`,
  };
}

describe('composite OpenCode file_path survives the staleness gate (RUSH-2357)', () => {
  it('keeps a composite row while its container DB exists, and prunes it once the DB is gone', () => {
    // A real on-disk container file whose basename carries no fragment.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-db-'));
    const dbPath = path.join(dir, 'opencode.db');
    fs.writeFileSync(dbPath, 'not a real sqlite file, just a container marker');

    const id = 'ses_02410a2c3ffeRumGfUNRgtB1Xk';
    upsertSession(opencodeMeta(id, dbPath), 'demo topic');

    // The composite basename ('opencode.db#ses_…') is never a directory entry, so
    // the pre-fix dirname/basename membership check pruned every OpenCode row here.
    // With the container-aware gate the row survives a real existence check.
    const live = querySessions({ agent: 'opencode' });
    expect(live.map(s => s.id)).toContain(id);
    // getSessionById is the by-id path and must resolve too.
    expect(getSessionById(id)?.id).toBe(id);

    // Delete the container: a composite row is stale ONLY when its container is gone.
    fs.rmSync(dbPath);
    const afterDelete = querySessions({ agent: 'opencode' });
    expect(afterDelete.map(s => s.id)).not.toContain(id);
  });

  it('prunes a composite row when the whole container directory is removed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-db-dir-'));
    const dbPath = path.join(dir, 'opencode.db');
    fs.writeFileSync(dbPath, 'container');

    const id = 'ses_11111111ffffRumGfUNRgtB1Xk';
    upsertSession(opencodeMeta(id, dbPath), 'topic');
    expect(querySessions({ agent: 'opencode' }).map(s => s.id)).toContain(id);

    // Removing the directory exercises the readdir-throws (catch) branch, which
    // falls back to a direct existsSync on the CONTAINER, not the composite string.
    fs.rmSync(dir, { recursive: true, force: true });
    expect(querySessions({ agent: 'opencode' }).map(s => s.id)).not.toContain(id);
  });
});
