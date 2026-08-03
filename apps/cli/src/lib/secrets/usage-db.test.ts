/**
 * Tests for the value-free secrets usage read-model.
 *
 * Real path, no mocking: a real SQLite DB at a temp path (AGENTS_SECRETS_DB),
 * exercising the actual insert/rollup queries the `view` / `list` / `activity`
 * surfaces read. The recording is normally gated off in tests by the setup's
 * AGENTS_NO_USAGE_TRACK=1, so each test that records first clears it and
 * restores it afterward, and repoints the DB to a fork-private temp file.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  recordSecretUsage,
  getBundleUsage,
  getAllBundleUsage,
  getUsageHistory,
  closeSecretsUsageDb,
} from './usage-db.js';

const tmpDirs: string[] = [];
let prevNoTrack: string | undefined;
let prevDbPath: string | undefined;

function pinDb(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-usage-db-'));
  tmpDirs.push(d);
  const dbPath = path.join(d, 'usage.db');
  process.env.AGENTS_USAGE_DB = dbPath;
  process.env.AGENTS_SECRETS_DB = path.join(d, 'secrets-legacy.db');
  return dbPath;
}

beforeEach(() => {
  prevNoTrack = process.env.AGENTS_NO_USAGE_TRACK;
  prevDbPath = process.env.AGENTS_USAGE_DB;
  delete process.env.AGENTS_NO_USAGE_TRACK;
  closeSecretsUsageDb();
  pinDb();
});

afterEach(() => {
  closeSecretsUsageDb();
  if (prevNoTrack === undefined) delete process.env.AGENTS_NO_USAGE_TRACK;
  else process.env.AGENTS_NO_USAGE_TRACK = prevNoTrack;
  if (prevDbPath === undefined) delete process.env.AGENTS_USAGE_DB;
  else process.env.AGENTS_USAGE_DB = prevDbPath;
  delete process.env.AGENTS_SECRETS_DB;
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
  tmpDirs.length = 0;
});

describe('recordSecretUsage / getBundleUsage', () => {
  it('rolls up per-kind counts, recency, total, and first/last across kinds', () => {
    recordSecretUsage({ bundle: 'prod', event: 'create' });
    recordSecretUsage({ bundle: 'prod', event: 'import', keyCount: 3 });
    recordSecretUsage({ bundle: 'prod', event: 'access' });
    recordSecretUsage({ bundle: 'prod', event: 'access' });
    recordSecretUsage({ bundle: 'prod', event: 'export', keyCount: 3 });

    const s = getBundleUsage('prod');
    expect(s).toBeDefined();
    expect(s!.total).toBe(5);
    expect(s!.events.access.count).toBe(2);
    expect(s!.events.create.count).toBe(1);
    expect(s!.events.import.count).toBe(1);
    expect(s!.events.export.count).toBe(1);
    expect(s!.events.unlock.count).toBe(0);
    expect(s!.events.view.count).toBe(0);
    // Recency is populated for kinds that occurred, null for those that didn't.
    expect(s!.events.access.last).not.toBeNull();
    expect(s!.events.unlock.last).toBeNull();
    expect(s!.lastUsedAt).not.toBeNull();
    expect(s!.firstUsedAt).not.toBeNull();
  });

  it('attributes accesses per agent, most-first', () => {
    recordSecretUsage({ bundle: 'b', event: 'access', agent: 'claude' });
    recordSecretUsage({ bundle: 'b', event: 'access', agent: 'claude' });
    recordSecretUsage({ bundle: 'b', event: 'access', agent: 'codex' });

    const s = getBundleUsage('b');
    expect(s!.byAgent).toEqual([
      { agent: 'claude', count: 2 },
      { agent: 'codex', count: 1 },
    ]);
  });

  it('returns undefined for a bundle with no recorded events', () => {
    recordSecretUsage({ bundle: 'a', event: 'access' });
    expect(getBundleUsage('never-touched')).toBeUndefined();
  });

  it('ignores a row with an empty bundle name (usage is per-bundle)', () => {
    recordSecretUsage({ bundle: '', event: 'access' });
    expect(getAllBundleUsage().size).toBe(0);
  });

  it('honors AGENTS_NO_USAGE_TRACK — no row is written while it is set', () => {
    process.env.AGENTS_NO_USAGE_TRACK = '1';
    recordSecretUsage({ bundle: 'muted', event: 'access' });
    delete process.env.AGENTS_NO_USAGE_TRACK;
    expect(getBundleUsage('muted')).toBeUndefined();
  });
});

describe('getAllBundleUsage', () => {
  it('keys a summary per bundle for the list --sort surfaces', () => {
    recordSecretUsage({ bundle: 'a.com', event: 'access' });
    recordSecretUsage({ bundle: 'a.com', event: 'access' });
    recordSecretUsage({ bundle: 'b.app', event: 'access' });
    recordSecretUsage({ bundle: 'c.ai', event: 'create' }); // no access

    const all = getAllBundleUsage();
    expect(all.get('a.com')!.events.access.count).toBe(2);
    expect(all.get('b.app')!.events.access.count).toBe(1);
    // c.ai has an event (create) so it appears, with zero accesses.
    expect(all.get('c.ai')!.events.access.count).toBe(0);
    expect(all.get('c.ai')!.total).toBe(1);
  });
});

describe('getUsageHistory (timeline)', () => {
  it('returns newest-first, scoped to one bundle or across all', () => {
    recordSecretUsage({ bundle: 'x', event: 'create' });
    recordSecretUsage({ bundle: 'x', event: 'access', agent: 'claude', source: 'agent' });
    recordSecretUsage({ bundle: 'y', event: 'view', source: 'view' });

    const forX = getUsageHistory('x', 10);
    expect(forX).toHaveLength(2);
    // Newest first: the access was recorded after the create.
    expect(forX[0].event).toBe('access');
    expect(forX[0].agent).toBe('claude');
    expect(forX[1].event).toBe('create');

    const all = getUsageHistory(undefined, 10);
    expect(all.length).toBe(3);
    expect(new Set(all.map((e) => e.bundle))).toEqual(new Set(['x', 'y']));
  });

  it('caps at the requested limit', () => {
    for (let i = 0; i < 5; i++) recordSecretUsage({ bundle: 'z', event: 'access' });
    expect(getUsageHistory('z', 3)).toHaveLength(3);
  });

  it('never stores a value column — only metadata', () => {
    recordSecretUsage({ bundle: 'v', event: 'access', agent: 'claude', keyCount: 4 });
    const [row] = getUsageHistory('v', 1);
    expect(JSON.stringify(row)).not.toMatch(/value/);
    expect(row.keyCount).toBe(4);
    expect(row.agent).toBe('claude');
  });
});
