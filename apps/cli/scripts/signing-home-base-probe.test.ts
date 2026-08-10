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
    const lines = fs.readFileSync(RELEASE, 'utf-8').split('\n');
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
