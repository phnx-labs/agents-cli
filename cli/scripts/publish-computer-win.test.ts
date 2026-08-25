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
    const r = run('1.0.0');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/already exists/);
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
