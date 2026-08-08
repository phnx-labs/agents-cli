/**
 * `normalizeCwd` sits on both sides of the cwd filter in `db.ts` — the stored
 * value written at index time and the `--cwd`/`--cwd-prefix` query — so the two
 * must normalize identically or the LIKE subdir match silently returns nothing.
 *
 * It also has to survive a FOREIGN path. A cwd read out of a transcript can name
 * a directory on another machine, and `path.resolve()` used to rebase such a path
 * onto the current drive on Windows (`/Users/me` -> `D:\Users\me`), inventing a
 * location that never existed and corrupting every remote session in the index.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { _normalizeCwdForTest as normalizeCwd } from './discover.js';

describe('normalizeCwd', () => {
  it('returns empty for a missing cwd', () => {
    expect(normalizeCwd(undefined)).toBe('');
    expect(normalizeCwd('')).toBe('');
  });

  it('resolves a relative path against the process cwd', () => {
    const out = normalizeCwd('.');
    expect(path.isAbsolute(out)).toBe(true);
  });

  it('strips a trailing separator so exact and prefix matching agree', () => {
    // The LIKE subdir wildcard in db.ts appends path.sep to this value; a
    // trailing separator would produce '//' and match nothing.
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'normcwd-')));
    try {
      expect(normalizeCwd(dir + path.sep)).toBe(dir);
      expect(normalizeCwd(dir)).toBe(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('collapses . and .. in an absolute path', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'normcwd-')));
    try {
      const noisy = path.join(dir, 'sub', '..', '.');
      expect(normalizeCwd(noisy)).toBe(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never invents a drive letter for a foreign absolute path', () => {
    // The regression: on Windows this used to come back as 'D:\\home\\ubuntu\\app'.
    // The path does not exist on this machine under either OS, so the result must
    // still name the same directory it did in the transcript.
    const foreign = '/home/ubuntu/definitely-not-here-9f3a/app';
    const out = normalizeCwd(foreign);
    expect(out).not.toMatch(/^[a-zA-Z]:/);
    expect(out.replace(/\\/g, '/')).toBe(foreign);
  });

  it('keeps a foreign path stable across repeated normalization', () => {
    // Idempotence is what lets the stored value and the query value agree.
    const foreign = '/var/data/proj/';
    const once = normalizeCwd(foreign);
    expect(normalizeCwd(once)).toBe(once);
  });

  it('never rebases a foreign Windows-rooted path onto this process cwd (RUSH-2358)', () => {
    // The mirror regression: on POSIX, path.isAbsolute() doesn't recognize a
    // drive letter, so a Windows-recorded cwd used to fall through to
    // path.resolve() and come back prefixed with THIS process's own cwd —
    // silently grafting an unrelated local directory onto a synced session
    // (and, via WORKTREE_RE, capable of misattributing its worktree slug to
    // whatever worktree this process happens to be running in).
    const foreign = 'C:\\Users\\dev\\repo\\.agents\\worktrees\\my-feature';
    const out = normalizeCwd(foreign);
    expect(out).not.toContain(process.cwd());
    expect(out.replace(/\//g, '\\')).toBe(foreign);
  });
});
