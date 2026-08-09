/**
 * RUSH-2356 second defect: `teams add` created the local worktree BEFORE the
 * teammate record was persisted, and cleaned nothing up when the add failed.
 * A failed add therefore stranded the `agents/<name>` branch, and every retry
 * died with `fatal: a branch named 'agents/<name>' already exists` — observed
 * 2026-08-07, which forced three renames (cmdsurface, surface2, daemon-surface3)
 * before a teammate could be created at all.
 *
 * This reproduces that incident end-to-end and pins the fix. Real CLI, real git,
 * real filesystem, no mocking:
 *
 *  1. a real bare origin + clone, so `createWorktree`'s fetch-and-base-off
 *     `origin/<default>` policy runs for real;
 *  2. `teams add` is FAILED for real by running it on a PATH where the `claude`
 *     CLI does not exist — spawn()'s own `checkCliAvailable` pre-flight throws
 *     AFTER the worktree step, which is exactly the post-creation failure the
 *     cleanup exists for;
 *  3. the retry then uses the SAME teammate/worktree name with a `claude`
 *     executable present, and must SUCCEED. That last step is the assertion
 *     that reproduces the incident — on the pre-fix code it fails with
 *     `fatal: a branch named 'agents/surface' already exists`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t.dev', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

/** Absolute path of a PATH executable, or null when it isn't installed. */
function resolveBin(name: string): string | null {
  try {
    const out = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
    return out && path.isAbsolute(out) ? out : null;
  } catch {
    return null;
  }
}

const BUN = process.platform === 'win32' ? null : resolveBin('bun');
const WHICH = process.platform === 'win32' ? null : resolveBin('which');

