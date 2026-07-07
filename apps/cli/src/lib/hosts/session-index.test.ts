import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hostSessionMeta, registerHostSession } from './session-index.js';
import { findSessionsById, querySessions, closeDB } from '../session/db.js';
import type { HostTask } from './tasks.js';

// Isolate the sessions DB under a temp HOME. db.js reads its base dir lazily
// (at getDB() time), so setting HOME here — before any test calls getDB — is
// enough. Use STATIC imports, matching session/__tests__/db.test.ts: a dynamic
// `await import()` of the native better-sqlite3 addon mis-binds named params
// under bun (every insert lands NULLs → NOT NULL constraint failures).
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-hostsession-'));
process.env.HOME = TEST_HOME;

function task(overrides: Partial<HostTask> = {}): HostTask {
  return {
    id: 'deadbeef',
    host: 'box',
    target: 'user@box',
    agent: 'claude',
    prompt: 'first line\nsecond line',
    sessionId: '11111111-2222-3333-4444-555555555555',
    remoteLog: '/r/deadbeef.log',
    remoteExit: '/r/deadbeef.exit',
    status: 'running',
    createdAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  };
}

describe('hostSessionMeta', () => {
  it('builds a session row with an empty file_path (remote transcript) and a host label', () => {
    const meta = hostSessionMeta(task(), { cwd: '/home/me/proj', prompt: 'first line\nsecond line' });
    expect(meta).not.toBeNull();
    expect(meta!.id).toBe('11111111-2222-3333-4444-555555555555');
    expect(meta!.shortId).toBe('11111111');
    expect(meta!.agent).toBe('claude');
    expect(meta!.cwd).toBe('/home/me/proj');
    expect(meta!.filePath).toBe(''); // sentinel: remote-only, survives the stale-file filter
    expect(meta!.label).toBe('[host/box]');
    expect(meta!.topic).toBe('first line');
  });

  it('returns null when the run captured no session id (nothing to key on)', () => {
    expect(hostSessionMeta(task({ sessionId: undefined }), { cwd: '/x', prompt: 'p' })).toBeNull();
  });

  it('returns null for an agent that is not a known session agent', () => {
    expect(hostSessionMeta(task({ agent: 'nonsense' }), { cwd: '/x', prompt: 'p' })).toBeNull();
  });
});

describe('registerHostSession', () => {
  it('registers a host run that is then resolvable by id despite having no local transcript', () => {
    const t = task({ id: 'cafe0001', sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    registerHostSession(t, { cwd: '/home/me/proj', prompt: 'do the work' });

    const byId = findSessionsById('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(byId).toHaveLength(1);
    expect(byId[0].label).toBe('[host/box]');
    expect(byId[0].filePath).toBe('');

    // The empty-file_path row survives the querySessions stale-file filter — a
    // real local session with a missing file would be dropped here.
    const all = querySessions({ idPrefix: 'aaaaaaaa' });
    expect(all).toHaveLength(1);

    closeDB();
  });
});
