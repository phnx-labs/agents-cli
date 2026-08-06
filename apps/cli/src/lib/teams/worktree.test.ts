/**
 * createWorktree must base the new branch on freshly-fetched origin/<default>,
 * never local HEAD — the failure mode that made every teammate inherit a stale
 * orchestrator checkout and only discover it at merge time.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWorktree, localDefaultBranch, removeWorktree } from './worktree.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t.dev', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

// Windows CI: bare+seed+two clones regularly exceeds vitest's 10s default
// hookTimeout (RUSH-2215 full suite). Keep the real git fixture; just give it room.
describe('createWorktree base freshness', () => {
  let tmp: string;
  let bare: string;
  let clone: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-wt-'));
    bare = path.join(tmp, 'remote.git');
    clone = path.join(tmp, 'clone');

    // Bare origin + seed clone that pushes commit A as main.
    git(tmp, ['init', '--bare', bare]);
    const seed = path.join(tmp, 'seed');
    git(tmp, ['clone', bare, seed]);
    git(seed, ['checkout', '-b', 'main']);
    fs.writeFileSync(path.join(seed, 'base.txt'), 'A\n');
    git(seed, ['add', 'base.txt']);
    git(seed, ['commit', '-m', 'A']);
    git(seed, ['push', '-u', 'origin', 'main']);
    // origin/HEAD → main
    git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

    git(tmp, ['clone', bare, clone]);
    // Make sure origin/HEAD is set on the clone.
    try {
      git(clone, ['remote', 'set-head', 'origin', '--auto']);
    } catch {
      // some git versions need the bare HEAD already set (done above)
    }
  }, 60_000);

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('localDefaultBranch resolves origin/HEAD to main', async () => {
    expect(await localDefaultBranch(clone)).toBe('main');
  });

  it('bases the worktree on origin/main, not a diverged local HEAD', async () => {
    const originMain = git(clone, ['rev-parse', 'origin/main']);

    // Local-only commit B on main — HEAD is ahead of origin/main.
    fs.writeFileSync(path.join(clone, 'local-only.txt'), 'B\n');
    git(clone, ['add', 'local-only.txt']);
    git(clone, ['commit', '-m', 'B-local-only']);
    const localHead = git(clone, ['rev-parse', 'HEAD']);
    expect(localHead).not.toBe(originMain);

    const wt = await createWorktree(clone, 'teammate-a');
    try {
      const wtHead = git(wt, ['rev-parse', 'HEAD']);
      // Must match origin/main (A), not the diverged local HEAD (B).
      expect(wtHead).toBe(originMain);
      expect(wtHead).not.toBe(localHead);
      expect(fs.existsSync(path.join(wt, 'local-only.txt'))).toBe(false);
      expect(fs.existsSync(path.join(wt, 'base.txt'))).toBe(true);

      const branch = git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']);
      expect(branch).toBe('agents/teammate-a');
    } finally {
      await removeWorktree(clone, 'teammate-a');
    }
  });

  it('picks up commits that landed on origin after the local clone went stale', async () => {
    // Advance origin/main with a second seed push (simulates teammates
    // spinning up after main moved on the remote).
    const seed2 = path.join(tmp, 'seed2');
    git(tmp, ['clone', bare, seed2]);
    fs.writeFileSync(path.join(seed2, 'newer.txt'), 'fresh\n');
    git(seed2, ['add', 'newer.txt']);
    git(seed2, ['commit', '-m', 'C-on-origin']);
    git(seed2, ['push', 'origin', 'main']);
    const originAfter = git(seed2, ['rev-parse', 'HEAD']);

    // clone's origin/main is still pre-C until createWorktree fetches.
    const staleOrigin = git(clone, ['rev-parse', 'origin/main']);
    expect(staleOrigin).not.toBe(originAfter);

    const wt = await createWorktree(clone, 'teammate-b');
    try {
      const wtHead = git(wt, ['rev-parse', 'HEAD']);
      expect(wtHead).toBe(originAfter);
      expect(fs.existsSync(path.join(wt, 'newer.txt'))).toBe(true);
    } finally {
      await removeWorktree(clone, 'teammate-b');
    }
  });

  it('rejects invalid worktree names', async () => {
    await expect(createWorktree(clone, '../evil')).rejects.toThrow(/Invalid worktree name/);
  });
});
