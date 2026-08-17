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
    expect(out).toContain('home base (mac-mini) must be macOS');
  });

  it('routes the privileged phase to --device <name>', () => {
    const { out } = runRelease('1.2.3', '--device', 'zion', '--home-base-phase');
    expect(out).toContain('home base (zion) must be macOS');
  });

  it('accepts --host as an alias for --device', () => {
    const { out } = runRelease('1.2.3', '--host', 'pinnacles', '--home-base-phase');
    expect(out).toContain('home base (pinnacles) must be macOS');
  });

  it('accepts the --device=<name> glued form', () => {
    const { out } = runRelease('1.2.3', '--device=zion', '--home-base-phase');
    expect(out).toContain('home base (zion) must be macOS');
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
