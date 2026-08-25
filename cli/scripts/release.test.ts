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
    // ...but only behind the opt-in. An ordinary release publishes the CLI and
    // nothing else; helpers live on their own tags now.
    expect(RELEASE_SH).toContain('--with-helpers) WITH_HELPERS=true');
    expect(RELEASE_SH).toContain('WITH_HELPERS=false');
    expect(RELEASE_SH).not.toContain('sign-cli-binary.sh');
    expect(RELEASE_SH).not.toContain('publish-computer-helper-mac.sh');
    expect(RELEASE_SH).not.toContain('menubar/scripts/build.sh release');
    expect(RELEASE_SH).toContain('rebuild/notarization is outside the ordinary release path');
  });
});

describeRelease('release.sh: an ordinary release is CLI-only', () => {
  /**
   * The default path must do NO helper work. Two couplings made that false and
   * each is asserted separately, because they fail differently:
   *
   *  - staging `ComputerHelper.app.zip` onto `v$TARGET` publishes an asset no
   *    client requests (helpers resolve from their own tags), and
   *  - `release-manifest.sh require` re-derives every helper's input digest and
   *    ABORTS when one moved without a rebuild — so editing Swift the CLI does
   *    not ship could fail a perfectly good CLI release.
   */
  /**
   * True when `needle` sits INSIDE an open `if [[ "$WITH_HELPERS" == true ]]`.
   *
   * Two earlier versions were defeated, both caught by mutation rather than by
   * reading:
   *   1. "nearest preceding WITH_HELPERS conditional" — passed even when the
   *      needle's own gate was deleted, because an EARLIER block's `if` remained.
   *   2. "no `\n  fi` between" — depended on the closing `fi` being indented
   *      exactly two spaces, so reindenting an unrelated earlier gate's `fi` by
   *      one space made a fully un-gated needle read as gated.
   *
   * Both failures came from pattern-matching text. This counts BLOCK DEPTH
   * instead: walk from the gate to the needle and track opens (`if`/`for`/`while`
   * /`case`) against closes (`fi`/`done`/`esac`). The needle is gated only if the
   * gate's own block never closed. Indentation is irrelevant.
   */
  const isGated = (needle: string): boolean => {
    const at = RELEASE_SH.indexOf(needle);
    expect(at, `${needle} not found`).toBeGreaterThan(-1);
    const before = RELEASE_SH.slice(0, at);
    const gate = before.lastIndexOf('if [[ "$WITH_HELPERS" == true ]]');
    if (gate === -1) return false;
    let depth = 1; // the gate's own `if`
    for (const raw of before.slice(gate).split('\n').slice(1)) {
      const line = raw.trim();
      if (/^(if|for|while|case)\b/.test(line)) depth += 1;
      else if (/^(fi|done|esac)\b/.test(line)) depth -= 1;
      if (depth === 0) return false; // the gate closed before the needle
    }
    return depth > 0;
  };

  it('stages the computer-mac asset only under --with-helpers', () => {
    expect(isGated('--helper computer-mac --asset-path')).toBe(true);
  });

  it('verifies the helper manifest only under --with-helpers', () => {
    // Unguarded, this is the assertion that fails a CLI-only release for a
    // helper source change it does not ship.
    expect(isGated('release-manifest.sh require')).toBe(true);
  });

  it('defaults the flag OFF, so CLI-only is what you get without asking', () => {
    expect(RELEASE_SH).toMatch(/^WITH_HELPERS=false$/m);
  });

  it('lists EVERY flag its parser accepts in --help (executed, not grepped)', () => {
    // Runs the real script. The content-assertion version of this test passed
    // while --help silently omitted --with-helpers, because it only checked that
    // one known string appeared. This derives the flag set from the parser and
    // compares it against actual --help OUTPUT, so the next flag someone adds is
    // covered without anyone remembering to extend the test.
    const help = spawnSync('bash', [RELEASE_SH_PATH, '--help'], { encoding: 'utf-8' });
    expect(help.status, help.stderr).toBe(0);

    // Flags the `case` arms accept, minus the internal phase markers (deliberately
    // undocumented) and --help itself.
    const INTERNAL = new Set(['--home-base-phase', '--orchestration-phase', '-h', '--help']);
    // Aliases are satisfied by their primary being documented — `--help` should
    // teach one spelling, not every accepted synonym.
    const ALIAS_OF: Record<string, string> = { '--host': '--device', '-y': '--yes' };
    const parsed = new Set<string>();
    for (const arm of RELEASE_SH.matchAll(/^\s{4}(-[^)]+)\)/gm)) {
      for (const flag of arm[1].split('|')) {
        const name = flag.trim().replace(/=\*$/, '');
        // `--*)` is the unknown-flag catch-all, not a flag.
        if (name === '--*' || !name.startsWith('-')) continue;
        if (INTERNAL.has(name)) continue;
        parsed.add(ALIAS_OF[name] ?? name);
      }
    }
    expect(parsed.size, 'no flags parsed out of the case arms').toBeGreaterThan(3);

    const missing = [...parsed].filter((f) => !help.stdout.includes(f));
    expect(missing, `--help omits: ${missing.join(', ')}`).toEqual([]);
  });

  it('warns that a new flag is inert until merged, because the script re-execs from origin', () => {
    // release.sh:190 execs release-worktree.sh, which checks out
    // `origin/$DEFAULT_BRANCH` and re-runs THIS script from there. The second
    // parse is the MERGED copy, so an unmerged flag dies as `unknown flag` even
    // though the local parser handles it. No content assertion can catch that —
    // they read the working tree, the failure is in another copy — so the trap is
    // pinned as prose instead, next to the parser it bites.
    expect(RELEASE_SH).toContain('A NEW FLAG DOES NOT WORK UNTIL IT IS ON origin/<default>');
    expect(RELEASE_SH).toContain('--orchestration-phase');
  });

  it('builds the download patterns as an array, never a word-split splice', () => {
    // A `$( ... )` splice here is word-split by the shell — the same class of bug
    // that silently dropped vitest args in test.sh — and an empty splice trips
    // `set -u`.
    expect(RELEASE_SH).toContain('dl_patterns=(');
    expect(RELEASE_SH).toContain('"${dl_patterns[@]}"');
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
    fs.mkdirSync(path.join(remote, 'cli'), { recursive: true });
    fs.writeFileSync(path.join(remote, 'cli/package.json'), JSON.stringify({ version: '1.2.3' }));
    git(remote, 'add', '-A');
    git(remote, 'commit', '--quiet', '-m', 'v1.2.3 tree, no profile yet');
    git(remote, 'tag', 'v1.2.3');

    // REPO_ROOT: the home base's own checkout, cloned BEFORE the profile commit
    // lands on origin and never advanced since -- a stale local branch/working
    // tree even though origin (fetched below) is current.
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-snippet-homebase-'));
    git(repoRoot, 'clone', '--quiet', remote, '.');
    expect(fs.existsSync(path.join(repoRoot, 'cli/bin/embedded.provisionprofile'))).toBe(false);

    fs.mkdirSync(path.join(remote, 'cli/bin'), { recursive: true });
    fs.writeFileSync(path.join(remote, 'cli/bin/embedded.provisionprofile'), 'PROFILE-BYTES');
    git(remote, 'add', '-A');
    git(remote, 'commit', '--quiet', '-m', 'commit embedded.provisionprofile (2567004b4)');

    const gen = spawnSync('bash', ['-c', `${FUNC_SRC}\nhome_base_wt_snippet "1.2.3"`], {
      encoding: 'utf-8',
      env: { ...process.env, RELEASE_HOME_BASE: 'test-home-base' },
    });
    expect(gen.status, gen.stderr).toBe(0);

    // Run just the seeding portion of the generated snippet (stop short of
    // `cd "$WT/cli"; scripts/release.sh ...`, which needs the real CLI
    // installed) and cat the recovered file back out BEFORE the snippet's own
    // EXIT trap removes the worktree.
    const seedOnly = `${gen.stdout.split('cd "$WT/')[0]}\ncat "$WT/cli/bin/embedded.provisionprofile"`;
    const run = spawnSync('bash', ['-c', seedOnly], { cwd: repoRoot, encoding: 'utf-8' });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain('PROFILE-BYTES');
  });

  it('fails loudly, not a warning, when the profile is absent everywhere', () => {
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-snippet-origin-empty-'));
    git(remote, 'init', '--quiet', '-b', 'main');
    git(remote, 'config', 'user.email', 'test@example.com');
    git(remote, 'config', 'user.name', 'test');
    fs.mkdirSync(path.join(remote, 'cli'), { recursive: true });
    fs.writeFileSync(path.join(remote, 'cli/package.json'), JSON.stringify({ version: '1.2.3' }));
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

    const seedOnly = gen.stdout.split('cd "$WT/')[0];
    const run = spawnSync('bash', ['-c', seedOnly], { cwd: repoRoot, encoding: 'utf-8' });
    expect(run.status).not.toBe(0); // fails fast, not a "warning" that limps forward
    expect(run.stderr).toContain('not found on the tagged tree');
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
    fs.mkdirSync(path.join(remote, 'cli/bin'), { recursive: true });
    fs.writeFileSync(path.join(remote, 'cli/package.json'), JSON.stringify({ version: '1.2.3' }));
    fs.writeFileSync(path.join(remote, 'cli/bin/embedded.provisionprofile'), 'PROFILE-BYTES');
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

    const seedOnly = `${gen.stdout.split('cd "$WT/')[0]}\ncat "$WT/cli/bin/embedded.provisionprofile"`;
    const run = spawnSync('bash', ['-c', seedOnly], { cwd: repoRoot, encoding: 'utf-8' });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain('PROFILE-BYTES');
  });
});

