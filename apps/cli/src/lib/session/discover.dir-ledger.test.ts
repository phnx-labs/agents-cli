import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// ESM module namespaces are non-configurable, so `vi.spyOn(fs, 'statSync')`
// throws "Cannot redefine property". The repo's established way to instrument
// fs (see src/commands/__tests__/sessions-tail.test.ts) is to replace the whole
// module with a wrapper that delegates to `node:fs` and hooks one method — here
// `statSync`, so we can count the per-file stats the dir_ledger short-circuit is
// supposed to elide. The counting state is a top-level const captured by the
// factory closure (Bun's runner does not hoist vi.mock; a plain const works in
// both runners without vi.hoisted).
const statCounter: { watchPath: string | null; count: number } = { watchPath: null, count: 0 };

vi.mock('fs', () => {
  const actual = require('node:fs') as typeof import('fs');
  return {
    ...actual,
    default: actual,
    statSync: ((p: fs.PathLike, ...rest: any[]) => {
      if (statCounter.watchPath !== null && typeof p === 'string' && p === statCounter.watchPath) {
        statCounter.count++;
      }
      return (actual.statSync as any)(p, ...rest);
    }) as typeof actual.statSync,
  };
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// db.ts + state.ts resolve their paths from HOME at module-import time. Point
// HOME at a throwaway dir BEFORE importing so the whole suite runs against a
// clean, isolated sqlite DB and session tree (real fs via node:fs, real sqlite,
// all under a temp HOME).
const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-dirledger-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

type Discover = typeof import('./discover.js');
type DB = typeof import('./db.js');

let discover: Discover;
let db: DB;

// The live Claude root (the only tree Claude appends to in place) and an
// immutable "backup-style" root under ~/.agents/.history/backups/claude/<ts>.
const LIVE_PROJECTS = path.join(tmpHome, '.claude', 'projects');
const BACKUP_PROJECTS = path.join(tmpHome, '.agents', '.history', 'backups', 'claude', '2026-01-01', 'projects');

function claudeLine(ts: string, cwd: string, text: string): string {
  return JSON.stringify({ type: 'user', timestamp: ts, cwd, message: { content: text } });
}

/** Write a Claude .jsonl transcript with one user turn. */
function writeSession(dir: string, id: string, ts: string, cwd: string, text: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(fp, claudeLine(ts, cwd, text) + '\n', 'utf-8');
  return fp;
}

async function discoverIds(): Promise<Set<string>> {
  const sessions = await discover.discoverSessions({ agent: 'claude', all: true });
  return new Set(sessions.map(s => s.id));
}

/** All Claude sessions (cwd-unfiltered) as SessionMeta. */
async function discoverAll() {
  return discover.discoverSessions({ agent: 'claude', all: true });
}

/** Bump a file's mtime a whole second into the future (deterministic ordering). */
function bumpMtime(fp: string, seconds: number): void {
  fs.utimesSync(fp, seconds, seconds);
}

beforeAll(async () => {
  db = await import('./db.js');
  discover = await import('./discover.js');
  db.getDB(); // create schema
});

afterEach(() => {
  statCounter.watchPath = null;
  statCounter.count = 0;
});

afterAll(() => {
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  if (REAL_USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = REAL_USERPROFILE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('dir_ledger short-circuit (A-2)', () => {
  it('T2: an unchanged backup dir does ZERO per-file stats on the second run', async () => {
    // Two sessions in the live root, one in an immutable backup dir.
    writeSession(path.join(LIVE_PROJECTS, '-proj-a'), 'live-1', '2026-07-01T00:00:00Z', '/proj/a', 'live one');
    writeSession(path.join(LIVE_PROJECTS, '-proj-b'), 'live-2', '2026-07-01T00:01:00Z', '/proj/b', 'live two');
    const backupFile = writeSession(path.join(BACKUP_PROJECTS, '-proj-c'), 'bkup-1', '2026-06-01T00:00:00Z', '/proj/c', 'backup one');

    const run1 = await discoverIds();
    expect(run1.has('live-1')).toBe(true);
    expect(run1.has('live-2')).toBe(true);
    expect(run1.has('bkup-1')).toBe(true);

    // Age the backup file's ledger stamp past the 10-minute hot window so it is
    // cold — a real immutable backup was last scanned long ago, not seconds
    // earlier. (A file scanned within HOT_FILE_WINDOW_MS is deliberately re-stat'd
    // even in an unchanged dir; T9 covers that path.) Only the backup file is
    // aged; the live-root files stay hot regardless.
    db.getDB().prepare('UPDATE scan_ledger SET scanned_at = ? WHERE file_path = ?')
      .run(Date.now() - 20 * 60_000, fs.realpathSync(backupFile));

    // Count per-file stats of the backup file on the second run.
    statCounter.watchPath = backupFile;
    statCounter.count = 0;

    const run2 = await discoverIds();

    // (a) the SAME session set surfaces both runs
    expect(run2).toEqual(run1);
    // (b) the unchanged backup dir's file is NEVER stat'd on the 2nd run — the
    //     dir_ledger match collapses it to a single dir stat, zero per-file stats.
    expect(statCounter.count).toBe(0);
  });

  it('T3: an in-place append under the live root is still caught (dir mtime unchanged)', async () => {
    const dir = path.join(LIVE_PROJECTS, '-append');
    const fp = writeSession(dir, 'append-1', '2026-07-02T00:00:00Z', '/proj/app', 'first turn');

    const before = (await discoverAll()).find(s => s.id === 'append-1');
    expect(before).toBeDefined();
    const countBefore = before!.messageCount;

    // Append a second user turn WITHOUT touching the parent dir (an in-place
    // append does not bump the dir's mtime). Advance the FILE mtime forward.
    fs.appendFileSync(fp, claudeLine('2026-07-02T00:05:00Z', '/proj/app', 'second turn') + '\n', 'utf-8');
    bumpMtime(fp, Math.floor(Date.now() / 1000) + 10);

    // Advance the clock past the 5s active-append debounce so the grown file is
    // parsed, not deferred.
    db.getDB().prepare('UPDATE scan_ledger SET scanned_at = 0').run();

    const after = (await discoverAll()).find(s => s.id === 'append-1');
    expect(after).toBeDefined();
    // The append was caught: message_count grew from 1 to 2.
    expect((after!.messageCount ?? 0)).toBeGreaterThan(countBefore ?? 0);
  });

  it('T4: the append debounce is preserved (grown live file NOT re-parsed within 5s)', async () => {
    const dir = path.join(LIVE_PROJECTS, '-debounce');
    const fp = writeSession(dir, 'debounce-1', '2026-07-03T00:00:00Z', '/proj/deb', 'only turn');

    const before = (await discoverAll()).find(s => s.id === 'debounce-1');
    const countBefore = before!.messageCount;

    // Append + bump the file mtime, but LEAVE scanned_at = now (fresh) so the
    // append lands inside the debounce window.
    fs.appendFileSync(fp, claudeLine('2026-07-03T00:01:00Z', '/proj/deb', 'sneaky turn') + '\n', 'utf-8');
    bumpMtime(fp, Math.floor(Date.now() / 1000) + 1);
    db.getDB().prepare('UPDATE scan_ledger SET scanned_at = ?').run(Date.now());

    const after = (await discoverAll()).find(s => s.id === 'debounce-1');
    // Within the debounce, the cached row is served — message_count unchanged.
    expect(after!.messageCount).toBe(countBefore);
  });

  it('T5: a NEW file dropped into a previously-unchanged dir surfaces (dir mtime+count bump)', async () => {
    const dir = path.join(LIVE_PROJECTS, '-newfile');
    writeSession(dir, 'new-a', '2026-07-04T00:00:00Z', '/proj/new', 'existing');
    let ids = await discoverIds();
    expect(ids.has('new-a')).toBe(true);
    expect(ids.has('new-b')).toBe(false);

    // Dropping a new file bumps the dir mtime + entry_count → dir treated as
    // changed → full re-walk → the new session surfaces.
    writeSession(dir, 'new-b', '2026-07-04T00:02:00Z', '/proj/new', 'brand new');
    ids = await discoverIds();
    expect(ids.has('new-b')).toBe(true);
  });

  it('T6: deleting a file drops the session (no crash)', async () => {
    const dir = path.join(LIVE_PROJECTS, '-delete');
    const fp = writeSession(dir, 'del-a', '2026-07-05T00:00:00Z', '/proj/del', 'to be deleted');
    let ids = await discoverIds();
    expect(ids.has('del-a')).toBe(true);

    fs.rmSync(fp);
    ids = await discoverIds();
    expect(ids.has('del-a')).toBe(false);
  });

  it('T7: renaming a file within a dir drops the old id and surfaces the new one', async () => {
    const dir = path.join(LIVE_PROJECTS, '-rename');
    const oldFp = writeSession(dir, 'ren-old', '2026-07-06T00:00:00Z', '/proj/ren', 'renamed');
    let ids = await discoverIds();
    expect(ids.has('ren-old')).toBe(true);

    // Rename the transcript file. The session id comes from the filename, so a
    // rename = old id drops, new id surfaces.
    fs.renameSync(oldFp, path.join(dir, 'ren-new.jsonl'));
    ids = await discoverIds();
    expect(ids.has('ren-old')).toBe(false);
    expect(ids.has('ren-new')).toBe(true);
  });

  it('T8: a cold/wiped ledger yields the identical session set', async () => {
    const before = await discoverIds();
    expect(before.size).toBeGreaterThan(0);

    db.getDB().prepare('DELETE FROM dir_ledger').run();
    db.getDB().prepare('DELETE FROM scan_ledger').run();

    const after = await discoverIds();
    expect(after).toEqual(before);
  });

  it('T9: a hot-window file OUTSIDE the live root, appended with dir mtime unchanged, is still re-stat\'d + updated', async () => {
    // Seed a session in the immutable backup root and scan it.
    const dir = path.join(BACKUP_PROJECTS, '-hot');
    const fp = writeSession(dir, 'hot-1', '2026-06-02T00:00:00Z', '/proj/hot', 'first');
    const before = (await discoverAll()).find(s => s.id === 'hot-1');
    expect(before).toBeDefined();
    const countBefore = before!.messageCount;

    // Append in place (dir mtime unchanged), bump the file mtime. Force the
    // ledger's scanned_at RECENT so the file is inside HOT_FILE_WINDOW_MS (it is
    // not a live-root file, so only the hot window keeps it eligible), but past
    // the 5s append debounce.
    fs.appendFileSync(fp, claudeLine('2026-06-02T00:05:00Z', '/proj/hot', 'grown') + '\n', 'utf-8');
    bumpMtime(fp, Math.floor(Date.now() / 1000) + 20);
    // scanned_at within the 10min hot window but older than the 5s debounce.
    db.getDB().prepare('UPDATE scan_ledger SET scanned_at = ?').run(Date.now() - 60_000);

    const after = (await discoverAll()).find(s => s.id === 'hot-1');
    expect((after!.messageCount ?? 0)).toBeGreaterThan(countBefore ?? 0);
  });

  it('kill-switch: AGENTS_SESSIONS_NO_DIR_LEDGER=1 forces the full walk (dir_ledger not consulted), identical results', async () => {
    // Fresh isolated backup file so we can watch its per-file stats.
    const dir = path.join(BACKUP_PROJECTS, '-killswitch');
    const backupFile = writeSession(dir, 'ks-1', '2026-06-03T00:00:00Z', '/proj/ks', 'kill switch');

    // Warm both ledgers.
    const warm = await discoverIds();
    expect(warm.has('ks-1')).toBe(true);

    const prevEnv = process.env.AGENTS_SESSIONS_NO_DIR_LEDGER;
    process.env.AGENTS_SESSIONS_NO_DIR_LEDGER = '1';
    statCounter.watchPath = backupFile;
    statCounter.count = 0;

    const withKill = await discoverIds();

    if (prevEnv === undefined) delete process.env.AGENTS_SESSIONS_NO_DIR_LEDGER;
    else process.env.AGENTS_SESSIONS_NO_DIR_LEDGER = prevEnv;

    // Full-walk path ran: the backup file WAS stat'd even though its dir was
    // unchanged (the dir_ledger short-circuit was skipped)...
    expect(statCounter.count).toBeGreaterThan(0);
    // ...and the results are identical to the short-circuited run.
    expect(withKill).toEqual(warm);
  });
});
