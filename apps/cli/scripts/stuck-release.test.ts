/**
 * Detecting the release that died between `git tag` and `npm publish`, by
 * running the REAL script.
 *
 * The case that matters is the one that actually happened on 2026-08-02: npm at
 * 1.20.78, main at 1.20.81, v1.20.80 and v1.20.81 tagged but never published. If
 * this returns nothing there, release.sh cuts 1.20.82 on top and the gap widens
 * by one — which is precisely how a one-version gap became a three-version gap.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, 'stuck-release.sh');

/** Run the real script. Returns the stuck version, or null when nothing is stuck. */
function stuck(registryLatest: string, tags: Array<[string, 'yes' | 'no']>) {
  const input = tags.map(([v, published]) => `${v} ${published}`).join('\n') + '\n';
  const r = spawnSync('bash', [SCRIPT, registryLatest], { input, encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

describe('stuck-release: the 2026-08-02 jam', () => {
  it('finds the oldest unpublished tag ahead of the registry', () => {
    expect(
      stuck('1.20.78', [
        ['1.20.77', 'yes'],
        ['1.20.78', 'yes'],
        ['1.20.80', 'no'],
        ['1.20.81', 'no'],
      ]),
    ).toBe('1.20.80');
  });

  it('is order-independent — tags come back from git unsorted', () => {
    expect(
      stuck('1.20.78', [
        ['1.20.81', 'no'],
        ['1.20.80', 'no'],
      ]),
    ).toBe('1.20.80');
  });
});

describe('stuck-release: nothing stuck', () => {
  it('reports nothing when every tag is published', () => {
    expect(
      stuck('1.20.81', [
        ['1.20.79', 'yes'],
        ['1.20.80', 'yes'],
        ['1.20.81', 'yes'],
      ]),
    ).toBeNull();
  });

  it('ignores tags at or behind the registry', () => {
    // An old tag that npm never got (a yanked or pre-registry version) is not a
    // stuck release — the registry has moved past it, and blocking on it would
    // wedge every future release instead of unwedging one.
    expect(
      stuck('1.20.81', [
        ['1.20.50', 'no'],
        ['1.20.81', 'no'],
      ]),
    ).toBeNull();
  });

  it('reports nothing for an empty tag list', () => {
    expect(stuck('1.20.81', [])).toBeNull();
  });
});

describe('stuck-release: release.sh must consume the tag list fail-closed', () => {
  // This pins a bug that was actually shipped in this PR's first draft and only
  // caught on a second pass. `remote_version_tags` calls `die` when it cannot
  // read origin, so the guard looks fail-closed — but if release.sh consumes it
  // as `done < <(remote_version_tags)`, the `die` exits only the process
  // substitution's SUBSHELL. The loop then reads an empty list, no stuck tag is
  // found, and the release bumps straight past the stuck version: fail-OPEN,
  // the exact widening the guard exists to prevent.
  const RELEASE_SH = fs.readFileSync(path.resolve(__dirname, 'release.sh'), 'utf-8');

  it('demonstrates why: die inside a process substitution does NOT abort the script', () => {
    const script = `
      set -euo pipefail
      die() { echo "DIED" >&2; exit 1; }
      gather() { false || die "cannot read"; }
      while read -r a; do :; done < <(gather)
      echo "CONTINUED"
    `;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
    // The subshell died, yet the script ran to completion and exited 0.
    expect(r.stdout).toContain('CONTINUED');
    expect(r.status).toBe(0);
  });

  it('demonstrates the safe form: a command substitution does abort it', () => {
    const script = `
      set -euo pipefail
      die() { echo "DIED" >&2; exit 1; }
      gather() { false || die "cannot read"; }
      RAW="$(gather)"
      while read -r a; do :; done <<< "$RAW"
      echo "CONTINUED"
    `;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
    expect(r.stdout).not.toContain('CONTINUED');
    expect(r.status).toBe(1);
  });

  it('release.sh uses the safe form', () => {
    expect(RELEASE_SH).toMatch(/REMOTE_TAG_LINES="\$\(remote_version_tags\)"/);
    // The unsafe form must not appear as actual code. It is named once in a
    // comment explaining the trap, so match a line that is not a comment.
    const unsafe = RELEASE_SH.split('\n').filter(
      (l) => !l.trimStart().startsWith('#') && l.includes('< <(remote_version_tags)'),
    );
    expect(unsafe).toEqual([]);
  });
});

describe('stuck-release: version ordering', () => {
  it('sorts numerically, not lexically', () => {
    // The bug a plain string compare would hide: "1.20.9" > "1.20.10" lexically.
    expect(
      stuck('1.20.8', [
        ['1.20.10', 'no'],
        ['1.20.9', 'no'],
      ]),
    ).toBe('1.20.9');
  });

  it('crosses a minor boundary correctly', () => {
    expect(
      stuck('1.20.81', [
        ['1.21.0', 'no'],
        ['1.20.81', 'yes'],
      ]),
    ).toBe('1.21.0');
  });

  it('skips malformed tag names rather than choking on them', () => {
    expect(
      stuck('1.20.78', [
        ['1.20.80-rc1' as string, 'no'],
        ['not-a-version' as string, 'no'],
        ['1.20.80', 'no'],
      ]),
    ).toBe('1.20.80');
  });
});
