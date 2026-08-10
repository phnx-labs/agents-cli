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
function stuck(
  registryLatest: string,
  tags: Array<[string, 'yes' | 'no']>,
  bump?: { kind: string; mainVersion: string },
) {
  const input = tags.map(([v, published]) => `${v} ${published}`).join('\n') + '\n';
  const args = bump ? [registryLatest, bump.kind, bump.mainVersion] : [registryLatest];
  const r = spawnSync('bash', [SCRIPT, ...args], { input, encoding: 'utf-8' });
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

describe('release.sh: every irreversible act is gated by the lease', () => {
  // Two separate review rounds each found an UNGATED push that the previous
  // round's fix had missed — first the already-published recovery tag, then the
  // main tag push on the branch where the local tag already exists. Both were
  // the same shape: the gate was attached to a conditional branch rather than to
  // the irreversible act itself. This walks the script and asserts the gate sits
  // on the act, so the next one is caught here instead of by a third reviewer.
  const LINES = fs
    .readFileSync(path.resolve(__dirname, 'release.sh'), 'utf-8')
    // Split on \r?\n: git's autocrlf checks out release.sh with CRLF on Windows,
    // and a bare .split('\n') leaves a trailing \r that defeats the $-anchored
    // `route_home_base_phase\s*\\?$` match below (RUSH-2215).
    .split(/\r?\n/);

  /** The nearest preceding non-blank, non-comment line(s) within `window`. */
  function precededByLeaseGate(idx: number, window = 6) {
    for (let i = idx - 1; i >= 0 && i >= idx - window; i--) {
      const l = LINES[i].trim();
      if (l === '' || l.startsWith('#')) continue;
      if (l.startsWith('require_lease')) return true;
    }
    return false;
  }

  it('every `git push origin "v$TARGET"` is preceded by require_lease', () => {
    const pushes = LINES.map((l, i) => ({ l, i })).filter(({ l }) =>
      /^\s*git push origin "v\$TARGET"/.test(l),
    );
    expect(pushes.length).toBeGreaterThan(0);
    const ungated = pushes.filter(({ i }) => !precededByLeaseGate(i));
    expect(ungated.map(({ i, l }) => `line ${i + 1}: ${l.trim()}`)).toEqual([]);
  });

  it('the squash-merge is preceded by require_lease', () => {
    const merges = LINES.map((l, i) => ({ l, i })).filter(({ l }) =>
      /^\s*gh pr merge /.test(l),
    );
    expect(merges.length).toBeGreaterThan(0);
    const ungated = merges.filter(({ i }) => !precededByLeaseGate(i, 8));
    expect(ungated.map(({ i, l }) => `line ${i + 1}: ${l.trim()}`)).toEqual([]);
  });

  it('the publish routing is preceded by require_lease', () => {
    const idx = LINES.findIndex((l) => /^\s*route_home_base_phase\s*\\?$/.test(l));
    expect(idx).toBeGreaterThan(-1);
    expect(precededByLeaseGate(idx)).toBe(true);
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


describe('stuck-release: the 2026-08-10 deadlock', () => {
  // npm at 1.22.35, main carrying 1.22.36, v1.22.36 tagged but unpublishable
  // (its CI-tested tree predates the prepack version-gate fix 1dffc78bc, so its
  // own `npm publish` rejects a correct binary). Both guards fired and each named
  // the other as the way out, so no version could ship at all.
  const TAGS: Array<[string, 'yes' | 'no']> = [
    ['1.22.35', 'yes'],
    ['1.22.36', 'no'],
  ];

  it('still blocks a plain patch bump past the stuck tag', () => {
    expect(stuck('1.22.35', TAGS, { kind: 'patch', mainVersion: '1.22.36' })).toBe('1.22.36');
  });

  it('lets patch-from-main step over main own unpublishable version', () => {
    expect(stuck('1.22.35', TAGS, { kind: 'patch-from-main', mainVersion: '1.22.36' })).toBeNull();
  });

  it('does not exempt a stuck tag that is NOT main own version', () => {
    // A release that genuinely died between tag and publish still blocks, even
    // under patch-from-main — otherwise the exemption would reopen the gap-widening
    // bug this whole script exists to prevent.
    expect(
      stuck(
        '1.22.35',
        [
          ['1.22.36', 'no'],
          ['1.22.37', 'no'],
        ],
        { kind: 'patch-from-main', mainVersion: '1.22.37' },
      ),
    ).toBe('1.22.36');
  });

  it('keeps blocking when no bump kind is supplied (unchanged default)', () => {
    expect(stuck('1.22.35', TAGS)).toBe('1.22.36');
  });
});
