import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// win32: bash release.sh PR-head synchronization (RUSH-2215).
const describeRelease = process.platform === 'win32' ? describe.skip : describe;

// The --device resolution assertions drive the real --home-base-phase entrypoint,
// which dies at the macOS gate on Linux (printing the resolved home base) but
// would proceed past it on darwin. Run them off darwin/win32 only.
const describeDeviceResolution =
  process.platform === 'win32' || process.platform === 'darwin'
    ? describe.skip
    : describe;

const RELEASE_SH_PATH = path.resolve(__dirname, 'release.sh');
const RELEASE_SH = fs.readFileSync(RELEASE_SH_PATH, 'utf-8');

function runRelease(...args: string[]): { status: number | null; out: string } {
  const r = spawnSync('bash', [RELEASE_SH_PATH, ...args], { encoding: 'utf-8' });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describeRelease('release.sh attestation promotion (RUSH-2666)', () => {
  it('requires the exact release-commit tree and never waits on a full-suite matrix', () => {
    const waitFunction = RELEASE_SH.match(
      /wait_for_attestation\(\) \{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.body;

    expect(waitFunction).toBeDefined();
    expect(waitFunction).toContain('release-attestation.sh require');
    expect(waitFunction).toContain('+ 90');
    expect(RELEASE_SH).not.toContain('wait_for_ci_green');
    expect(RELEASE_SH).not.toContain('run_crabbox_tests');
    expect(RELEASE_SH).not.toContain('EXPECTED_CHECKS');
    expect(RELEASE_SH).toContain('wait_for_attestation "$(git rev-parse "$RELEASE_CI_HEAD^{tree}")"');
    expect(RELEASE_SH).toContain('refusing parent/nearby evidence');
  });

  it('promotes the attested tarball and does not rebuild or notarize on the ordinary path', () => {
    expect(RELEASE_SH).toContain('release-attestation.sh promote');
    expect(RELEASE_SH).toContain('release-install-smoke.sh');
    expect(RELEASE_SH).toContain('release-manifest.sh require');
    expect(RELEASE_SH).toContain('npm publish "$tgz"');
    expect(RELEASE_SH).toContain('upload_release_proof');
    expect(RELEASE_SH).toContain('gh release download "v$TARGET"');
    expect(RELEASE_SH).toContain('ComputerHelper.app.zip');
    expect(RELEASE_SH).not.toContain('sign-cli-binary.sh');
    expect(RELEASE_SH).not.toContain('publish-computer-helper-mac.sh');
    expect(RELEASE_SH).not.toContain('menubar/scripts/build.sh release');
    expect(RELEASE_SH).toContain('rebuild/notarization is outside the ordinary release path');
  });
});

describeRelease('release.sh: publish is decoupled from live main (RUSH-2395 audit)', () => {
  it('tags + publishes the ATTESTED release commit, never a fresh-main squash result', () => {
    // The publish source is the attested commit itself...
    expect(RELEASE_SH).toContain('PUBLISH_SHA="$CI_COMMIT"');
    // ...never whatever origin/main squashed to after the merge.
    expect(RELEASE_SH).not.toContain('PUBLISH_SHA="$MERGED_SHA"');
    // The PRIMARY path (CI_COMMIT="$RELEASE_COMMIT" ... PUBLISH_SHA="$CI_COMMIT")
    // has NO "does live main reproduce the attested tree" equality gate -- that
    // gate forced main to stay quiet for the whole release. (The catch-up recovery
    // path keeps it, since there main already carries the bump.)
    const primaryStart = RELEASE_SH.indexOf('CI_COMMIT="$RELEASE_CI_HEAD"');
    const primaryEnd = RELEASE_SH.indexOf('PUBLISH_SHA="$CI_COMMIT"');
    expect(primaryStart).toBeGreaterThan(0);
    expect(primaryEnd).toBeGreaterThan(primaryStart);
    const primaryPath = RELEASE_SH.slice(primaryStart, primaryEnd);
    expect(primaryPath).not.toContain('MERGED_TREE');
    expect(primaryPath).not.toContain('git fetch --quiet origin "$DEFAULT_BRANCH"');
    expect(RELEASE_SH).toContain('wait_for_attestation "$ATTESTED_TREE"');
    expect(RELEASE_SH).toContain('merge deferred until after publish');
  });

  it('keys the tag/publish to the STABLE branch head, not a re-synthesized commit (retry-safe)', () => {
    // git commit-tree stamps wall-clock time, so RELEASE_COMMIT gets a fresh SHA
    // every run for identical content. The primary path must publish the stable,
    // already-pushed RELEASE_CI_HEAD so a retry after a transient home-base failure
    // does not die at the tag-mismatch check (review of #2966).
    expect(RELEASE_SH).toContain('CI_COMMIT="$RELEASE_CI_HEAD"');
    expect(RELEASE_SH).not.toContain('CI_COMMIT="$RELEASE_COMMIT"');
    // The already-published re-run lands a still-open deferred bump PR so the
    // .changelog/next queue cannot drift into a later release.
    expect(RELEASE_SH).toContain('STUCK_BUMP_PR');
  });

  it('merges the version-bump PR AFTER publish, non-gating (never dies on it)', () => {
    // The old flow squash-merged BEFORE publish and died on a merge failure,
    // coupling the release to a quiet main. That gating merge is gone.
    expect(RELEASE_SH).not.toContain(
      'gh pr merge "$PR_NUMBER" --squash --delete-branch || die',
    );
    // The async bump-merge lives after the "Verify live" phase and is best-effort.
    const verifyIdx = RELEASE_SH.indexOf('phase "Verify live"');
    const asyncMergeIdx = RELEASE_SH.indexOf(
      'Land the version bump on main -- AFTER publish, non-gating',
    );
    expect(verifyIdx).toBeGreaterThan(0);
    expect(asyncMergeIdx).toBeGreaterThan(verifyIdx);
    // It is skipped for the historical-catchup path (its PR merged in a prior run).
    const block = RELEASE_SH.slice(asyncMergeIdx);
    expect(block).toContain('&& ! $HISTORICAL_CATCHUP');
  });
});

describeRelease('release.sh --device flag', () => {
  it('advertises --device <name> in --help', () => {
    const { status, out } = runRelease('--help');
    expect(status).toBe(0);
    expect(out).toContain('--device <name>');
  });

  it('rejects --device with no machine name', () => {
    const { status, out } = runRelease('1.2.3', '--device');
    expect(status).not.toBe(0);
    expect(out).toContain('--device needs a machine name');
  });

  it('preserves "$@" so the worktree re-exec can forward every arg', () => {
    // A `shift`-based parser would consume $@ and strip --device from the
    // release-worktree re-exec (RELEASE_ARGS=("$@")); the for-loop must not.
    expect(RELEASE_SH).toContain('for arg in "$@"; do');
    expect(RELEASE_SH).toContain('exec scripts/release-worktree.sh "$CALLER_REPO_ROOT" "$@"');
  });
});

describeDeviceResolution('release.sh --device resolution', () => {
  it('defaults the home base to mac-mini when --device is omitted', () => {
    const { out } = runRelease('1.2.3', '--home-base-phase');
    expect(out).toContain('home base: mac-mini (promote-only');
  });

  it('routes the privileged phase to --device <name>', () => {
    const { out } = runRelease('1.2.3', '--device', 'zion', '--home-base-phase');
    expect(out).toContain('home base: zion (promote-only');
  });

  it('accepts --host as an alias for --device', () => {
    const { out } = runRelease('1.2.3', '--host', 'pinnacles', '--home-base-phase');
    expect(out).toContain('home base: pinnacles (promote-only');
  });

  it('accepts the --device=<name> glued form', () => {
    const { out } = runRelease('1.2.3', '--device=zion', '--home-base-phase');
    expect(out).toContain('home base: zion (promote-only');
  });
});

// RUSH-2541: home_base_wt_snippet's provisionprofile seed used to copy ONLY from
// REPO_ROOT's on-disk working tree, so a legitimately new home base -- whose own
// checkout has simply never been git-pulled past commit 2567004b4 (which
// committed the profile) -- died "absent on the home base" even though `git
// fetch origin` (which the snippet already runs) had the blob all along. These
// tests extract and RUN the real function body against synthetic git repos, the
// same split stuck-release.sh/signing-home-base-probe.sh already use for
// testability (see the docblock on home_base_wt_snippet in release.sh).
describe('release.sh: home-base provisionprofile seed recovers from origin (RUSH-2541)', () => {
  const FUNC_SRC = RELEASE_SH.match(/home_base_wt_snippet\(\) \{[\s\S]*?\n\}/)?.[0];

  function git(cwd: string, ...args: string[]): string {
    const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${r.stderr}`);
    return r.stdout;
  }

  it('the function is present to extract', () => {
    expect(FUNC_SRC).toBeDefined();
  });

  it('recovers embedded.provisionprofile from origin/<default> when the tag predates it and the home base checkout is stale', () => {
    // origin: a v1.2.3 tag with NO profile (the tagged tree, like the real
    // stuck v1.22.36), then a later commit that adds the profile to main.
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-snippet-origin-'));
    git(remote, 'init', '--quiet', '-b', 'main');
    git(remote, 'config', 'user.email', 'test@example.com');
    git(remote, 'config', 'user.name', 'test');
    fs.mkdirSync(path.join(remote, 'apps/cli'), { recursive: true });
    fs.writeFileSync(path.join(remote, 'apps/cli/package.json'), JSON.stringify({ version: '1.2.3' }));
    git(remote, 'add', '-A');
    git(remote, 'commit', '--quiet', '-m', 'v1.2.3 tree, no profile yet');
    git(remote, 'tag', 'v1.2.3');

    // REPO_ROOT: the home base's own checkout, cloned BEFORE the profile commit
    // lands on origin and never advanced since -- a stale local branch/working
    // tree even though origin (fetched below) is current.
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-snippet-homebase-'));
    git(repoRoot, 'clone', '--quiet', remote, '.');
    expect(fs.existsSync(path.join(repoRoot, 'apps/cli/bin/embedded.provisionprofile'))).toBe(false);

    fs.mkdirSync(path.join(remote, 'apps/cli/bin'), { recursive: true });
    fs.writeFileSync(path.join(remote, 'apps/cli/bin/embedded.provisionprofile'), 'PROFILE-BYTES');
    git(remote, 'add', '-A');
    git(remote, 'commit', '--quiet', '-m', 'commit embedded.provisionprofile (2567004b4)');

    const gen = spawnSync('bash', ['-c', `${FUNC_SRC}\nhome_base_wt_snippet "1.2.3"`], {
      encoding: 'utf-8',
      env: { ...process.env, RELEASE_HOME_BASE: 'test-home-base' },
    });
    expect(gen.status, gen.stderr).toBe(0);

    // Run just the seeding portion of the generated snippet (stop short of
    // `cd "$WT/apps/cli"; scripts/release.sh ...`, which needs the real CLI
    // installed) and cat the recovered file back out BEFORE the snippet's own
    // EXIT trap removes the worktree.
    const seedOnly = `${gen.stdout.split('cd "$WT/apps/cli"')[0]}\ncat "$WT/apps/cli/bin/embedded.provisionprofile"`;
    const run = spawnSync('bash', ['-c', seedOnly], { cwd: repoRoot, encoding: 'utf-8' });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain('PROFILE-BYTES');
  });

  it('fails loudly, not a warning, when the profile is absent everywhere', () => {
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-snippet-origin-empty-'));
    git(remote, 'init', '--quiet', '-b', 'main');
    git(remote, 'config', 'user.email', 'test@example.com');
    git(remote, 'config', 'user.name', 'test');
    fs.mkdirSync(path.join(remote, 'apps/cli'), { recursive: true });
    fs.writeFileSync(path.join(remote, 'apps/cli/package.json'), JSON.stringify({ version: '1.2.3' }));
    git(remote, 'add', '-A');
    git(remote, 'commit', '--quiet', '-m', 'v1.2.3 tree, profile never committed');
    git(remote, 'tag', 'v1.2.3');

    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-snippet-homebase-empty-'));
    git(repoRoot, 'clone', '--quiet', remote, '.');

    const gen = spawnSync('bash', ['-c', `${FUNC_SRC}\nhome_base_wt_snippet "1.2.3"`], {
      encoding: 'utf-8',
      env: { ...process.env, RELEASE_HOME_BASE: 'test-home-base' },
    });
    expect(gen.status, gen.stderr).toBe(0);

    const seedOnly = gen.stdout.split('cd "$WT/apps/cli"')[0];
    const run = spawnSync('bash', ['-c', seedOnly], { cwd: repoRoot, encoding: 'utf-8' });
    expect(run.status).not.toBe(0); // fails fast, not a "warning" that limps forward
    expect(run.stderr).toContain('embedded.provisionprofile not found');
    expect(run.stderr).not.toContain('Generate at developer.apple.com'); // the old, misleading advice
  });

  it('does not die under set -e when the home base checkout has no refs/remotes/origin/HEAD', () => {
    // A checkout bootstrapped via `init && remote add && fetch` -- plausibly how
    // a BRAND NEW fleet home base first gets a checkout, exactly RUSH-2541's
    // target box -- never populates refs/remotes/origin/HEAD the way `git clone`
    // does. `git symbolic-ref --quiet --short refs/remotes/origin/HEAD` then
    // exits non-zero, and under this snippet's `set -euo pipefail` a bare
    // `DEFAULT_BRANCH="$(...)"` assignment on that failure trips errexit and
    // kills the WHOLE home-base phase silently -- before even the "main"
    // fallback on the next line runs -- regardless of whether the profile was
    // otherwise recoverable. The other two tests above always clone, which
    // always sets origin/HEAD, so they cannot reach this failure mode.
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-snippet-origin-nohead-'));
    git(remote, 'init', '--quiet', '-b', 'main');
    git(remote, 'config', 'user.email', 'test@example.com');
    git(remote, 'config', 'user.name', 'test');
    fs.mkdirSync(path.join(remote, 'apps/cli/bin'), { recursive: true });
    fs.writeFileSync(path.join(remote, 'apps/cli/package.json'), JSON.stringify({ version: '1.2.3' }));
    fs.writeFileSync(path.join(remote, 'apps/cli/bin/embedded.provisionprofile'), 'PROFILE-BYTES');
    git(remote, 'add', '-A');
    git(remote, 'commit', '--quiet', '-m', 'v1.2.3 tree, profile already in it');
    git(remote, 'tag', 'v1.2.3');

    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-snippet-homebase-nohead-'));
    fs.mkdirSync(repoRoot, { recursive: true });
    git(repoRoot, 'init', '--quiet');
    git(repoRoot, 'remote', 'add', 'origin', remote);
    git(repoRoot, 'fetch', '--quiet', 'origin');
    // Whether `fetch` itself populates refs/remotes/origin/HEAD varies by git
    // version (observed: git 2.43 leaves it unset here, git 2.54 sets it) --
    // delete it explicitly so the precondition this test exercises is
    // deterministic across environments, rather than an accident of git's
    // fetch-time behavior on this runner.
    spawnSync('git', ['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD'], { cwd: repoRoot });
    expect(() => git(repoRoot, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD')).toThrow();

    const gen = spawnSync('bash', ['-c', `${FUNC_SRC}\nhome_base_wt_snippet "1.2.3"`], {
      encoding: 'utf-8',
      env: { ...process.env, RELEASE_HOME_BASE: 'test-home-base' },
    });
    expect(gen.status, gen.stderr).toBe(0);

    const seedOnly = `${gen.stdout.split('cd "$WT/apps/cli"')[0]}\ncat "$WT/apps/cli/bin/embedded.provisionprofile"`;
    const run = spawnSync('bash', ['-c', seedOnly], { cwd: repoRoot, encoding: 'utf-8' });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain('PROFILE-BYTES');
  });
});