// RUSH-3189 flatten: pkg_version_at_ref must read the recorded version from a
// POST-flatten ref (cli/package.json) and from a PRE-flatten tag
// (apps/cli/package.json) — the fallback that keeps the catch-up-publish and
// stuck-tag guards working against tags cut before the rename. Fixtures build
// both layouts synthetically; nothing here depends on this repo's own history.
describe('release.sh: pkg_version_at_ref resolves both layouts (RUSH-3189)', () => {
  const fnSource = (): string => {
    const sh = fs.readFileSync(path.join(__dirname, 'release.sh'), 'utf8');
    const m = sh.match(/pkg_version_at_ref\(\) \{[\s\S]*?\n\}/);
    if (!m) throw new Error('pkg_version_at_ref not found in release.sh');
    return m[0];
  };
  const mkRepo = (): string => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-flatten-ref-'));
    const git = (...args: string[]) => {
      const r = spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout;
    };
    git('init', '-q', '-b', 'main');
    fs.mkdirSync(path.join(repo, 'apps/cli'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'apps/cli/package.json'), JSON.stringify({ version: '1.22.40' }));
    git('add', '-A'); git('commit', '-qm', 'pre-flatten'); git('tag', 'v-pre');
    git('mv', 'apps/cli', 'cli');
    fs.writeFileSync(path.join(repo, 'cli/package.json'), JSON.stringify({ version: '1.22.50'}));
    git('add', '-A'); git('commit', '-qm', 'post-flatten'); git('tag', 'v-post');
    return repo;
  };
  const readAt = (repo: string, ref: string) =>
    spawnSync('bash', ['-c', `${fnSource()}\npkg_version_at_ref ${ref}`], { cwd: repo, encoding: 'utf8' });

  it('reads cli/package.json from a post-flatten ref', () => {
    const repo = mkRepo();
    try {
      const r = readAt(repo, 'v-post');
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('1.22.50');
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });

  it('falls back to apps/cli/package.json for a pre-flatten tag', () => {
    const repo = mkRepo();
    try {
      const r = readAt(repo, 'v-pre');
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('1.22.40');
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });

  it('echoes nothing when neither layout exists at the ref', () => {
    const repo = mkRepo();
    try {
      const r = spawnSync('bash', ['-c', `${fnSource()}\nexport GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t && EMPTY=$(git hash-object -t tree /dev/null) && C=$(git commit-tree "$EMPTY" -m x) && pkg_version_at_ref "$C"`], { cwd: repo, encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });
});
