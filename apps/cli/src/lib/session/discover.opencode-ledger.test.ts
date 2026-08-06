import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Count how many times `opencode.db` is OPENED. That is the cost RUSH-2210 is
// about: the whole-DB mtime stamp re-emitted every indexed session on any DB
// write, and upsertSessionsBatch's enrichment then re-opened this same file once
// per re-emitted entry (via parseSession -> parseOpenCode). Wrapping the shared
// sqlite shim is the honest way to measure it — the counter is a top-level const
// captured by the factory closure, matching discover.dir-ledger.test.ts (Bun's
// runner does not hoist vi.mock, so a plain const works in both runners).
const openCounter: { match: string | null; count: number } = { match: null, count: 0 };

vi.mock('../sqlite.js', async () => {
  const actual = await vi.importActual<typeof import('../sqlite.js')>('../sqlite.js');
  const Real = actual.default as any;
  class Counting extends Real {
    constructor(filename: string) {
      if (openCounter.match !== null && filename === openCounter.match) openCounter.count++;
      super(filename);
    }
  }
  return { ...actual, default: Counting };
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// db.ts + discover.ts resolve their paths from HOME at module-import time. Point
// HOME at a throwaway dir BEFORE importing so the suite runs against a clean,
// isolated sessions DB and a synthetic opencode.db (real fs, real sqlite).
const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-opencode-ledger-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const OPENCODE_DB = path.join(tmpHome, '.local', 'share', 'opencode', 'opencode.db');

type Discover = typeof import('./discover.js');
type DB = typeof import('./db.js');
type Sqlite = typeof import('../sqlite.js');

let discover: Discover;
let db: DB;
let Database: Sqlite['default'];

const SESSION_COUNT = 12;

/** Open the synthetic opencode.db directly (not counted — the counter is off). */
function openFixture() {
  return new (Database as any)(OPENCODE_DB);
}

/**
 * Build an opencode.db with the tables the scanner and parser read: `session`
 * (one row per session), `message`/`part` (the transcript parseOpenCode walks),
 * and `control_account` (the active account email).
 */
function seedFixture(): void {
  fs.mkdirSync(path.dirname(OPENCODE_DB), { recursive: true });
  const oc = openFixture();
  oc.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT,
      version TEXT, time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT, time_created INTEGER
    );
    CREATE TABLE control_account (email TEXT, active INTEGER);
    INSERT INTO control_account (email, active) VALUES ('dev@example.com', 1);
  `);

  const base = Date.UTC(2026, 6, 1);
  for (let i = 0; i < SESSION_COUNT; i++) {
    const id = `ses_fixture${String(i).padStart(2, '0')}`;
    const t = base + i * 60_000;
    oc.prepare(
      `INSERT INTO session (id, parent_id, title, directory, version, time_created, time_updated)
       VALUES (?, NULL, ?, ?, ?, ?, ?)`,
    ).run(id, `session ${i}`, path.join(tmpHome, 'proj'), '0.3.0', t, t);
    addMessage(oc, id, `${id}-m0`, t, `first turn of ${i}`);
  }
  oc.close();
}

/** Append one user message + its text part to a session. */
function addMessage(oc: any, sessionId: string, messageId: string, ts: number, text: string): void {
  oc.prepare(`INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)`)
    .run(messageId, sessionId, JSON.stringify({ role: 'user' }), ts);
  oc.prepare(`INSERT INTO part (id, message_id, session_id, data, time_created) VALUES (?, ?, ?, ?, ?)`)
    .run(`${messageId}-p0`, messageId, sessionId, JSON.stringify({ type: 'text', text }), ts);
}

/**
 * Write to the shared DB the way OpenCode does: append a turn to ONE session and
 * move that row's `time_updated`. Every other session row is untouched, but the
 * DB file's own mtime/size moves — the exact shape that used to re-emit all of
 * them.
 */
function appendTurnTo(sessionId: string, ts: number, text: string): void {
  const oc = openFixture();
  addMessage(oc, sessionId, `${sessionId}-m-${ts}`, ts, text);
  oc.prepare(`UPDATE session SET time_updated = ? WHERE id = ?`).run(ts, sessionId);
  oc.close();
  bumpDbMtime(ts);
}

/** Force the DB file's mtime forward so the whole-DB short-circuit sees a delta. */
function bumpDbMtime(ts: number): void {
  const secs = Math.floor(ts / 1000);
  fs.utimesSync(OPENCODE_DB, secs, secs);
}

// `skipExistenceCheck` because an OpenCode filePath is `opencode.db#<id>` — a
// row address inside the shared DB, not a file `fs.existsSync` can stat.
async function scan() {
  return discover.discoverSessions({ agent: 'opencode', all: true, skipExistenceCheck: true });
}

beforeAll(async () => {
  Database = (await import('../sqlite.js')).default;
  db = await import('./db.js');
  discover = await import('./discover.js');
  db.getDB(); // create schema
  seedFixture();
});

beforeEach(() => {
  openCounter.match = null;
  openCounter.count = 0;
});

afterAll(() => {
  // Close before removing the tree: Windows refuses to unlink an open file, so a
  // leaked connection (plus its WAL sidecars) fails the whole suite there.
  db.closeDB();
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  if (REAL_USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = REAL_USERPROFILE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('OpenCode per-session scan ledger (RUSH-2210)', () => {
  it('indexes every session on the first scan', async () => {
    const sessions = await scan();
    expect(sessions.length).toBe(SESSION_COUNT);
    expect(sessions.every(s => s.agent === 'opencode')).toBe(true);
    expect(sessions.every(s => s.account === 'dev@example.com')).toBe(true);
  });

  it('re-emits ONLY the changed session when the shared DB is written', async () => {
    const target = 'ses_fixture03';
    const before = (await scan()).find(s => s.id === target)!;
    expect(before.messageCount).toBe(1);

    appendTurnTo(target, Date.UTC(2026, 6, 2), 'second turn');

    openCounter.match = OPENCODE_DB;
    openCounter.count = 0;
    const after = await scan();

    // The changed row is re-parsed and its new message count lands...
    expect(after.find(s => s.id === target)!.messageCount).toBe(2);
    // ...every other session still surfaces (skipped, not dropped)...
    expect(after.length).toBe(SESSION_COUNT);
    // ...and the DB was opened a handful of times, not once per indexed session.
    // Pre-fix this was 1 (the scan) + SESSION_COUNT (one enrichment parse per
    // re-emitted entry); now it is the scan handle plus the single changed row.
    expect(openCounter.count).toBeLessThanOrEqual(3);
    expect(openCounter.count).toBeLessThan(SESSION_COUNT);
  });

  it('emits nothing when the DB file changes but no session row does', async () => {
    await scan();

    // A write that moves the file's stat without touching any session row —
    // e.g. OpenCode updating its own bookkeeping tables.
    const oc = openFixture();
    oc.prepare(`UPDATE control_account SET active = 1`).run();
    oc.close();
    bumpDbMtime(Date.UTC(2026, 6, 3));

    openCounter.match = OPENCODE_DB;
    openCounter.count = 0;
    const after = await scan();

    expect(after.length).toBe(SESSION_COUNT);
    // Exactly one open: the scan's own handle. No session was re-emitted, so no
    // enrichment parse re-opened the file.
    expect(openCounter.count).toBe(1);
  });

  it('short-circuits entirely when the DB file itself is unchanged', async () => {
    await scan();

    openCounter.match = OPENCODE_DB;
    openCounter.count = 0;
    const after = await scan();

    expect(after.length).toBe(SESSION_COUNT);
    expect(openCounter.count).toBe(0);
  });
});
