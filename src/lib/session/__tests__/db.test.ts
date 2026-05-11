import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { TEST_HOME } = vi.hoisted(() => {
  const nodeOs = require('os');
  const nodeFs = require('fs');
  const nodePath = require('path');
  const testHome = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'agents-cli-db-test-'));
  // Set before state.ts loads so its module-level HOME constant picks up the override.
  process.env.HOME = testHome;
  return { TEST_HOME: testHome };
});

// Import AFTER the mock so db.ts captures TEST_HOME as its base dir.
const { getDB, getDBPath, querySessions, closeDB } = await import('../db.js');

function seed(id: string, version: string | null, timestamp: string): void {
  const db = getDB();
  db.prepare(`
    INSERT INTO sessions (
      id, short_id, agent, version, timestamp, project, cwd,
      file_path, file_mtime_ms, file_size, scanned_at, is_team_origin
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    id,
    id.slice(0, 8),
    'claude',
    version,
    timestamp,
    'agents-cli',
    '/tmp/test',
    `/tmp/test/${id}.jsonl`,
    0,
    0,
    0,
  );
}

describe('querySessions version filter', () => {
  beforeAll(() => {
    seed('s1-older', '2.1.111', '2026-04-19T10:00:00.000Z');
    seed('s2-newer', '2.1.112', '2026-04-19T11:00:00.000Z');
    seed('s3-same',  '2.1.112', '2026-04-19T12:00:00.000Z');
    seed('s4-null',  null,      '2026-04-19T13:00:00.000Z');
  });

  afterAll(() => {
    closeDB();
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('returns only sessions matching the requested version', () => {
    const rows = querySessions({ version: '2.1.112' });
    expect(rows.map(r => r.id).sort()).toEqual(['s2-newer', 's3-same']);
  });

  it('stores the sessions database under ~/.agents/.history/sessions', () => {
    expect(getDBPath()).toBe(path.join(TEST_HOME, '.agents', '.history', 'sessions', 'sessions.db'));
  });

  it('returns no sessions for an unknown version', () => {
    const rows = querySessions({ version: '99.99.99' });
    expect(rows).toEqual([]);
  });

  it('returns all sessions when version is omitted', () => {
    const rows = querySessions({});
    expect(rows.map(r => r.id).sort()).toEqual(['s1-older', 's2-newer', 's3-same', 's4-null']);
  });

  it('filters by version even when agent is also set', () => {
    const rows = querySessions({ agent: 'claude', version: '2.1.111' });
    expect(rows.map(r => r.id)).toEqual(['s1-older']);
  });
});
