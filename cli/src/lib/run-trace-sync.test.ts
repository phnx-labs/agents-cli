import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { shouldAutoSyncTraces } from './run-trace-sync.js';

// Real files, no mocks: the gate reads the phoenix session + the traces-sync
// ledger off disk under getRuntimeStateDir(), which honors AGENTS_STATE_DIR. We
// point that at a fresh temp dir per test and toggle the two files that encode
// "signed in" and "has synced before".
const savedStateDir = process.env.AGENTS_STATE_DIR;
const savedNoSync = process.env.AGENTS_NO_TRACE_SYNC;
let dir: string;

function signIn() {
  fs.writeFileSync(path.join(dir, 'phoenix-session.json'), JSON.stringify({ access_token: 't' }));
}
function markSyncedBefore() {
  fs.writeFileSync(path.join(dir, 'traces-sync.json'), JSON.stringify({ lastSyncMtime: 1 }));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-sync-gate-'));
  process.env.AGENTS_STATE_DIR = dir;
  delete process.env.AGENTS_NO_TRACE_SYNC;
});

afterEach(() => {
  if (savedStateDir === undefined) delete process.env.AGENTS_STATE_DIR;
  else process.env.AGENTS_STATE_DIR = savedStateDir;
  if (savedNoSync === undefined) delete process.env.AGENTS_NO_TRACE_SYNC;
  else process.env.AGENTS_NO_TRACE_SYNC = savedNoSync;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('shouldAutoSyncTraces — run-exit auto-sync policy (PHNX-3628)', () => {
  test('signed in AND already synced once → fires', () => {
    signIn();
    markSyncedBefore();
    expect(shouldAutoSyncTraces(false)).toBe(true);
  });

  test('never synced before → does NOT fire (never opted into the store)', () => {
    signIn(); // signed in, but no ledger
    expect(shouldAutoSyncTraces(false)).toBe(false);
  });

  test('not signed in → does NOT fire even if a stale ledger exists', () => {
    markSyncedBefore(); // ledger present, but no session
    expect(shouldAutoSyncTraces(false)).toBe(false);
  });

  test('--no-trace-sync (disabled=true) wins over an otherwise-eligible run', () => {
    signIn();
    markSyncedBefore();
    expect(shouldAutoSyncTraces(true)).toBe(false);
  });

  test('AGENTS_NO_TRACE_SYNC=1 wins over an otherwise-eligible run', () => {
    signIn();
    markSyncedBefore();
    process.env.AGENTS_NO_TRACE_SYNC = '1';
    expect(shouldAutoSyncTraces(false)).toBe(false);
  });
});
