import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const SH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'publish-computer-helper-mac.sh',
);

/**
 * The tag IS the publish action for the macOS helper, exactly as it is for
 * Windows — `download.ts` resolves `computer-mac/v<x.y.z>` from the floor in
 * helper-versions.ts, and nothing else uploads that asset. This script used to
 * publish to the CLI's `v<version>` tag, which put the binary at an address no
 * client requests and left no way to cut a helper release at all (PHNX-3228).
 *
 * Everything below drives the REAL script inside a throwaway repo whose `origin`
 * is a bare repo on local disk, so the guard's `git ls-remote origin` arm is a
 * filesystem operation and can never reach the network — the same sealing the
 * Windows publisher's tests use, and for the same reason: with the tag absent,
 * `||` falls through to a live remote lookup.
 *
 * `uname` is stubbed to report Darwin. The script's macOS gate fires before
 * every other guard, so without it the argument and immutability guards would be
 * unreachable on the Linux CI runner and this file would assert nothing there.
 * Only the OS probe is stubbed; the logic under test is the real script.
 */
let tmp: string;
let repo: string;
let binDir: string;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const run = (...args: string[]) => {
  // Strip the notary credentials, ALWAYS. The script's creds check is the last
  // thing standing between a guard test and the real publish path: with the tag
  // absent, `0.0.1` clears the immutability guard and, if APPLE_* happen to be
  // in the environment, goes on to source the signing context, build + notarize
  // the helper, and `gh release create` + upload for real. The release flow runs
  // under `agents secrets exec apple.com`, so inheriting the ambient env would
  // make that a live possibility rather than a theoretical one. Deleting them
  // here makes publishing structurally unreachable from this file.
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
  delete env.APPLE_ID;
  delete env.APPLE_APP_SPECIFIC_PASSWORD;
  delete env.APPLE_TEAM_ID;
  return spawnSync('bash', [path.join(repo, 'cli', 'scripts', path.basename(SH)), ...args], {
    encoding: 'utf-8',
    env,
  });
};

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'publish-mac-helper-'));
  const origin = path.join(tmp, 'origin.git');
  repo = path.join(tmp, 'work');
  binDir = path.join(tmp, 'bin');

  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'uname'), '#!/bin/sh\necho Darwin\n');
  fs.chmodSync(path.join(binDir, 'uname'), 0o755);

  git(tmp, 'init', '--bare', '-q', origin);
  fs.mkdirSync(path.join(repo, 'cli', 'scripts'), { recursive: true });
  git(tmp, 'init', '-q', repo);
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'publish-mac-helper test');
  fs.copyFileSync(SH, path.join(repo, 'cli', 'scripts', path.basename(SH)));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'seed commit for the publish guard');
  git(repo, 'remote', 'add', 'origin', origin);
});

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('publish-computer-helper-mac.sh', () => {
  it('resolves origin without leaving the machine', () => {
    const url = git(repo, 'remote', 'get-url', 'origin');
    expect(path.isAbsolute(url)).toBe(true);
    expect(fs.existsSync(url)).toBe(true);
  });

  it('cuts the helper tag, not the CLI tag (PHNX-3228)', () => {
    // The regression that made this script useless: publishing to `v<version>`
    // put the asset where download.ts never looks.
    const src = fs.readFileSync(SH, 'utf-8');
    expect(src).toMatch(/TAG="computer-mac\/v\$VERSION"/);
    expect(src).not.toMatch(/^TAG="v\$VERSION"$/m);
  });

  it('requires an explicit version rather than defaulting to the CLI version', () => {
    // Defaulting to cli/package.json is what coupled the helper to the CLI's
    // version line in the first place.
    const r = run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/usage:/);
    expect(fs.readFileSync(SH, 'utf-8')).not.toMatch(/jq -r \.version/);
  });

  it('refuses a v-prefixed version rather than cutting computer-mac/vv1.0.1', () => {
    const r = run('v1.0.1');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/bare X\.Y\.Z/);
  });

  it('refuses a non-semver version', () => {
    expect(run('1.0').status).not.toBe(0);
    expect(run('latest').status).not.toBe(0);
  });

  it('refuses an existing tag — a helper release is immutable', () => {
    // The upload uses --clobber, so re-tagging would silently replace a binary
    // an installed CLI already pins to that exact version.
    const version = '0.0.1';
    const tag = `computer-mac/v${version}`;

    // Prove the guard fires, not the version validator: the same version gets
    // past validation while the tag is absent (it then fails later, on the
    // missing notary creds — which is downstream of the guard under test).
    const before = run(version);
    expect(before.stderr).not.toMatch(/already exists/);
    // ...and it stops at the creds check, which is what keeps this file from
    // ever reaching the build/notarize/publish path below it.
    expect(before.stderr).toMatch(/notary creds missing/);

    git(repo, 'tag', tag);
    const after = run(version);
    expect(after.status).not.toBe(0);
    expect(after.stderr).toMatch(/already exists/);
  });

  it('is the symmetric counterpart of the Windows helper publisher', () => {
    // One script per helper, each cutting that helper's own tag. If this file
    // exists but its Windows sibling does not, the pair has drifted.
    expect(fs.existsSync(path.join(path.dirname(SH), 'publish-computer-win.sh'))).toBe(true);
  });
});
