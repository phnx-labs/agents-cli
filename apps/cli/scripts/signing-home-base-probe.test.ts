/**
 * The signing home-base preflight, run against the REAL probe script.
 *
 * The case that matters is RUSH-2535: `release.sh --device zion` (the documented
 * "mac-mini is down" fallback) ran the whole flow -- crabbox tests, merge the PR,
 * push the tag -- and only THEN discovered zion cannot sign, leaving a
 * tagged-but-UNPUBLISHED release (npm at 1.22.35 with v1.22.36 tagged). The probe
 * moves that discovery to the front: an unprovisioned box must fail here, before
 * any git mutation.
 *
 * A fully green OK requires a real provisioned Mac (a Developer ID identity in a
 * headless-unlockable keychain + the apple.com/npmjs.com bundles) -- the release
 * itself exercises that path. On any box we can still assert the two things that
 * make the preflight worth having: it FAILS on an unprovisioned box, and it is
 * READ-ONLY, so running it can never advance a release. We also pin release.sh's
 * call ordering so the check runs before the crabbox, PR, merge, and tag.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const PROBE = path.resolve(__dirname, 'signing-home-base-probe.sh');
const RELEASE = path.resolve(__dirname, 'release.sh');

/** Run the real probe against a synthetic checkout root. */
function probe(repoRoot: string) {
  const r = spawnSync('bash', [PROBE], {
    encoding: 'utf-8',
    env: { ...process.env, SIGNING_PROBE_REPO_ROOT: repoRoot },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** A temp checkout, with or without the committed provisioning profile. */
function fixtureRepo(withProfile: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-probe-'));
  if (withProfile) {
    const binDir = path.join(root, 'apps/cli/bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'embedded.provisionprofile'), 'PROFILE');
  }
  return root;
}

describe('signing home-base probe: an unprovisioned box fails fast', () => {
  it('exits non-zero when the checkout has no provisioning profile', () => {
    const { status, out } = probe(fixtureRepo(false));
    expect(status).not.toBe(0);
    expect(out).toContain('embedded.provisionprofile');
  });

  it('the provisionprofile gate passes once the profile is present', () => {
    // Deterministic cross-platform signal: seeding the committed profile removes
    // that specific grievance. The remaining gaps (macOS codesign/keychain, the
    // apple.com/npmjs.com bundles) are exactly the ones that need a real Mac, and
    // are why an unprovisioned --device fallback must not sign.
    const { out } = probe(fixtureRepo(true));
    expect(out).not.toContain('embedded.provisionprofile');
  });

  it('never reports OK on a box missing the signing credentials', () => {
    // Guard against the probe rounding up to success: a box without the Developer
    // ID cert / apple.com / npmjs.com bundles is not a home base even with the
    // profile present. (On a genuinely provisioned Mac this test box would print
    // OK -- that is the release's own happy path, not this unit's job to fake.)
    const provisioned =
      process.platform === 'darwin' &&
      spawnSync('bash', ['-c', "security find-identity -v -p codesigning 2>/dev/null | grep -q 'Developer ID Application'"])
        .status === 0;
    if (provisioned) return; // real signing box: OK is correct, nothing to assert here
    const { status, out } = probe(fixtureRepo(true));
    expect(status).not.toBe(0);
    expect(out).not.toContain('OK\n');
  });
});

/** Run a git command, throwing on failure. */
function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${r.stderr}`);
  }
  return r.stdout;
}

/**
 * A "new home base" fixture: a real git checkout whose LOCAL branch and
 * working tree predate the commit that added embedded.provisionprofile, but
 * whose `origin` remote (a second local repo, standing in for GitHub) already
 * has it on `main` -- exactly RUSH-2541's "a Mac that has not previously been
 * home base": its own on-disk checkout has simply never been pulled forward.
 */
function staleHomeBaseFixture(): string {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-probe-origin-'));
  git(remote, 'init', '--quiet', '-b', 'main');
  git(remote, 'config', 'user.email', 'test@example.com');
  git(remote, 'config', 'user.name', 'test');
  git(remote, 'commit', '--quiet', '--allow-empty', '-m', 'before the profile existed');

  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-probe-checkout-'));
  git(checkout, 'clone', '--quiet', remote, '.');
  git(checkout, 'config', 'user.email', 'test@example.com');
  git(checkout, 'config', 'user.name', 'test');

  // The remote gains the profile AFTER the clone -- the checkout's local main
  // and working tree never see it until something fetches origin/main, which
  // is exactly what the probe must now do.
  const binDir = path.join(remote, 'apps/cli/bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'embedded.provisionprofile'), 'PROFILE');
  git(remote, 'add', 'apps/cli/bin/embedded.provisionprofile');
  git(remote, 'commit', '--quiet', '-m', 'commit embedded.provisionprofile (2567004b4)');

  expect(fs.existsSync(path.join(checkout, 'apps/cli/bin/embedded.provisionprofile'))).toBe(false);
  return checkout;
}

describe('signing home-base probe: a new home base recovers via origin (RUSH-2541)', () => {
  it('passes the provisionprofile gate when the local checkout is stale but origin has it', () => {
    // Before this fix, the probe checked ONLY the on-disk working tree and
    // never fetched, so a legitimately new home base -- cloned before the
    // profile was committed, or simply never pulled since -- reported
    // "unprovisioned" forever, exactly like the box release.sh's own seed
    // step (home_base_wt_snippet) is built to recover from.
    const { out } = probe(staleHomeBaseFixture());
    expect(out).not.toContain('embedded.provisionprofile');
  });

  it('still fails the provisionprofile gate when neither the checkout nor origin has it', () => {
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-probe-origin-empty-'));
    git(remote, 'init', '--quiet', '-b', 'main');
    git(remote, 'config', 'user.email', 'test@example.com');
    git(remote, 'config', 'user.name', 'test');
    git(remote, 'commit', '--quiet', '--allow-empty', '-m', 'no profile ever');
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-probe-checkout-empty-'));
    git(checkout, 'clone', '--quiet', remote, '.');

    const { status, out } = probe(checkout);
    expect(status).not.toBe(0);
    expect(out).toContain('embedded.provisionprofile');
  });
});

describe('signing home-base probe: it cannot advance a release', () => {
  it('the probe performs no git/gh/npm mutations', () => {
    // The whole point is to fail BEFORE the merge + tag. A probe that itself ran
    // a mutation would defeat that, so assert the executable body carries none.
    // Strip comment lines and string-literal contents first, so a "npm publish"
    // in the docblock or an error string is not mistaken for a command.
    const code = fs
      .readFileSync(PROBE, 'utf-8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .map((l) => l.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''"))
      .join('\n');
    for (const banned of [
      /\bgit\s+(tag|push|commit|merge|worktree|checkout|switch|reset)\b/,
      /\bgh\s+pr\s+(create|merge)\b/,
      /\bnpm\s+publish\b/,
    ]) {
      expect(code).not.toMatch(banned);
    }
  });
});

describe('release.sh: the preflight gates the mutating phases', () => {
  it('calls assert_signing_home_base before the crabbox, PR, merge, and tag push', () => {
    const lines = fs.readFileSync(RELEASE, 'utf-8').replace(/\r/g, '').split('\n');
    const lineOf = (needle: RegExp) => {
      const i = lines.findIndex((l) => needle.test(l));
      expect(i, `expected to find ${needle} in release.sh`).toBeGreaterThanOrEqual(0);
      return i;
    };
    // The bare CALL (`assert_signing_home_base` on its own line), not the
    // definition (`assert_signing_home_base() {`), must precede every mutation.
    const call = lines.findIndex((l) => l.trim() === 'assert_signing_home_base');
    expect(call, 'expected a bare assert_signing_home_base call').toBeGreaterThanOrEqual(0);
    // Anchored patterns pin the mutation SITES (not the earlier function
    // definitions / the already-published missing-tag push at column 0 vs indent).
    expect(call).toBeLessThan(lineOf(/^\s*phase "Linux tests" "a crabbox"/)); // crabbox phase
    expect(call).toBeLessThan(lineOf(/^\s*gh pr merge "\$PR_NUMBER" --squash/)); // the merge
    expect(call).toBeLessThan(lineOf(/^git push origin "v\$TARGET"$/)); // the primary tag push
  });
});

/**
 * Execute the REAL `assert_signing_home_base` function body under the same
 * `set -euo pipefail` release.sh runs with. The static ordering test above
 * proves the call is placed right; this proves the function itself fails LOUD.
 *
 * The bug this guards (found in review of the first cut): `out="$(cmd)"; rc=$?`
 * under errexit terminates the script AT the assignment when the probe fails,
 * before `rc=$?` runs -- so the diagnostic dump and the `die` message were dead
 * code and the release aborted with no stated reason. The `&& rc=0 || rc=$?`
 * form is what keeps the die branch reachable.
 */
function runAssert(probeExit: 'fail' | 'pass'): { status: number | null; out: string } {
  // Extract the function definition (from its header to the first line that is a
  // bare `}` at column 0) rather than sourcing release.sh, which executes.
  const lines = fs.readFileSync(RELEASE, 'utf-8').replace(/\r/g, '').split('\n');
  const start = lines.findIndex((l) => l.startsWith('assert_signing_home_base() {'));
  expect(start, 'assert_signing_home_base() { not found').toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  expect(end, 'closing } for assert_signing_home_base not found').toBeGreaterThan(start);
  const fnBody = lines.slice(start, end + 1).join('\n');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-preflight-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  // Stand in for the probe with a real script on the exact path the function
  // invokes (`scripts/signing-home-base-probe.sh`, run in ON_HOME_BASE mode).
  const stub =
    probeExit === 'fail'
      ? "#!/usr/bin/env bash\nprintf 'MISSING: no cert\\n' >&2\nexit 1\n"
      : '#!/usr/bin/env bash\necho OK\nexit 0\n';
  fs.writeFileSync(path.join(dir, 'scripts/signing-home-base-probe.sh'), stub, { mode: 0o755 });

  // Harness: the real release.sh errexit settings + minimal stubs for the shell
  // helpers the function calls, then the real function body, then invoke it.
  const harness = [
    'set -euo pipefail',
    'ON_HOME_BASE=true',
    'RELEASE_HOME_BASE=testbox',
    'bold(){ :; }',
    "phase_ok(){ printf 'PHASE_OK: %s\\n' \"$1\"; }",
    "die(){ printf 'DIE: %s\\n' \"$1\" >&2; exit 1; }",
    fnBody,
    'assert_signing_home_base',
  ].join('\n');
  const harnessPath = path.join(dir, 'harness.sh');
  fs.writeFileSync(harnessPath, harness);
  const r = spawnSync('bash', [harnessPath], { cwd: dir, encoding: 'utf-8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('release.sh: assert_signing_home_base fails loud under set -e', () => {
  it('aborts with the actionable die message when the probe fails', () => {
    const { status, out } = runAssert('fail');
    expect(status).not.toBe(0);
    // The die branch MUST run -- the bug was that errexit skipped it entirely.
    expect(out).toContain('DIE:');
    expect(out).toContain('not a provisioned signing home base');
    expect(out).toContain('RUSH-2541');
    expect(out).toContain('MISSING: no cert'); // the probe's diagnostic is surfaced
  });

  it('reports phase_ok and exits 0 when the probe passes', () => {
    const { status, out } = runAssert('pass');
    expect(status).toBe(0);
    expect(out).toContain('PHASE_OK:');
    expect(out).not.toContain('DIE:');
  });
});
