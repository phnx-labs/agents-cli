import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const SH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'publish-computer-win.sh');

/**
 * The tag IS the publish action for the Windows helper — `release-exe` in
 * computer-helper-win.yml fires on `computer-win/v*` and nothing else uploads
 * that exe. So a mis-shaped tag is a silent no-op, not an error, which is
 * precisely why the argument guards are worth pinning.
 *
 * Every case drives the REAL script — real bash, real git, no mocking — but
 * inside a throwaway repo whose `origin` is a bare repo on local disk.
 *
 * That indirection is load-bearing. The script's existing-tag guard reads
 *
 *     git rev-parse -q --verify "refs/tags/$TAG" || git ls-remote --tags origin "$TAG"
 *
 * and `||` means every invocation that reaches the guard while the tag is
 * ABSENT falls through to `git ls-remote origin` — a live network round trip.
 * Measured against the real origin: 1.15s with the tag absent versus 0.02s once
 * the ref resolves locally, i.e. the same cost as a bare `git ls-remote`. So the
 * dry-run case was a network test wearing a unit test's clothes: it depended on
 * reachability and on this checkout having credentials for origin, and against a
 * blackholed remote it hangs for the full timeout instead of failing.
 *
 * Pointing `origin` at a path on disk keeps the real code path intact while
 * making the remote lookup structurally incapable of leaving the machine. It
 * also stops the immutability case mutating the shared clone's tags — tags are
 * repo-global, not worktree-local, so a fixed tag name collides with any
 * concurrent worktree of the same clone.
 */
let tmp: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** Invoke the script under test inside the hermetic repo. */
const run = (...args: string[]) =>
  spawnSync('bash', [path.join(repo, 'cli', 'scripts', path.basename(SH)), ...args], {
    encoding: 'utf-8',
  });

beforeAll(() => {
  // realpathSync: on macOS $TMPDIR is a /var -> /private/var symlink, and git
  // reports the resolved path, which would make path comparisons surprising.
  tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'publish-computer-win-'));
  const origin = path.join(tmp, 'origin.git');
  repo = path.join(tmp, 'work');

  git(tmp, 'init', '--bare', '-q', origin);
  fs.mkdirSync(path.join(repo, 'cli', 'scripts'), { recursive: true });
  git(tmp, 'init', '-q', repo);
  // Identity is per-repo so the commit below works on a box with no global one.
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'publish-computer-win test');

  fs.copyFileSync(SH, path.join(repo, 'cli', 'scripts', path.basename(SH)));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'seed commit for the publish guard');
  git(repo, 'remote', 'add', 'origin', origin);
});

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('publish-computer-win.sh', () => {
  it('resolves origin without leaving the machine', () => {
    // Guards the guard: if origin ever stops being a local path, every case
    // below silently becomes a network test again — the exact regression this
    // file exists to prevent.
    const url = git(repo, 'remote', 'get-url', 'origin');
    expect(path.isAbsolute(url)).toBe(true);
    expect(fs.existsSync(url)).toBe(true);
  });

  it('defaults to dry-run — cutting a release is never accidental', () => {
    const r = run('9.9.9');
    expect(r.status, r.stderr).toBe(0);
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
    const version = '0.0.1';
    const tag = `computer-win/v${version}`;

    // Prove the guard is what fires, not the version validator: the same
    // version reaches DRY-RUN while the tag is absent...
    const before = run(version);
    expect(before.status, before.stderr).toBe(0);
    expect(before.stdout).toContain('DRY-RUN');

    git(repo, 'tag', tag);
    // ...and is refused once it exists. No `finally` cleanup needed: the tag
    // lives in the throwaway repo, which afterAll deletes wholesale.
    const after = run(version);
    expect(after.status).not.toBe(0);
    expect(after.stderr).toMatch(/already exists/);
  });

  it('refuses a tag that exists only on origin', () => {
    // The local half of the guard cannot see it, so this is what the
    // `|| git ls-remote origin` arm is actually for — and it was previously
    // unpinned, which is how the network dependency went unnoticed.
    const version = '0.0.2';
    const tag = `computer-win/v${version}`;
    const originUrl = git(repo, 'remote', 'get-url', 'origin');

    const seed = path.join(tmp, 'seed');
    git(tmp, 'clone', '-q', repo, seed);
    git(seed, 'tag', tag);
    git(seed, 'push', '-q', originUrl, tag);

    expect(spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { cwd: repo })
      .status).not.toBe(0);

    const r = run(version);
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
    // exists but its macOS sibling does not, the pair has drifted. Checked
    // against the REAL scripts dir, not the hermetic copy.
    expect(fs.existsSync(path.join(path.dirname(SH), 'publish-computer-helper-mac.sh'))).toBe(true);
  });
});
