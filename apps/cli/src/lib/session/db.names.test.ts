import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate the sessions DB under a temp HOME before db.js/state.js capture the
// path at import time.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-dbnames-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { upsertSession, syncNames, ftsSearch, getSessionById } = await import('./db.js');
type SessionMeta = import('./types.js').SessionMeta;

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    shortId: id.slice(0, 8),
    agent: 'claude',
    timestamp: new Date().toISOString(),
    filePath: '',
    ...extra,
  };
}

describe('run-name resolution in the session index', () => {
  it('resolves `agents sessions <name>` to the run, exact match ranked top', () => {
    upsertSession(meta('run-alpha'), '');
    upsertSession(meta('run-beta'), '');
    // Name applied by id via the idempotent sync path (mirrors label sync).
    syncNames(new Map([['run-alpha', 'fix-bug'], ['run-beta', 'other']]));

    const hits = ftsSearch('fix-bug');
    expect(hits[0]?.sessionId).toBe('run-alpha');
    expect(hits[0]?.score).toBe(1_000_000);
    // The name is persisted on the row, readable back.
    expect(getSessionById('run-alpha')?.name).toBe('fix-bug');
  });

  it('matches a name by prefix below an exact match', () => {
    upsertSession(meta('run-gamma'), '');
    syncNames(new Map([['run-gamma', 'nightly-audit']]));
    const hits = ftsSearch('nightly');
    const hit = hits.find(h => h.sessionId === 'run-gamma');
    expect(hit?.score).toBe(900_000);
  });

  it('accepts a name set directly at upsert (host-run path) without a sync pass', () => {
    upsertSession(meta('run-host', { name: 'remote-audit', label: '[host/box]' }), '');
    expect(getSessionById('run-host')?.name).toBe('remote-audit');
    expect(ftsSearch('remote-audit')[0]?.sessionId).toBe('run-host');
    // The /rename label channel still resolves independently of the name.
    expect(ftsSearch('[host/box]')[0]?.sessionId).toBe('run-host');
  });

  it('leaves unnamed runs resolvable by id only (no behavior change)', () => {
    upsertSession(meta('run-plain'), '');
    expect(getSessionById('run-plain')?.name).toBeUndefined();
    // A content/name search for a non-existent handle finds nothing spurious.
    expect(ftsSearch('run-plain').some(h => h.score >= 800_000)).toBe(false);
  });

  it('a discovery rescan never nulls an existing name', () => {
    // Load-bearing invariant: `name` is in the INSERT column list but deliberately
    // absent from the ON CONFLICT(id) DO UPDATE SET clause, so a later discovery
    // re-upsert (which carries no name) must PRESERVE the name already on the row.
    // If someone adds `name = excluded.name` to the SET clause this test fails.
    upsertSession(meta('run-persist', { name: 'keep-me' }), '');
    expect(getSessionById('run-persist')?.name).toBe('keep-me');
    // Re-upsert the same id as a bare rescan would — no name field.
    upsertSession(meta('run-persist'), 'rescanned preview');
    expect(getSessionById('run-persist')?.name).toBe('keep-me');
    expect(ftsSearch('keep-me')[0]?.sessionId).toBe('run-persist');
  });
});
