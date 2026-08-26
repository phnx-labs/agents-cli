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

/**
 * Install a `gh` stub on the sealed PATH. `releaseExists` drives the ONE thing
 * the immutability guard asks gh: whether the release is already published.
 *
 * gh is stubbed rather than reached because the guard queries the real
 * `phnx-labs/agents-cli` by hardcoded slug — the throwaway origin cannot answer
 * for it, and a test must never depend on (or mutate) the real repo's releases.
 * Every invocation is recorded so a test can assert what the script asked for.
 */
function stubGh(releaseExists: boolean, logPath: string): void {
  fs.writeFileSync(
    path.join(binDir, 'gh'),
    `#!/bin/sh\necho "$@" >> ${JSON.stringify(logPath)}\n` +
      `case "$1 $2" in "release view") exit ${releaseExists ? 0 : 1} ;; esac\nexit 0\n`,
  );
  fs.chmodSync(path.join(binDir, 'gh'), 0o755);
}

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

  it('resumes when the tag is local-only — a failed push must not burn a version', () => {
    // Regression in this PR's own first revision: adding `git tag` made a
    // tag-then-push-failure leave a local ref, and the guard treated that as
    // "published" and told the operator to cut the next patch. Nothing had been
    // published, and because the guard runs before the build, that version
    // became permanently uncuttable from the checkout without `git tag -d`.
    // Origin is the source of truth; a local-only tag means resume.
    const version = '0.0.9';
    const tag = `computer-mac/v${version}`;
    git(repo, 'tag', tag); // local only — never pushed to the bare origin
    stubGh(false, path.join(tmp, `gh-${version}.log`));

    const r = run(version);
    expect(r.stderr).not.toMatch(/already published/);
    expect(`${r.stdout}${r.stderr}`).toMatch(/resuming an interrupted publish/);
    // Still stops before the publish path, as every case in this file must.
    expect(r.stderr).toMatch(/notary creds missing/);
  });

  it('refuses an existing tag — a helper release is immutable', () => {
    // The upload uses --clobber, so re-tagging would silently replace a binary
    // an installed CLI already pins to that exact version.
    const version = '0.0.1';
    const tag = `computer-mac/v${version}`;

    // Prove the guard fires, not the version validator: the same version gets
    // past validation while the tag is absent (it then fails later, on the
    // missing notary creds — which is downstream of the guard under test).
    stubGh(false, path.join(tmp, `gh-${version}-before.log`));
    const before = run(version);
    expect(before.stderr).not.toMatch(/already published/);
    // ...and it stops at the creds check, which is what keeps this file from
    // ever reaching the build/notarize/publish path below it.
    expect(before.stderr).toMatch(/notary creds missing/);

    // A PUBLISHED RELEASE is what makes the version un-recuttable — not the tag.
    // A tag with no release is an interrupted run and resumes (cases above).
    git(repo, 'tag', tag);
    git(repo, 'push', '-q', 'origin', tag);
    stubGh(true, path.join(tmp, `gh-${version}.log`));
    const after = run(version);
    expect(after.status).not.toBe(0);
    expect(after.stderr).toMatch(/already published/);
  });

  /**
   * Run the script all the way THROUGH a successful publish, with every external
   * effect replaced by a local stand-in: `gh` is a stub that records its argv,
   * the helper build is a stub that emits the two expected artifacts, the signing
   * context is a no-op, and `origin` is a bare repo on disk. Nothing is signed,
   * notarized, uploaded, or pushed anywhere real.
   *
   * This exists because a source-regex assertion cannot catch a tag pointing at
   * the wrong commit, which is exactly the defect that would silently ship the
   * wrong helper.
   */
  function runFullPublish(version: string) {
    const ghLog = path.join(tmp, `gh-${version}.log`);
    stubGh(false, ghLog); // no existing release -> take the create path

    const helperScripts = path.join(repo, 'native', 'computer-mac', 'scripts');
    fs.mkdirSync(helperScripts, { recursive: true });
    fs.writeFileSync(
      path.join(helperScripts, 'build.sh'),
      '#!/bin/sh\nset -e\nmkdir -p "$(dirname "$0")/../dist"\n' +
        'printf fake > "$(dirname "$0")/../dist/ComputerHelper.app.zip"\n' +
        'printf fakesha > "$(dirname "$0")/../dist/ComputerHelper.app.zip.sha256"\n',
    );
    fs.chmodSync(path.join(helperScripts, 'build.sh'), 0o755);
    // Real one would unlock this machine's signing keychain; the publish logic
    // under test does not need it.
    fs.writeFileSync(path.join(repo, 'cli', 'scripts', 'headless-sign-context.sh'), ': # no-op\n');

    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
    env.APPLE_ID = 'stub@example.invalid';
    env.APPLE_APP_SPECIFIC_PASSWORD = 'stub';
    env.APPLE_TEAM_ID = 'STUBTEAM99';
    const r = spawnSync(
      'bash',
      [path.join(repo, 'cli', 'scripts', path.basename(SH)), version],
      { encoding: 'utf-8', env },
    );
    return { r, ghArgs: fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf-8') : '' };
  }

  it('pushes the tag at the built commit, then creates the release', () => {
    const version = '0.1.0';
    const tag = `computer-mac/v${version}`;
    const { r, ghArgs } = runFullPublish(version);
    expect(r.status, r.stderr).toBe(0);

    // The tag reached origin — which is what `gh release create --verify-tag`
    // requires and what a regex assertion cannot demonstrate.
    const onOrigin = git(repo, 'ls-remote', '--tags', 'origin', tag);
    expect(onOrigin).toContain(tag);

    // ...and points at the exact commit whose tree produced the asset. A tag on
    // the wrong commit ships a helper built from something else entirely.
    const head = git(repo, 'rev-parse', 'HEAD');
    expect(git(repo, 'rev-list', '-n', '1', tag)).toBe(head);

    // The release was created for that tag and the assets attached.
    expect(ghArgs).toMatch(new RegExp(`release create ${tag.replace('/', '\\/')}`));
    expect(ghArgs).toMatch(/release upload/);
    expect(ghArgs).toMatch(/ComputerHelper\.app\.zip/);
  });

  it('resumes when the tag is already on origin but no release exists', () => {
    // The second wedge: tag pushed, then release creation failed. Nothing was
    // published, so the version must stay cuttable.
    const version = '0.2.0';
    const tag = `computer-mac/v${version}`;
    git(repo, 'tag', tag);
    git(repo, 'push', '-q', 'origin', tag);

    const { r } = runFullPublish(version);
    expect(r.stderr).not.toMatch(/already published/);
    expect(`${r.stdout}${r.stderr}`).toMatch(/resuming an interrupted publish/);
    expect(r.status, r.stderr).toBe(0);
  });

  it('creates and pushes the tag itself — gh release create --verify-tag will not', () => {
    // The gap this pins: `gh release create --verify-tag` refuses to invent a
    // tag that is absent on the remote, and nothing else pushes
    // `computer-mac/v<x.y.z>` — release.sh delegates helper tagging to "where
    // the helper is released", which is this script. Without its own `git tag` +
    // `git push` the script ran green through build + notarize and then died at
    // the release step, so no new helper version could be cut at all.
    //
    // Asserted against the source because the success path cannot be executed
    // here: reaching it means really building, notarizing, and publishing.
    const src = fs.readFileSync(SH, 'utf-8');
    const tagLine = src.search(/git -C "\$REPO_ROOT" tag -a "\$TAG"/);
    const pushLine = src.search(/git -C "\$REPO_ROOT" push origin "\$TAG"/);
    const buildLine = src.search(/bash scripts\/build\.sh release/);
    const releaseLine = src.search(/gh release create "\$TAG"/);

    expect(tagLine, 'script must create the tag').toBeGreaterThan(-1);
    expect(pushLine, 'script must push the tag').toBeGreaterThan(-1);
    // Order matters twice over: the tag must exist before gh is asked to verify
    // it, and must NOT be pushed before the build, or a failed notarization
    // leaves a published address with nothing behind it — unreusable, since
    // helper tags are immutable.
    expect(buildLine).toBeLessThan(tagLine);
    expect(pushLine).toBeLessThan(releaseLine);
  });

  it('is the symmetric counterpart of the Windows helper publisher', () => {
    // One script per helper, each cutting that helper's own tag. If this file
    // exists but its Windows sibling does not, the pair has drifted.
    expect(fs.existsSync(path.join(path.dirname(SH), 'publish-computer-win.sh'))).toBe(true);
  });
});
