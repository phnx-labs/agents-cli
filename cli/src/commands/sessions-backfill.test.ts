import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-sessions-backfill-'));
process.env.HOME = TEST_HOME;

const { closeDB, getDB, upsertSession } = await import('../lib/session/db.js');
const { discoverSessions } = await import('../lib/session/discover.js');
const { backfillToolsLocal, runToolsBackfill } = await import('./sessions-backfill.js');
type SessionMeta = import('../lib/session/types.js').SessionMeta;

afterAll(() => {
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('sessions backfill tools', () => {
  it('populates historical rows once and resumes as an idempotent no-op', async () => {
    const filePath = path.join(TEST_HOME, '.codex', 'sessions', '2026', '08', '03', 'backfill.jsonl');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, [
      { timestamp: '2026-08-03T00:00:00Z', type: 'response_item', payload: {
        type: 'function_call', name: 'exec_command', call_id: 'backfill-call',
        arguments: JSON.stringify({ cmd: 'git status; git diff' }),
      } },
      { timestamp: '2026-08-03T00:00:01Z', type: 'response_item', payload: {
        type: 'function_call_output', call_id: 'backfill-call', output: 'clean',
      } },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    upsertSession({
      id: 'backfill-session', shortId: 'backfill', agent: 'codex',
      timestamp: '2026-08-03T00:00:00Z', filePath,
    } as SessionMeta, 'backfill tools');
    await discoverSessions({ agent: 'codex', all: true, unbounded: true, includeUnmanaged: true });
    getDB().exec(`
      DELETE FROM tool_program_occurrences;
      DELETE FROM tool_call_programs;
      DELETE FROM tool_call_text;
      DELETE FROM tool_calls;
      DELETE FROM tool_scan_ledger;
    `);

    const first = await runToolsBackfill({ local: true, unmanaged: true, agent: 'codex' });
    expect(first).toMatchObject({ complete: true, machines: [{ indexedFiles: 1, indexedCalls: 1 }] });
    expect(getDB().prepare(`
      SELECT occurrence_ordinal, program FROM tool_program_occurrences ORDER BY occurrence_ordinal
    `).all()).toEqual([
      { occurrence_ordinal: 0, program: 'git' },
      { occurrence_ordinal: 1, program: 'git' },
    ]);

    const second = await runToolsBackfill({ local: true, unmanaged: true, agent: 'codex' });
    expect(second).toMatchObject({ complete: true, machines: [{ indexedFiles: 0, indexedCalls: 0 }] });
  });

  it('keeps a remote-style invocation to one bounded batch', async () => {
    for (let index = 0; index < 30; index++) {
      const id = `batch-session-${index}`;
      const filePath = path.join(TEST_HOME, '.codex', 'sessions', '2026', '08', '03', `${id}.jsonl`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({
        timestamp: '2026-08-03T00:00:00Z', type: 'response_item', payload: {
          type: 'function_call', name: 'exec_command', call_id: `${id}-call`,
          arguments: JSON.stringify({ cmd: 'git status' }),
        },
      }) + '\n');
      upsertSession({
        id, shortId: id.slice(0, 8), agent: 'codex',
        timestamp: '2026-08-03T00:00:00Z', filePath,
      } as SessionMeta, id);
    }
    await discoverSessions({ agent: 'codex', all: true, unbounded: true, includeUnmanaged: true });
    getDB().exec(`
      DELETE FROM tool_program_occurrences;
      DELETE FROM tool_call_programs;
      DELETE FROM tool_call_text;
      DELETE FROM tool_calls;
      DELETE FROM tool_scan_ledger;
    `);

    const first = await backfillToolsLocal({ local: true, unmanaged: true, agent: 'codex' }, true);
    expect(first.indexedFiles).toBe(25);
    expect(first.coverage.complete).toBe(false);
    const second = await runToolsBackfill({ local: true, unmanaged: true, agent: 'codex' });
    expect(second.complete).toBe(true);
    expect(second.machines[0].indexedFiles).toBeGreaterThan(0);
  });
});
