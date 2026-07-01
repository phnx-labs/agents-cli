/**
 * Auth persistence across version switches (RUSH-1318): droid/antigravity/kimi
 * store login as files inside the per-version config home. Switching versions
 * repoints the ~/.<config> symlink to a home that was never logged in, silently
 * logging the CLI out. carryForwardAuthFiles seeds the target home with the
 * freshest credential; getAccountInfo falls back to the active HOME config so
 * non-active versions still report the account-global sign-in state.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let TEST_VERSIONS_DIR = '';
let TEST_BACKUPS_DIR = '';

vi.mock('./state.js', async () => {
  const actual = await vi.importActual<typeof import('./state.js')>('./state.js');
  return {
    ...actual,
    getVersionsDir: () => TEST_VERSIONS_DIR,
    getBackupsDir: () => TEST_BACKUPS_DIR,
    ensureAgentsDir: () => {},
  };
});

import { switchConfigSymlink, carryForwardAuthFiles } from './shims.js';
import { getAccountInfo } from './agents.js';

const tempDirs: string[] = [];

function makeHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-carry-'));
  tempDirs.push(root);
  TEST_VERSIONS_DIR = path.join(root, '.agents', 'versions');
  TEST_BACKUPS_DIR = path.join(root, '.agents', 'backups');
  fs.mkdirSync(TEST_VERSIONS_DIR, { recursive: true });
  process.env.AGENTS_REAL_HOME = root;
  return root;
}

function droidHome(v: string): string {
  const h = path.join(TEST_VERSIONS_DIR, 'droid', v, 'home');
  fs.mkdirSync(path.join(h, '.factory'), { recursive: true });
  return h;
}

function writeDroidAuth(home: string, body: string, mtimeMs?: number): void {
  const dir = path.join(home, '.factory');
  fs.writeFileSync(path.join(dir, 'auth.v2.file'), body, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'auth.v2.key'), 'KEY', { mode: 0o600 });
  if (mtimeMs) {
    const t = new Date(mtimeMs);
    fs.utimesSync(path.join(dir, 'auth.v2.file'), t, t);
    fs.utimesSync(path.join(dir, 'auth.v2.key'), t, t);
  }
}

afterEach(() => {
  delete process.env.AGENTS_REAL_HOME;
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('carryForwardAuthFiles / switchConfigSymlink — auth survives version switch (RUSH-1318)', () => {
  let home: string;
  beforeEach(() => { home = makeHome(); });

  it('carries droid auth.v2.file + auth.v2.key into the version being switched to, preserving 0600, leaving source intact', async () => {
    const v1 = droidHome('latest');
    const v2 = droidHome('0.159.1');
    writeDroidAuth(v1, 'LOGGED_IN_BLOB');
    // Active config symlink starts at v1 (where the user logged in).
    const link = path.join(home, '.factory');
    fs.symlinkSync(path.join(v1, '.factory'), link);

    const res = await switchConfigSymlink('droid', '0.159.1');
    expect(res.success).toBe(true);

    // v2 now has the login...
    const dst = path.join(v2, '.factory', 'auth.v2.file');
    expect(fs.existsSync(dst)).toBe(true);
    expect(fs.readFileSync(dst, 'utf8')).toBe('LOGGED_IN_BLOB');
    expect(fs.existsSync(path.join(v2, '.factory', 'auth.v2.key'))).toBe(true);
    expect(fs.statSync(dst).mode & 0o777).toBe(0o600);
    // ...and the source is untouched (copy, not move).
    expect(fs.existsSync(path.join(v1, '.factory', 'auth.v2.file'))).toBe(true);
  });

  it('overwrites an OLDER credential in the target but keeps a NEWER one', () => {
    const v1 = droidHome('latest');
    const v2 = droidHome('0.159.1');

    // Case A: v1 newer than v2 -> v2 gets overwritten with v1's blob.
    writeDroidAuth(v1, 'FRESH', 2_000_000);
    writeDroidAuth(v2, 'STALE', 1_000_000);
    carryForwardAuthFiles('droid', path.join(v2, '.factory'));
    expect(fs.readFileSync(path.join(v2, '.factory', 'auth.v2.file'), 'utf8')).toBe('FRESH');

    // Case B: target already newest -> left alone.
    writeDroidAuth(v1, 'OLDER', 1_000_000);
    writeDroidAuth(v2, 'NEWEST', 3_000_000);
    carryForwardAuthFiles('droid', path.join(v2, '.factory'));
    expect(fs.readFileSync(path.join(v2, '.factory', 'auth.v2.file'), 'utf8')).toBe('NEWEST');
  });

  it('carries antigravity nested token across a switch', async () => {
    const relDir = path.join('.gemini', 'antigravity-cli');
    const v1 = path.join(TEST_VERSIONS_DIR, 'antigravity', '1.0.13', 'home');
    const v2 = path.join(TEST_VERSIONS_DIR, 'antigravity', '1.0.12', 'home');
    fs.mkdirSync(path.join(v1, relDir), { recursive: true });
    fs.mkdirSync(path.join(v2, relDir), { recursive: true });
    fs.writeFileSync(path.join(v1, relDir, 'antigravity-oauth-token'), '{"token":{"refresh_token":"r"}}', { mode: 0o600 });
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    fs.symlinkSync(path.join(v1, relDir), path.join(home, relDir));

    const res = await switchConfigSymlink('antigravity', '1.0.12');
    expect(res.success).toBe(true);
    expect(fs.existsSync(path.join(v2, relDir, 'antigravity-oauth-token'))).toBe(true);
  });

  it('is a no-op for agents without authFiles (claude)', () => {
    const cHome = path.join(TEST_VERSIONS_DIR, 'claude', '2.1.0', 'home', '.claude');
    fs.mkdirSync(cHome, { recursive: true });
    // Must not throw and must not create any file.
    expect(() => carryForwardAuthFiles('claude', cHome)).not.toThrow();
    expect(fs.readdirSync(cHome)).toEqual([]);
  });
});

describe('getAccountInfo — non-active version reflects account-global sign-in (screenshot bug)', () => {
  let home: string;
  beforeEach(() => { home = makeHome(); });

  it('reports droid signed-in for a version whose isolated home lacks auth, via active HOME fallback', async () => {
    const v1 = droidHome('latest');     // logged-in home
    const v2 = droidHome('0.159.1');    // isolated, empty
    writeDroidAuth(v1, 'BLOB');
    // Active ~/.factory -> v1 (has auth).
    fs.symlinkSync(path.join(v1, '.factory'), path.join(home, '.factory'));

    // Querying the EMPTY v2 home still resolves signed-in via the HOME fallback.
    const info = await getAccountInfo('droid', path.join(v2));
    expect(info.signedIn).toBe(true);
  });

  it('reports not-signed-in when neither the version home nor active HOME has auth', async () => {
    const v2 = droidHome('0.159.1');
    const info = await getAccountInfo('droid', path.join(v2));
    expect(info.signedIn).toBe(false);
  });
});
