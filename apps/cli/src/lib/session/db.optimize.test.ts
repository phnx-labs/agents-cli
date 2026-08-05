/**
 * optimizeSessionSearchIndex — FTS5 `'optimize'` merges the segments the scanner
 * accumulates via delete+insert on every rescan, non-destructively. This is the
 * fix for sessions.db index bloat (tool_call_text_data ballooning to GBs of
 * unmerged segments for tens of MB of content, hanging `agents sessions`).
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Point the DB at a throwaway HOME before importing db.js (getDBPath reads HOME
// at module load), so this never touches a real ~/.agents/.history/sessions.db.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-optimize-'));
process.env.HOME = TEST_HOME;

const { closeDB, getDB, optimizeSessionSearchIndex } = await import('./db.js');

afterAll(() => {
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('optimizeSessionSearchIndex', () => {
  it('merges accumulated FTS5 segments and purges tombstones without losing content', () => {
    const db = getDB();
    const insert = db.prepare(
      `INSERT INTO tool_call_text(call_key, tool, input, output, error) VALUES (?, 'exec', ?, ?, '')`,
    );
    const del = db.prepare(`DELETE FROM tool_call_text WHERE call_key = ?`);

    // Each .run() is its own transaction -> a new FTS5 segment; the deletes
    // leave tombstones. This is exactly the scanner's delete+insert churn that
    // FTS5 never merges on its own.
    for (let i = 0; i < 200; i++) {
      insert.run(`k${i}`, `input ${i}`, `searchable body number ${i}`);
    }
    for (let i = 0; i < 100; i++) {
      del.run(`k${i}`);
    }

    const before = (db.prepare(`SELECT count(*) AS n FROM tool_call_text_data`).get() as { n: number }).n;
    const results = optimizeSessionSearchIndex();
    const tool = results.find((r) => r.table === 'tool_call_text');

    expect(tool).toBeDefined();
    expect(tool!.segmentsBefore).toBe(before);
    // optimize merges segments + purges the 100 deleted docs -> fewer %_data rows.
    expect(tool!.segmentsAfter).toBeLessThan(tool!.segmentsBefore);

    // Non-destructive: a surviving doc is still findable via FTS.
    const hit = db.prepare(
      `SELECT count(*) AS n FROM tool_call_text WHERE tool_call_text MATCH 'searchable'`,
    ).get() as { n: number };
    expect(hit.n).toBeGreaterThan(0);

    // session_text was optimized too (empty here) without error.
    expect(results.some((r) => r.table === 'session_text')).toBe(true);
  });
});
