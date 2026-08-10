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
import { commitsBehindDefault, createWorktree, localDefaultBranch, removeWorktree, worktreeCheckoutExists, worktreeExists } from './worktree.js';

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
    // realpath the temp root: on Windows `os.tmpdir()` yields the 8.3 SHORT form
    // (`C:\Users\RUNNER~1\...`) while git — and therefore every path createWorktree
    // returns via `rev-parse --git-common-dir` — yields the LONG form
    // (`C:\Users\runneradmin\...`). Comparing the two spellings of one directory
    // fails on the Windows runner only. No-op on POSIX.
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agents-wt-')));
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

  // RUSH-2366 follow-up: a real incident nested a teammate's worktree inside a
  // SIBLING teammate's own worktree — `.../worktrees/opencode-parity/.agents/
  // worktrees/teams-reliability` — because the caller's ambient cwd was already
  // inside worktree A when it created worktree B. `git rev-parse --show-toplevel`
  // from inside a linked worktree returns THAT worktree's own root, not the main
  // checkout's, so passing it straight through as the placement root nests B
  // under A. createWorktree must resolve the MAIN repo root regardless of which
  // worktree the caller is standing in.
  it('never nests a new worktree inside another worktree, even when cwd is already inside one', async () => {
    const wtA = await createWorktree(clone, 'teammate-a');
    try {
      // Simulate a caller (e.g. an orchestrator agent) whose own cwd is teammate
      // A's worktree — exactly the observed incident path — creating a SECOND,
      // sibling teammate worktree from there.
      const wtB = await createWorktree(wtA, 'teammate-b');
      try {
        // Must land as a sibling under the MAIN repo's .agents/worktrees/, never
        // nested under A's own .agents/worktrees/.
        expect(wtB).toBe(path.join(clone, '.agents', 'worktrees', 'teammate-b'));
        expect(wtB.startsWith(wtA)).toBe(false);
        expect(fs.existsSync(path.join(wtA, '.agents', 'worktrees', 'teammate-b'))).toBe(false);
      } finally {
        await removeWorktree(clone, 'teammate-b');
      }
    } finally {
      await removeWorktree(clone, 'teammate-a');
    }
  });

  // RUSH-2356: `teams add` cleans up a worktree it half-created when the create
  // fails, but must NEVER remove one that was already there — the usual reason
  // a create fails is `fatal: a branch named 'agents/<name>' already exists`,
  // and `teams stop` deliberately keeps a worktree holding uncommitted changes.
  // This is the pre-flight that tells the two apart.
  describe('worktreeExists', () => {
    it('false before anything is created, true once it is', async () => {
      expect(await worktreeExists(clone, 'probe-a')).toBe(false);
      await createWorktree(clone, 'probe-a');
      try {
        expect(await worktreeExists(clone, 'probe-a')).toBe(true);
      } finally {
        await removeWorktree(clone, 'probe-a');
      }
      expect(await worktreeExists(clone, 'probe-a')).toBe(false);
    });

    it('true for a branch with no checkout — the half-created state it exists to catch', async () => {
      // `git worktree add -b` creating the ref and then failing the checkout
      // leaves exactly this: the branch, no directory.
      git(clone, ['branch', 'agents/probe-b']);
      expect(fs.existsSync(path.join(clone, '.agents', 'worktrees', 'probe-b'))).toBe(false);
      expect(await worktreeExists(clone, 'probe-b')).toBe(true);
      // ...and the narrower probe says NO checkout, which is what licenses the
      // failed-create cleanup to drop that dangling ref without deleting files.
      expect(await worktreeCheckoutExists(clone, 'probe-b')).toBe(false);
    });

    it('worktreeCheckoutExists tracks only the directory, never the branch', async () => {
      expect(await worktreeCheckoutExists(clone, 'probe-d')).toBe(false);
      await createWorktree(clone, 'probe-d');
      try {
        expect(await worktreeCheckoutExists(clone, 'probe-d')).toBe(true);
      } finally {
        await removeWorktree(clone, 'probe-d');
      }
      expect(await worktreeCheckoutExists(clone, 'probe-d')).toBe(false);
    });

    it('answers for the MAIN repo from inside another worktree', async () => {
      const wt = await createWorktree(clone, 'probe-c');
      try {
        // Same getMainRepoRoot resolution as createWorktree/removeWorktree, so a
        // caller standing in a sibling worktree gets the main checkout's answer.
        expect(await worktreeExists(wt, 'probe-c')).toBe(true);
        expect(await worktreeExists(wt, 'probe-none')).toBe(false);
      } finally {
        await removeWorktree(clone, 'probe-c');
      }
    });

    it('rejects invalid worktree names', async () => {
      await expect(worktreeExists(clone, '../evil')).rejects.toThrow(/Invalid worktree name/);
    });
  });
});

