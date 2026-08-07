import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// db.ts + discover.ts capture their paths from HOME at import time, so point HOME
// at a throwaway dir BEFORE importing. Real fs, real sqlite, a synthetic
// opencode.db — no mocking.
//
// Two regressions this pins, both found on a real opencode.db after RUSH-2358
// shipped:
//   1. The tool-part read truncated only `state.output`, which bounds nothing —
//      the largest real part was 1,346,068 bytes of which `state.attachments`
//      (a base64 data URL from `read`) was 1,345,674 and `state.output` was 23.
//   2. `json_extract` raises "malformed JSON" on a non-JSON value and aborts the
//      WHOLE query, so one unparseable `part`/`message` row dropped EVERY
//      OpenCode session from the index — silently in a non-TTY run.
const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-opencode-robust-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const OPENCODE_DB = path.join(tmpHome, '.local', 'share', 'opencode', 'opencode.db');
const CWD = path.join(tmpHome, 'repo');
const READ_FILE = path.join(CWD, 'src', 'huge-image-holder.ts');
const EDIT_FILE = path.join(CWD, 'src', 'edited.ts');

type Discover = typeof import('./discover.js');
type DB = typeof import('./db.js');
type Parse = typeof import('./parse.js');
type Sqlite = typeof import('../sqlite.js');
let discover: Discover;
let db: DB;
let parse: Parse;
let Database: Sqlite['default'];

const SESSION_ID = 'ses_robust00000000000000000';
const T0 = Date.UTC(2026, 7, 2, 0, 0, 0);
const T1 = T0 + 9000;

/** A base64-ish data URL of the shape `read` attaches for an image. */
const HUGE_ATTACHMENT = `data:image/png;base64,${'A'.repeat(1_000_000)}`;
const BIG_STRING = 'X'.repeat(20_000);

beforeAll(async () => {
  db = await import('./db.js');
  discover = await import('./discover.js');
  parse = await import('./parse.js');
  Database = (await import('../sqlite.js')).default;

  fs.mkdirSync(path.dirname(OPENCODE_DB), { recursive: true });
  const oc = new (Database as any)(OPENCODE_DB);
  oc.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, version TEXT,
      cost REAL, model TEXT, time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
    CREATE TABLE todo (session_id TEXT, content TEXT, status TEXT, priority TEXT, position INTEGER, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE control_account (email TEXT, active INTEGER);
  `);

  oc.prepare(
    `INSERT INTO session (id, parent_id, title, directory, version, cost, model, time_created, time_updated)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(SESSION_ID, 'robustness', CWD, '1.16.0', 0.5,
        JSON.stringify({ id: 'big-pickle', providerID: 'opencode' }), T0, T1);

  const insMsg = oc.prepare('INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)');
  const insPart = oc.prepare('INSERT INTO part (id, message_id, session_id, data, time_created) VALUES (?, ?, ?, ?, ?)');

  insMsg.run(`${SESSION_ID}-m0`, SESSION_ID,
    JSON.stringify({ role: 'assistant', tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 200, write: 5 } } }), T0);

  // (1) A `read` whose weight is entirely in `state.attachments`, not `state.output`.
  insPart.run(`${SESSION_ID}-p0`, `${SESSION_ID}-m0`, SESSION_ID,
    JSON.stringify({
      type: 'tool', tool: 'read', callID: 'c0',
      state: {
        status: 'completed',
        input: { filePath: READ_FILE },
        output: 'read 1 image',
        attachments: [{ url: HUGE_ATTACHMENT, mime: 'image/png' }],
      },
    }), T0);

  // (2) An `edit` whose weight is in `state.input` (old/new strings).
  insPart.run(`${SESSION_ID}-p1`, `${SESSION_ID}-m0`, SESSION_ID,
    JSON.stringify({
      type: 'tool', tool: 'edit', callID: 'c1',
      state: { status: 'completed', input: { filePath: EDIT_FILE, oldString: BIG_STRING, newString: BIG_STRING }, output: 'ok' },
    }), T0 + 1);

  // (3) Poisoned rows: a non-JSON part and a non-JSON message in the SAME shared DB.
  insPart.run(`${SESSION_ID}-p2`, `${SESSION_ID}-m0`, SESSION_ID, 'not json at all', T0 + 2);
  insMsg.run(`${SESSION_ID}-m1`, SESSION_ID, '<<< truncated write >>>', T0 + 3);

  oc.close();

  await discover.discoverSessions({ agent: 'opencode', all: true });
});

afterAll(() => {
  try { db.closeDB?.(); } catch { /* ignore */ }
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  if (REAL_USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = REAL_USERPROFILE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('OpenCode scan survives a malformed row (RUSH-2358 follow-up)', () => {
  it('still indexes the session when a part and a message hold non-JSON', () => {
    const s = db.getSessionById(SESSION_ID);
    expect(s).toBeTruthy();
    // Pre-fix, the unguarded json_extract aggregate threw "malformed JSON" and
    // the whole scan was swallowed, leaving ZERO OpenCode rows indexed.
    expect(s!.model).toBe('big-pickle');
    expect(s!.durationMs).toBe(9000);
  });

  it('counts only the valid tool parts, ignoring the poisoned row', () => {
    const s = db.getSessionById(SESSION_ID);
    expect(s!.toolCallCount).toBe(2);
  });

  it('still aggregates tokens across the valid messages', () => {
    const s = db.getSessionById(SESSION_ID);
    expect(s!.inputTokens).toBe(100);
    expect(s!.outputTokens).toBe(50);
    expect(s!.cacheReadTokens).toBe(200);
    expect(s!.cacheWriteTokens).toBe(5);
    expect(s!.tokenCount).toBe(355); // 100+50+0+200+5
  });
});

describe('OpenCode tool-part read stays bounded (RUSH-2358 follow-up)', () => {
  const parsed = () => parse.parseOpenCode(`${OPENCODE_DB}#${SESSION_ID}`);

  it('does not load a huge state.attachments payload into the events', () => {
    const events = parsed();
    const serialized = JSON.stringify(events);
    // The DB row alone is >1 MB. Truncating only `state.output` left it whole.
    expect(serialized.length).toBeLessThan(50_000);
    expect(serialized).not.toContain('data:image/png;base64');
  });

  it('keeps the addressing fields the enrichment needs, for both tools', () => {
    const events = parsed();
    const toolUses = events.filter(e => e.type === 'tool_use') as Array<any>;
    expect(toolUses.map(e => e.tool)).toEqual(expect.arrayContaining(['read', 'edit']));
    // `read` keeps its filePath even though the part was 1 MB.
    expect(toolUses.find(e => e.tool === 'read')?.path).toBe(READ_FILE);
    // `edit`'s oversized input collapses to its addressing fields — filePath survives.
    expect(toolUses.find(e => e.tool === 'edit')?.path).toBe(EDIT_FILE);
    expect(JSON.stringify(toolUses.find(e => e.tool === 'edit')?.args)).not.toContain(BIG_STRING);
  });

  it('drops the non-JSON part without losing the rest of the transcript', () => {
    const events = parsed();
    expect(events.length).toBeGreaterThan(0);
    expect(events.some(e => e.type === 'tool_use')).toBe(true);
  });
});