// Needs a POSIX shell + `which` (the CLI's own PATH-search command) and bun to
// run the TS entrypoint. Windows uses `where` and a different exec model.
describe.skipIf(process.platform === 'win32' || !BUN || !WHICH)(
  'teams add leaves no orphan branch or worktree when the add fails (RUSH-2356)',
  () => {
    let tmp: string;
    let home: string;
    let repo: string;
    let binDir: string;
    const entry = path.resolve(process.cwd(), 'src/index.ts');

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-add-cleanup-'));
      home = path.join(tmp, 'home');

      // The CLI refuses to run before setup; the gate is just "is
      // ~/.agents/.system a git repo" (same as teams.device-auto.integration.test.ts).
      const systemDir = path.join(home, '.agents', '.system');
      fs.mkdirSync(systemDir, { recursive: true });
      git(systemDir, ['init', '-q']);

      // Bare origin + a seed that pushes main, so the clone has a real
      // origin/HEAD for createWorktree to base the teammate branch on.
      const bare = path.join(tmp, 'remote.git');
      const seed = path.join(tmp, 'seed');
      git(tmp, ['init', '--bare', '-q', '-b', 'main', bare]);
      git(tmp, ['init', '-q', '-b', 'main', seed]);
      fs.writeFileSync(path.join(seed, 'base.txt'), 'A\n');
      git(seed, ['add', 'base.txt']);
      git(seed, ['commit', '-qm', 'A']);
      git(seed, ['remote', 'add', 'origin', bare]);
      git(seed, ['push', '-q', '-u', 'origin', 'main']);

      repo = path.join(tmp, 'repo');
      git(tmp, ['clone', '-q', bare, repo]);
      git(repo, ['remote', 'set-head', 'origin', '--auto']);

      // A minimal PATH: git + sh + which and nothing else. This is what makes
      // the first add fail deterministically on ANY box (and as any user) —
      // `claude` is provably absent from PATH rather than "probably not
      // installed on CI".
      binDir = path.join(tmp, 'bin');
      fs.mkdirSync(binDir);
      fs.symlinkSync(resolveBin('git')!, path.join(binDir, 'git'));
      fs.symlinkSync('/bin/sh', path.join(binDir, 'sh'));
      fs.symlinkSync(WHICH!, path.join(binDir, 'which'));
    });

    afterEach(() => {
      // A successful add launches a REAL teammate process under this HOME and
      // the CLI warms its own state there, so files keep appearing under `tmp`
      // while a recursive delete walks it — a single rmSync loses that race with
      // ENOTEMPTY (observed on CI). Retry, then give up quietly: this is an OS
      // temp dir, and failing teardown must never be reported as a failed test.
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          fs.rmSync(tmp, { recursive: true, force: true });
          return;
        } catch {
          // Busy-wait briefly without async: afterEach must stay synchronous here.
          const until = Date.now() + 100;
          while (Date.now() < until) { /* spin */ }
        }
      }
    });

    function runCli(args: string[]): { status: number; out: string } {
      const result = spawnSync(BUN!, [entry, ...args], {
        cwd: repo,
        env: {
          HOME: home,
          PATH: binDir,
          AGENTS_NO_NUDGE: '1',
          FORCE_COLOR: '0',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: result.status ?? 1, out: `${result.stdout}${result.stderr}` };
    }

    /** Every local branch name in the test repo. */
    function branches(): string[] {
      return git(repo, ['branch', '--list', '--format=%(refname:short)'])
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    }

    it('a failed add exits non-zero, strands nothing, and the same name retries clean', () => {
      expect(runCli(['teams', 'create', 'wt-team', '--enable-worktrees']).status).toBe(0);

      // --- the failed add ---------------------------------------------------
      const failed = runCli([
        'teams', 'add', 'wt-team', 'claude', 'do a thing',
        '--name', 'surface', '--worktree', 'surface',
      ]);

      // (1) non-zero exit with a clear error — never a success block for a
      // teammate that does not exist.
      expect(failed.status).not.toBe(0);
      expect(failed.out).toContain("CLI tool 'claude' not found in PATH");
      expect(failed.out).not.toContain('Welcomed');

      // (2) no orphaned `agents/<name>` branch.
      expect(branches()).not.toContain('agents/surface');

      // (3) no orphaned worktree directory, and git itself no longer tracks one.
      expect(fs.existsSync(path.join(repo, '.agents', 'worktrees', 'surface'))).toBe(false);
      expect(git(repo, ['worktree', 'list'])).not.toContain('surface');

      // --- the retry, same name ---------------------------------------------
      // Drop a real `claude` executable in so the add can get past the
      // availability pre-flight. It only has to be spawnable — `teams add`
      // records and launches it, then returns; it deliberately exits at once so
      // no child outlives the test and races the temp-dir teardown.
      const stub = path.join(binDir, 'claude');
      fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(stub, 0o755);

      const retry = runCli([
        'teams', 'add', 'wt-team', 'claude', 'do a thing',
        '--name', 'surface', '--worktree', 'surface',
      ]);

      // (4) THE incident assertion: the retry must not die on the leftover
      // branch. Pre-fix this exits 1 with
      // `fatal: a branch named 'agents/surface' already exists`.
      expect(retry.out).not.toContain('already exists');
      expect(retry.status).toBe(0);
      expect(retry.out).toContain('Welcomed');
      expect(branches()).toContain('agents/surface');
      expect(fs.existsSync(path.join(repo, '.agents', 'worktrees', 'surface'))).toBe(true);
    }, 120_000);

    it('a rejected add never creates the branch in the first place', () => {
      expect(runCli(['teams', 'create', 'dep-team', '--enable-worktrees']).status).toBe(0);

      // --after names a teammate that does not exist. validateAddPreconditions
      // now runs BEFORE createWorktree, so this is rejected with no branch and
      // no worktree ever created — not created-then-cleaned-up.
      const rejected = runCli([
        'teams', 'add', 'dep-team', 'claude', 'do a thing',
        '--name', 'second', '--worktree', 'second', '--after', 'nobody',
      ]);

      expect(rejected.status).not.toBe(0);
      expect(rejected.out).toContain("has no teammate named 'nobody'");
      expect(branches()).not.toContain('agents/second');
      expect(fs.existsSync(path.join(repo, '.agents', 'worktrees', 'second'))).toBe(false);

      // The end state above is ALSO what created-then-cleaned-up looks like, so
      // it alone would not catch validation sliding back inside spawn(). This
      // does: the pre-worktree check dies via `add-precondition-failed` with the
      // raw validation message, while a failure from inside spawn() comes back
      // through the add's own catch, wrapped in `Could not add <agent> to <team>:`.
      // (A reflog probe does NOT discriminate — `git branch -D` deletes the ref's
      // reflog with it, so created-then-deleted looks identical to never-created.)
      expect(rejected.out).not.toContain('Could not add');
    }, 120_000);

    // The most dangerous path in this fix, and the one it nearly got wrong:
    // `teams stop` deliberately KEEPS a worktree holding uncommitted changes
    // (`Worktree '<n>' has uncommitted changes. Keeping it at: …`) while that
    // teammate's record goes TERMINAL. So no record-based check can protect it —
    // a terminal owner reads as "not claimed", which is correct for reaping an
    // orphan branch and catastrophic here. A later add reusing the worktree name
    // fails with `fatal: a branch named 'agents/<name>' already exists`, and an
    // ungated teardown would `git worktree remove --force` that checkout and
    // destroy the uncommitted work. The failed-create cleanup is gated on
    // pre-existence instead, which is why this survives.
    it('a failed add never destroys a kept dirty worktree it collided with', () => {
      expect(runCli(['teams', 'create', 'dirty-team', '--enable-worktrees']).status).toBe(0);

      // A `claude` that exists, so the first add really lands.
      const stub = path.join(binDir, 'claude');
      fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(stub, 0o755);

      const first = runCli([
        'teams', 'add', 'dirty-team', 'claude', 'do a thing',
        '--name', 'alpha', '--worktree', 'shared-name',
      ]);
      expect(first.status).toBe(0);

      // Uncommitted work in that teammate's checkout.
      const wt = path.join(repo, '.agents', 'worktrees', 'shared-name');
      expect(fs.existsSync(wt)).toBe(true);
      const precious = path.join(wt, 'important.txt');
      fs.writeFileSync(precious, 'PRECIOUS UNCOMMITTED WORK\n');

      // Stopping the team leaves the dirty worktree in place and the record
      // terminal — the exact state that defeats a record-based guard. Assert on
      // the KEEP message, not just on the directory still being there: a `teams
      // stop` that errored out early would also leave the directory, and this
      // whole case would then be testing nothing.
      const stopped = runCli(['teams', 'stop', 'dirty-team', 'alpha']);
      expect(stopped.out).toContain("Worktree 'shared-name' has uncommitted changes. Keeping it at");
      expect(fs.existsSync(wt)).toBe(true);

      // A NEW teammate reusing that worktree name. The create must fail on the
      // existing branch, and must not touch the checkout on its way out.
      const collide = runCli([
        'teams', 'add', 'dirty-team', 'claude', 'do another thing',
        '--name', 'beta', '--worktree', 'shared-name',
      ]);

      expect(collide.status).not.toBe(0);
      expect(fs.existsSync(precious)).toBe(true);
      expect(fs.readFileSync(precious, 'utf8')).toBe('PRECIOUS UNCOMMITTED WORK\n');
      expect(branches()).toContain('agents/shared-name');
    }, 120_000);
  },
);
