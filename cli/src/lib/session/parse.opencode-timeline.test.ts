import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// parse.ts resolves nothing from HOME, but db.ts does at import time, so keep the
// same throwaway-HOME discipline the other OpenCode suites use. Real sqlite, a
// real opencode.db, no mocking.
const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-opencode-timeline-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const OPENCODE_DB = path.join(tmpHome, '.local', 'share', 'opencode', 'opencode.db');
const SESSION_ID = 'ses_timeline0000000000000000';
const T0 = Date.UTC(2026, 8, 6, 0, 0, 0);

let parseOpenCode: typeof import('./parse.js').parseOpenCode;

beforeAll(async () => {
  ({ parseOpenCode } = await import('./parse.js'));
  const Database = (await import('../sqlite.js')).default;
  fs.mkdirSync(path.dirname(OPENCODE_DB), { recursive: true });
  const oc = new (Database as any)(OPENCODE_DB);
  oc.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, version TEXT,
      cost REAL, model TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
  `);
  oc.prepare(`INSERT INTO session (id, parent_id, title, directory, version, cost, model, time_created, time_updated)
              VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`)
    .run(SESSION_ID, 'timeline session', path.join(tmpHome, 'repo'), '1.16.0', 0, JSON.stringify({ id: 'claude-x' }), T0, T0 + 10);
  oc.prepare('INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)')
    .run(`${SESSION_ID}-m0`, SESSION_ID, JSON.stringify({ role: 'assistant' }), T0);

  const part = (id: string, data: unknown, at: number): void => {
    oc.prepare('INSERT INTO part (id, message_id, session_id, data, time_created) VALUES (?, ?, ?, ?, ?)')
      .run(id, `${SESSION_ID}-m0`, SESSION_ID, JSON.stringify(data), at);
  };
  // A call whose label lives in `state.title` (OpenCode's rendered label).
  part('p0', { type: 'tool', tool: 'read', callID: 'c0',
    state: { status: 'completed', title: 'Read src/index.ts', input: { filePath: '/repo/src/index.ts' }, output: 'ok' } }, T0);
  // A call whose label lives in `state.input.description` — that one wins.
  part('p1', { type: 'tool', tool: 'bash', callID: 'c1',
    state: { status: 'completed', title: 'shell', input: { command: 'bun run build', description: 'Build the CLI' }, output: 'ok' } }, T0 + 1);
  // A call with neither.
  part('p2', { type: 'tool', tool: 'glob', callID: 'c2',
    state: { status: 'completed', input: { pattern: '**/*.ts' }, output: 'ok' } }, T0 + 2);
  part('p3', { type: 'patch', files: ['/repo/src/index.ts', '/repo/README.md'] }, T0 + 3);
  part('p4', { type: 'compaction', summary: 'condensed history' }, T0 + 4);
  oc.close();
});

afterAll(() => {
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  if (REAL_USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = REAL_USERPROFILE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('OpenCode: labels, the patch ledger, and compaction (PHNX-3939)', () => {
  it('prefers the input description, falls back to the rendered title, and omits neither-case', () => {
    const events = parseOpenCode(`${OPENCODE_DB}#${SESSION_ID}`);
    const calls = events.filter((e) => e.type === 'tool_use');
    expect(calls.find((c) => c.callId === 'c0')?.label).toBe('Read src/index.ts');
    expect(calls.find((c) => c.callId === 'c1')?.label).toBe('Build the CLI');
    expect(calls.find((c) => c.callId === 'c2')?.label).toBeUndefined();
  });

  it('reads the patch part as the harness file ledger', () => {
    const events = parseOpenCode(`${OPENCODE_DB}#${SESSION_ID}`);
    expect(events.find((e) => e.type === 'file_change')).toMatchObject({
      changes: [{ path: '/repo/src/index.ts', op: 'modified' }, { path: '/repo/README.md', op: 'modified' }],
    });
  });

  it('reads a compaction part as a compaction hook', () => {
    const events = parseOpenCode(`${OPENCODE_DB}#${SESSION_ID}`);
    expect(events.find((e) => e.type === 'hook')).toMatchObject({ hookName: 'ContextCompaction' });
  });
});