// The staleness the `teams add --confirm` guard checks. The load-bearing property
// is fetch-first: a checkout "pointed at without fetching first" has a STALE
// remote-tracking ref, so a naive HEAD..origin/main reads 0 and hides the drift —
// commitsBehindDefault must fetch and report the TRUE behind count (the real
// 71-commit-stale s1 incident).
describe('commitsBehindDefault', () => {
  let tmp: string;
  let bare: string;
  let clone: string;

  beforeEach(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agents-behind-')));
    bare = path.join(tmp, 'remote.git');
    clone = path.join(tmp, 'clone');

    git(tmp, ['init', '--bare', bare]);
    const seed = path.join(tmp, 'seed');
    git(tmp, ['clone', bare, seed]);
    git(seed, ['checkout', '-b', 'main']);
    fs.writeFileSync(path.join(seed, 'base.txt'), 'A\n');
    git(seed, ['add', 'base.txt']);
    git(seed, ['commit', '-m', 'A']);
    git(seed, ['push', '-u', 'origin', 'main']);
    git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

    git(tmp, ['clone', bare, clone]);
    try {
      git(clone, ['remote', 'set-head', 'origin', '--auto']);
    } catch {
      // some git versions need the bare HEAD already set (done above)
    }
  }, 60_000);

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // Advance origin/main with a second push (main moved on the remote after the clone).
  function advanceOrigin(): void {
    const seed2 = path.join(tmp, 'seed2');
    git(tmp, ['clone', bare, seed2]);
    fs.writeFileSync(path.join(seed2, 'newer.txt'), 'fresh\n');
    git(seed2, ['add', 'newer.txt']);
    git(seed2, ['commit', '-m', 'C-on-origin']);
    git(seed2, ['push', 'origin', 'main']);
  }

  it('reports 0 behind for an up-to-date clone', async () => {
    const res = await commitsBehindDefault(clone);
    expect(res).toEqual({ behind: 0, base: 'main' });
  });

  it('reports the TRUE behind count even when the local tracking ref is stale (fetches first)', async () => {
    advanceOrigin();
    // The clone has NOT fetched, so its origin/main tracking ref is still pre-C:
    // a check that skipped the fetch would read 0 and miss the drift.
    const staleView = git(clone, ['rev-list', '--count', 'HEAD..origin/main']);
    expect(staleView).toBe('0');

    const res = await commitsBehindDefault(clone);
    expect(res).toEqual({ behind: 1, base: 'main' });
  });

  it('reports 0 behind when the local checkout is AHEAD of origin (unpushed commits)', async () => {
    fs.writeFileSync(path.join(clone, 'local-only.txt'), 'B\n');
    git(clone, ['add', 'local-only.txt']);
    git(clone, ['commit', '-m', 'B-local-only']);
    // HEAD..origin/main = commits on origin not in HEAD = 0; ahead is not behind.
    const res = await commitsBehindDefault(clone);
    expect(res).toEqual({ behind: 0, base: 'main' });
  });

  it('returns null for a directory that is not a git repo', async () => {
    const plain = path.join(tmp, 'not-a-repo');
    fs.mkdirSync(plain);
    expect(await commitsBehindDefault(plain)).toBeNull();
  });

  // The `--use-worktree` shared-team case: teammates run in a LINKED worktree with
  // its own HEAD, distinct from the main checkout. The count must reflect the
  // passed worktree's HEAD (via --show-toplevel), not fold to the main repo root —
  // otherwise a stale-main / current-worktree pair reports the wrong tree.
  it('measures the passed linked worktree, not the main checkout', async () => {
    advanceOrigin(); // origin/main advances to B; the main clone (HEAD=A) is now 1 behind.

    // A linked worktree checked out AT the new origin/main (up to date).
    git(clone, ['fetch', 'origin']);
    const lw = path.join(tmp, 'shared-wt');
    git(clone, ['worktree', 'add', '-b', 'uptodate', lw, 'origin/main']);

    // Main checkout is behind; the linked worktree is current. If the count folded
    // to the main repo root it would report the main's 1 for BOTH.
    expect((await commitsBehindDefault(clone))?.behind).toBe(1);
    expect((await commitsBehindDefault(lw))?.behind).toBe(0);
  });
});
