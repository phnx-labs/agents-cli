import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
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

describeRelease('release.sh PR-head synchronization', () => {
  it('pins CI to the exact release commit instead of GitHub\'s eventually consistent PR head', () => {
    const waitFunction = RELEASE_SH.match(
      /wait_for_ci_green\(\) \{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.body;

    expect(waitFunction).toBeDefined();
    expect(waitFunction).toContain('local pr="$1" head_sha="${2:-}"');
    expect(waitFunction).not.toContain('gh pr view');
    expect(RELEASE_SH).toContain('RELEASE_CI_HEAD="$EXISTING_HEAD"');
    expect(RELEASE_SH.match(/RELEASE_CI_HEAD="\$RELEASE_COMMIT"/g)).toHaveLength(2);
    expect(RELEASE_SH).toContain('wait_for_ci_green "$PR_NUMBER" "$RELEASE_CI_HEAD"');
    expect(RELEASE_SH).not.toContain('wait_for_ci_green "$PR_NUMBER" "$RELEASE_COMMIT"');
    expect(RELEASE_SH).toContain(
      'wait_for_ci_green "$MERGED_RELEASE_PR" "$CI_TESTED_HEAD"',
    );
  });

  it('waits on the stable aggregate test context, not internal CLI job names', () => {
    const expectedChecks = RELEASE_SH.match(
      /EXPECTED_CHECKS=\((?<checks>[\s\S]*?)\)\n# The Windows/,
    )?.groups?.checks;

    expect(expectedChecks).toBeDefined();
    expect(expectedChecks).toContain('test gitleaks');
    expect(expectedChecks).not.toContain('test-shard');
    expect(expectedChecks).not.toContain('typecheck');
    expect(expectedChecks).not.toContain('compiled-smoke');
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
