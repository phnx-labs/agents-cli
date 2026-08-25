import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const SH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'publish-computer-win.sh');
const run = (...args: string[]) => spawnSync('bash', [SH, ...args], { encoding: 'utf-8' });

/**
 * The tag IS the publish action for the Windows helper — `release-exe` in
 * computer-helper-win.yml fires on `computer-win/v*` and nothing else uploads
 * that exe. So a mis-shaped tag is a silent no-op, not an error, which is
 * precisely why the argument guards are worth pinning.
 */
describe('publish-computer-win.sh', () => {
  it('defaults to dry-run — cutting a release is never accidental', () => {
    const r = run('9.9.9');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('DRY-RUN');
    expect(`${r.stdout}${r.stderr}`).toContain('computer-win/v9.9.9');
  });

  it('refuses a v-prefixed version rather than cutting computer-win/vv1.0.1', () => {
    const r = run('v1.0.1');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/bare X\.Y\.Z/);
  });

  it('refuses a non-semver version', () => {
    expect(run('1.0').status).not.toBe(0);
    expect(run('latest').status).not.toBe(0);
  });

  it('refuses an existing tag — a helper release is immutable', () => {
    // The asset upload uses --clobber, so re-tagging would silently replace a
    // binary an installed CLI already pins to that exact version.
    //
    // Drives the guard with a LOCAL tag on a valid semver. Two earlier versions
    // of this test were wrong in different ways, both worth recording:
    //   1. asserting against the real published `computer-win/v1.0.0` made the
    //      test depend on network reachability AND repo credentials — it passed
    //      locally and failed on a fleet worker, reporting the network rather
    //      than the behaviour;
    //   2. using a non-semver probe version passed for the WRONG REASON, because
    //      the version validator rejects the shape before the tag check runs.
    const REPO = path.dirname(path.dirname(SH));
    const probe = '0.0.1';
    const tag = `computer-win/v${probe}`;
    // Prove the guard is what fires: the same version passes validation and
    // reaches DRY-RUN while the tag is absent...
    const before = run(probe);
    expect(before.status, before.stderr).toBe(0);
    expect(before.stdout).toContain('DRY-RUN');

    spawnSync('git', ['tag', tag], { cwd: REPO });
    try {
      // ...and is refused once it exists.
      const after = run(probe);
      expect(after.status).not.toBe(0);
      expect(after.stderr).toMatch(/already exists/);
    } finally {
      spawnSync('git', ['tag', '-d', tag], { cwd: REPO });
    }
  });

  it('refuses an unknown flag rather than ignoring it', () => {
    const r = run('1.0.1', '--force');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unknown flag/);
  });

  it('is the symmetric counterpart of the macOS helper publisher', () => {
    // One script per helper, each cutting that helper's own tag. If this file
    // exists but its macOS sibling does not, the pair has drifted.
    expect(fs.existsSync(path.join(path.dirname(SH), 'publish-computer-helper-mac.sh'))).toBe(true);
  });
});
