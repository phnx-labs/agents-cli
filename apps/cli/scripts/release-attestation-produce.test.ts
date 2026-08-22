/**
 * release-attestation-produce.sh, exercised against a REAL git repo (no
 * mocks) with fake `bun`/`npm` binaries standing in for the real toolchain --
 * this test is about the script's orchestration (worktree isolation, fail-
 * closed on a red suite, attestation write + tarball placement), not about
 * re-running the real suite or a real `npm pack` inside a test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PRODUCE_SCRIPT = path.resolve(__dirname, 'release-attestation-produce.sh');
const ATTEST_SCRIPT = path.resolve(__dirname, 'release-attestation.sh');
const MANIFEST_SCRIPT = path.resolve(__dirname, 'release-manifest.sh');
const roots: string[] = [];

function tmp(prefix: string): string {
  // realpath: on macOS os.tmpdir() resolves under /var, which is itself a
  // symlink to /private/var. `git worktree list` and other subprocesses
  // report the resolved path, so an un-normalized root here diverges from
  // what those commands print back (RUSH-2750).
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// Builds a caller repo (a bare remote + a clone) shaped enough like the real
// monorepo for release-attestation.sh's identity() to resolve: apps/cli/{
// package.json, bun.lock, vitest.config.ts, ci/test-ownership.yaml } plus a
// root-level scripts/ci-scope.ts. A fake bun/npm on PATH stand in for the
// real toolchain; `failSuite` makes the fake `bun run test` exit non-zero.
function fakeSuiteBody(opts: { failSuite?: boolean; suite?: 'greenWorkerCrash' | 'redWorkerCrash' }): string {
  // Summary lines mirror real vitest output so the producer's
  // suite_green_despite_worker_crash parser is exercised against the shape it
  // sees in production (RUSH-2758).
  if (opts.suite === 'greenWorkerCrash')
    return [
      '  echo " Test Files  861 passed | 8 skipped (870)"',
      '  echo "      Tests  12200 passed | 105 skipped (12325)"',
      '  echo "Error: Worker exited unexpectedly"',
      '  exit 1',
    ].join('\n');
  if (opts.suite === 'redWorkerCrash')
    return [
      '  echo " Test Files  2 failed | 859 passed (870)"',
      '  echo "      Tests  3 failed | 12197 passed (12325)"',
      '  echo "Error: Worker exited unexpectedly"',
      '  exit 1',
    ].join('\n');
  if (opts.failSuite) return '  echo "1 test failed" >&2; exit 1';
  return '  echo "tests passed"; exit 0';
}

function buildFixture(root: string, opts: { failSuite?: boolean; suite?: 'greenWorkerCrash' | 'redWorkerCrash' } = {}): { caller: string; fakebin: string; store: string; headCommit: string } {
  const remote = path.join(root, 'remote.git');
  const caller = path.join(root, 'caller');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'clone', '-q', remote, caller);
  git(caller, 'config', 'user.email', 'attest-test@example.com');
  git(caller, 'config', 'user.name', 'attest-test');

  fs.mkdirSync(path.join(caller, 'apps/cli/scripts'), { recursive: true });
  fs.mkdirSync(path.join(caller, 'apps/cli/ci'), { recursive: true });
  fs.mkdirSync(path.join(caller, 'scripts'), { recursive: true });
  fs.copyFileSync(PRODUCE_SCRIPT, path.join(caller, 'apps/cli/scripts/release-attestation-produce.sh'));
  fs.copyFileSync(ATTEST_SCRIPT, path.join(caller, 'apps/cli/scripts/release-attestation.sh'));
  fs.chmodSync(path.join(caller, 'apps/cli/scripts/release-attestation-produce.sh'), 0o755);
  fs.chmodSync(path.join(caller, 'apps/cli/scripts/release-attestation.sh'), 0o755);
  fs.writeFileSync(path.join(caller, 'apps/cli/package.json'), '{"name":"@phnx-labs/agents-cli","version":"9.9.9"}\n');
  fs.writeFileSync(path.join(caller, 'apps/cli/bun.lock'), 'lock-v1\n');
  fs.writeFileSync(path.join(caller, 'apps/cli/vitest.config.ts'), 'export default {}\n');
  fs.writeFileSync(path.join(caller, 'apps/cli/ci/test-ownership.yaml'), 'ownership: {}\n');
  fs.writeFileSync(path.join(caller, 'scripts/ci-scope.ts'), '// scope\n');
  git(caller, 'add', '-A');
  git(caller, 'commit', '-q', '-m', 'init');
  git(caller, 'push', '-q', '-u', 'origin', 'main');
  const headCommit = git(caller, 'rev-parse', 'HEAD');

  const fakebin = path.join(root, 'fakebin');
  fs.mkdirSync(fakebin, { recursive: true });
  fs.writeFileSync(
    path.join(fakebin, 'bun'),
    [
      '#!/usr/bin/env bash',
      'if [[ "$1" == "--version" ]]; then echo "1.2.3"; exit 0; fi',
      'if [[ "$1" == "install" ]]; then exit 0; fi',
      'if [[ "$1" == "run" && "$2" == "test" ]]; then',
      // RUSH-3007: the producer must run the suite with AGENTS_ATTEST_PRODUCER=1
      // and CI unset, never CI=true -- see the "sets AGENTS_ATTEST_PRODUCER..."
      // test below, which asserts on this exact line.
      '  echo "RUSH-3007-ENV: producer=${AGENTS_ATTEST_PRODUCER:-<unset>} ci=${CI:-<unset>}"',
      fakeSuiteBody(opts),
      'fi',
      'if [[ "$1" == "run" && "$2" == "build" ]]; then mkdir -p dist; exit 0; fi',
      'echo "fake bun: unhandled args: $*" >&2; exit 1',
      '',
    ].join('\n'),
  );
  fs.chmodSync(path.join(fakebin, 'bun'), 0o755);
  fs.writeFileSync(
    path.join(fakebin, 'npm'),
    [
      '#!/usr/bin/env bash',
      'if [[ "$1" == "pack" ]]; then',
      '  name="phnx-labs-agents-cli-9.9.9.tgz"',
      '  echo "fake-tarball-bytes-$$" > "$name"',
      '  echo "$name"',
      '  exit 0',
      'fi',
      'echo "fake npm: unhandled args: $*" >&2; exit 1',
      '',
    ].join('\n'),
  );
  fs.chmodSync(path.join(fakebin, 'npm'), 0o755);

  return { caller, fakebin, store: path.join(root, 'store'), headCommit };
}

function runProduce(
  fx: ReturnType<typeof buildFixture>,
  extraArgs: string[] = [],
  envOverride: NodeJS.ProcessEnv = {},
) {
  return spawnSync(
    'bash',
    [
      path.join(fx.caller, 'apps/cli/scripts/release-attestation-produce.sh'),
      fx.headCommit,
      '--repo-root',
      fx.caller,
      '--dir',
      fx.store,
      ...extraArgs,
    ],
    {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${fx.fakebin}:${process.env.PATH}`, ...envOverride },
    },
  );
}



describe('release-attestation-produce.sh', () => {
  it('seeds the already-signed helper apps from the caller checkout on a non-Mac producer (RUSH-3026)', () => {
    // The producer's fresh worktree has an empty bin/ (the .apps are untracked),
    // so before this fix every non-Mac producer died at prepack — chaining
    // attestation production, and therefore releases, to a Mac. The caller
    // checkout's already-signed apps must be seeded copy-if-absent; the prepack
    // gates still verify them.
    const root = tmp('attest-produce-seed-');
    const fx = buildFixture(root);
    // Untracked, already-signed apps exist only in the CALLER checkout.
    for (const [app, binName] of [
      ['Agents CLI.app', 'Agents CLI'],
      ['MenubarHelper.app', 'MenubarHelper'],
    ] as const) {
      const dir = path.join(fx.caller, 'apps/cli/bin', app, 'Contents/MacOS');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, binName), 'signed-bytes\n');
    }
    const result = runProduce(fx, ['--keep']);
    // Strip ANSI color codes so the path capture below is not polluted by the
    // gray() escape sequences the producer wraps its lines in.
    const out = (result.stdout + result.stderr).replace(/\[[0-9;]*m/g, '');
    expect(result.status, out).toBe(0);
    expect(out).toContain('seeded bin/Agents CLI.app');
    expect(out).toContain('seeded bin/MenubarHelper.app');
    // The kept worktree genuinely carries the seeded apps where prepack looks.
    const kept = out.match(/kept worktree for inspection: (\S+)/);
    expect(kept, out).toBeTruthy();
    expect(fs.existsSync(path.join(kept![1], 'apps/cli/bin/Agents CLI.app/Contents/MacOS/Agents CLI'))).toBe(true);
    expect(fs.existsSync(path.join(kept![1], 'apps/cli/bin/MenubarHelper.app/Contents/MacOS/MenubarHelper'))).toBe(true);
  });

  it('does not seed when the caller checkout has no apps (nothing to reuse; gates decide)', () => {
    const root = tmp('attest-produce-noseed-');
    const fx = buildFixture(root);
    const result = runProduce(fx);
    const out = result.stdout + result.stderr;
    expect(result.status, out).toBe(0); // fake npm pack has no prepack gates
    expect(out).not.toContain('seeded bin/');
  });

  it('runs the suite with AGENTS_ATTEST_PRODUCER=1 and CI unset, even when the caller shell exports CI=true (RUSH-3007)', () => {
    // Cutting 1.22.44, the operator exported CI=true by hand to get vitest's
    // extended hookTimeout profile, which also armed tests/setup.ts's
    // real-~/.agents leak tripwires against a box with a live daemon +
    // active sessions -- 129/129 test files false-failed on a fully green
    // suite. The producer must set its own AGENTS_ATTEST_PRODUCER flag and
    // unset any ambient CI so this exact operator mistake cannot recur.
    const root = tmp('attest-produce-envflag-');
    const fx = buildFixture(root);
    const result = spawnSync(
      'bash',
      [
        path.join(fx.caller, 'apps/cli/scripts/release-attestation-produce.sh'),
        fx.headCommit,
        '--repo-root',
        fx.caller,
        '--dir',
        fx.store,
      ],
      { encoding: 'utf-8', env: { ...process.env, PATH: `${fx.fakebin}:${process.env.PATH}`, CI: 'true' } },
    );
    const out = result.stdout + result.stderr;
    expect(result.status, out).toBe(0);
    expect(out).toContain('RUSH-3007-ENV: producer=1 ci=<unset>');
  });

  it('runs the suite, packs the tarball, and writes a passing attestation for the exact tree', () => {
    const root = tmp('attest-produce-');
    const fx = buildFixture(root);
    const result = runProduce(fx);
    expect(result.status, result.stdout + result.stderr).toBe(0);

    const files = fs.readdirSync(fx.store);
    const jsonFile = files.find((f) => f.endsWith('.json'));
    expect(jsonFile).toBeTruthy();
    const record = JSON.parse(fs.readFileSync(path.join(fx.store, jsonFile!), 'utf-8'));

    expect(record.schemaVersion).toBe(1);
    expect(record.conclusion).toBe('pass');
    // release.sh's own `require` calls never pass --suite, so
    // bind_tree_lock_policy defaults to "selected" -- a record tagged
    // anything else is invisible to the consumer regardless of matching
    // tree/lock/policy. Assert the actual consumer contract below, not just
    // this literal, so a producer/consumer drift here fails the suite.
    expect(record.suite).toBe('selected');
    expect(record.candidateTree).toBe(git(fx.caller, 'rev-parse', 'HEAD^{tree}'));
    expect(record.lockfileDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(record.policyVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(record.tarball.filename).toBe('phnx-labs-agents-cli-9.9.9.tgz');
    expect(record.tarball.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    // The tarball itself must be sitting next to the attestation JSON so
    // release-attestation.sh tarball/promote can resolve it by directory.
    const tgzPath = path.join(fx.store, record.tarball.filename);
    expect(fs.existsSync(tgzPath)).toBe(true);
    const actualDigest = spawnSync('sha256sum', [tgzPath], { encoding: 'utf-8' }).stdout.trim().split(/\s+/)[0];
    expect(record.tarball.digest).toBe(`sha256:${actualDigest}`);

    // The isolated worktree used to run the suite must not survive the run --
    // only the caller checkout itself is left registered. `git worktree list`
    // column-aligns its whitespace by path length, so match on content, not
    // an exact padded string (that padding differs by tmpdir path length,
    // which differs on CI vs locally).
    const worktrees = git(fx.caller, 'worktree', 'list')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]).toMatch(new RegExp(`^${fx.caller.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+${fx.headCommit.slice(0, 7)}`));

    // The actual consumer: release.sh's require call (no --suite, no
    // --bun/--node/--platform) must find and accept what the producer wrote.
    const required = spawnSync(
      'bash',
      [ATTEST_SCRIPT, 'require', '--dir', fx.store, '--tree', record.candidateTree, '--repo-root', fx.caller],
      { encoding: 'utf-8' },
    );
    expect(required.status, required.stdout + required.stderr).toBe(0);
  });

  it('survives a relative --dir: the attestation lands outside the throwaway worktree, not inside it', () => {
    const root = tmp('attest-produce-relative-dir-');
    const fx = buildFixture(root);
    const relativeStore = '.release-attestations';
    const result = spawnSync(
      'bash',
      [
        path.join(fx.caller, 'apps/cli/scripts/release-attestation-produce.sh'),
        fx.headCommit,
        '--repo-root',
        fx.caller,
        '--dir',
        relativeStore,
      ],
      { encoding: 'utf-8', env: { ...process.env, PATH: `${fx.fakebin}:${process.env.PATH}` } },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);

    // The script cd's to its own apps/cli directory before resolving --dir
    // (matching how release.sh's own docs invoke release-attestation.sh with
    // a relative path from apps/cli), so a relative --dir resolves there --
    // NOT wherever the caller happened to be, and NOT inside the throwaway
    // worktree the script deletes on exit.
    const resolvedStore = path.join(fx.caller, 'apps/cli', relativeStore);
    expect(fs.existsSync(resolvedStore)).toBe(true);
    const jsonFile = fs.readdirSync(resolvedStore).find((f) => f.endsWith('.json'));
    expect(jsonFile).toBeTruthy();
    const tgzFile = fs.readdirSync(resolvedStore).find((f) => f.endsWith('.tgz'));
    expect(tgzFile).toBeTruthy();
  });

  it('never writes an attestation for a red suite (fail closed)', () => {
    const root = tmp('attest-produce-red-');
    const fx = buildFixture(root, { failSuite: true });
    const result = runProduce(fx);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('refusing to attest a red tree');
    expect(fs.existsSync(fx.store) ? fs.readdirSync(fx.store).filter((f) => f.endsWith('.json')) : []).toEqual([]);
  });

  it('attests a green suite whose only failure is a teardown worker-exit (RUSH-2758)', () => {
    const root = tmp('attest-produce-worker-crash-green-');
    const fx = buildFixture(root, { suite: 'greenWorkerCrash' });
    const result = runProduce(fx);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toContain('treating as pass');
    const jsonFile = fs.readdirSync(fx.store).find((f) => f.endsWith('.json'));
    expect(jsonFile).toBeTruthy();
    expect(JSON.parse(fs.readFileSync(path.join(fx.store, jsonFile!), 'utf-8')).conclusion).toBe('pass');
  });

  it('stays fail-closed when a worker crash accompanies real test failures', () => {
    const root = tmp('attest-produce-worker-crash-red-');
    const fx = buildFixture(root, { suite: 'redWorkerCrash' });
    const result = runProduce(fx);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('refusing to attest a red tree');
    expect(fs.existsSync(fx.store) ? fs.readdirSync(fx.store).filter((f) => f.endsWith('.json')) : []).toEqual([]);
  });

  it('requires a commit-ish argument', () => {
    const root = tmp('attest-produce-usage-');
    const fx = buildFixture(root);
    const result = spawnSync('bash', [path.join(fx.caller, 'apps/cli/scripts/release-attestation-produce.sh')], {
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/usage:/);
  });
});

// Extends the base fixture with a real (copied, not faked) release-manifest.sh
// plus minimal source trees for all three known helpers -- computer-mac at repo
// root, keychain + menubar under apps/cli -- so the producer's helper-manifest
// step (RUSH-2766) has real inputs to hash. keychain/menubar's "signed" assets
// are plain placeholder files standing in for what the Darwin-only sign block
// would have built; the manifest step only checks the files exist and hashes
// them, so this is enough to exercise it on Linux CI without a real signing box.
/**
 * A prior release's `release-manifest.json`, built with the shipped generator
 * so the seed fixture matches what a real GitHub release carries.
 */
function priorReleaseManifest(root: string, computerMacDigest: string): string {
  const file = path.join(root, 'prior-release-manifest.json');
  const created = spawnSync(
    'bash',
    [MANIFEST_SCRIPT, 'new', '--cli-version', 'prev-1.0.0', '--cli-tree', 'deadbeef'],
    { encoding: 'utf-8' },
  );
  if (created.status !== 0) throw new Error(created.stderr || created.stdout);
  fs.writeFileSync(file, created.stdout);
  // `put` verifies the asset exists on disk, so give it a real one in a temp
  // dist/ and run from there — the same shape a signing box would have.
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  const asset = path.join(root, 'dist/ComputerHelper.app.zip');
  fs.writeFileSync(asset, 'prior release helper asset\n');
  // put refuses a declared digest that does not match the real bytes, so
  // compute it rather than asserting a placeholder.
  const assetDigest =
    'sha256:' + createHash('sha256').update(fs.readFileSync(asset)).digest('hex');
  const put = spawnSync(
    'bash',
    [
      MANIFEST_SCRIPT, 'put', '--file', file,
      '--helper', 'computer-mac',
      '--helper-version', 'prev-1.0.0',
      '--input-digest', computerMacDigest,
      '--asset-digest', assetDigest,
      '--asset-path', 'dist/ComputerHelper.app.zip',
      '--platform', 'darwin',
    ],
    { encoding: 'utf-8', cwd: root },
  );
  if (put.status !== 0) throw new Error(put.stderr || put.stdout);
  return fs.readFileSync(file, 'utf-8').trim();
}

function buildManifestFixture(root: string): ReturnType<typeof buildFixture> & {
  manifestDigests: Record<'computer-mac' | 'keychain' | 'menubar', string>;
} {
  const fx = buildFixture(root);
  const { caller } = fx;

  fs.mkdirSync(path.join(caller, 'native/computer-mac/Sources'), { recursive: true });
  fs.mkdirSync(path.join(caller, 'native/computer-mac/scripts'), { recursive: true });
  fs.writeFileSync(path.join(caller, 'native/computer-mac/Sources/dummy.swift'), '// dummy\n');
  fs.writeFileSync(path.join(caller, 'native/computer-mac/scripts/build.sh'), '#!/usr/bin/env bash\n');
  fs.writeFileSync(path.join(caller, 'native/computer-mac/Package.swift'), '// swift package\n');

  fs.writeFileSync(path.join(caller, 'apps/cli/scripts/build-keychain-helper.sh'), '#!/usr/bin/env bash\n');
  fs.writeFileSync(path.join(caller, 'apps/cli/scripts/keychain-entitlements.plist'), '<plist/>\n');
  fs.writeFileSync(path.join(caller, 'apps/cli/scripts/verify-keychain-helper.sh'), '#!/usr/bin/env bash\n');
  fs.copyFileSync(MANIFEST_SCRIPT, path.join(caller, 'apps/cli/scripts/release-manifest.sh'));
  fs.chmodSync(path.join(caller, 'apps/cli/scripts/release-manifest.sh'), 0o755);

  fs.mkdirSync(path.join(caller, 'apps/cli/menubar/Sources'), { recursive: true });
  fs.mkdirSync(path.join(caller, 'apps/cli/menubar/scripts'), { recursive: true });
  fs.writeFileSync(path.join(caller, 'apps/cli/menubar/Sources/dummy.swift'), '// dummy\n');
  fs.writeFileSync(path.join(caller, 'apps/cli/menubar/scripts/build.sh'), '#!/usr/bin/env bash\n');
  fs.writeFileSync(path.join(caller, 'apps/cli/menubar/Package.swift'), '// swift package\n');

  fs.mkdirSync(path.join(caller, 'apps/cli/bin/Agents CLI.app/Contents/MacOS'), { recursive: true });
  fs.writeFileSync(path.join(caller, "apps/cli/bin/Agents CLI.app/Contents/MacOS/Agents CLI"), 'fake-keychain-binary\n');
  fs.mkdirSync(path.join(caller, 'apps/cli/bin/MenubarHelper.app/Contents/MacOS'), { recursive: true });
  fs.writeFileSync(path.join(caller, 'apps/cli/bin/MenubarHelper.app/Contents/MacOS/MenubarHelper'), 'fake-menubar-binary\n');

  git(caller, 'add', '-A');
  git(caller, 'commit', '-q', '-m', 'add helper manifest fixture');
  git(caller, 'push', '-q', '-u', 'origin', 'main');
  const headCommit = git(caller, 'rev-parse', 'HEAD');

  const digestFor = (helper: string) => {
    const r = spawnSync('bash', [MANIFEST_SCRIPT, 'input-digest', '--repo-root', caller, '--helper', helper], {
      encoding: 'utf-8',
    });
    if (r.status !== 0) throw new Error(`input-digest ${helper} failed: ${r.stdout}${r.stderr}`);
    return r.stdout.trim();
  };

  return {
    ...fx,
    headCommit,
    manifestDigests: {
      'computer-mac': digestFor('computer-mac'),
      keychain: digestFor('keychain'),
      menubar: digestFor('menubar'),
    },
  };
}

function seedManifest(store: string, helpers: Record<string, { inputDigest: string }>) {
  fs.mkdirSync(store, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    cliVersion: '9.9.8',
    cliTree: 'seed-tree',
    helpers: Object.fromEntries(
      Object.entries(helpers).map(([name, { inputDigest }]) => [
        name,
        {
          helperVersion: 'prev-1.0.0',
          inputDigest,
          assetDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
          assetUrl: '',
          assetPath: '',
          signerTeam: '2HTP252L87',
          architecture: 'universal',
          platform: 'darwin',
        },
      ]),
    ),
  };
  fs.writeFileSync(path.join(store, 'release-manifest.json'), JSON.stringify(manifest));
}

describe('release-attestation-produce.sh -- helper manifest (RUSH-2766)', () => {
  it('carries forward an unchanged helper and records fresh digests for changed ones', () => {
    const root = tmp('attest-produce-manifest-');
    const fx = buildManifestFixture(root);
    // Pre-seed only computer-mac, matching its current digest -- it must be
    // carried forward untouched (this producer never rebuilds it). keychain
    // and menubar have no prior record, so they must be freshly recorded from
    // the "signed" assets committed into the fixture.
    seedManifest(fx.store, { 'computer-mac': { inputDigest: fx.manifestDigests['computer-mac'] } });

    const result = runProduce(fx);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toContain('helper computer-mac unchanged');

    const manifestFile = path.join(fx.store, 'release-manifest.json');
    expect(fs.existsSync(manifestFile)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));

    // computer-mac: untouched, still the seeded placeholder record.
    expect(manifest.helpers['computer-mac'].helperVersion).toBe('prev-1.0.0');
    expect(manifest.helpers['computer-mac'].inputDigest).toBe(fx.manifestDigests['computer-mac']);

    // keychain / menubar: freshly recorded against the committed placeholder
    // "signed" binaries, keyed by the SAME digest a second, independent
    // checkout computes (proving the RUSH-2766 relative-path fix: the
    // producer hashed inside a throwaway $WT, the test hashed the caller
    // clone -- different absolute paths, same relative tree).
    for (const helper of ['keychain', 'menubar'] as const) {
      expect(manifest.helpers[helper].inputDigest).toBe(fx.manifestDigests[helper]);
      expect(manifest.helpers[helper].assetDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(manifest.helpers[helper].helperVersion).toBe('9.9.9');
    }

    // The actual consumer: release-manifest.sh require must accept what the
    // producer wrote, against the SAME caller checkout used to compute the
    // expected digests above.
    const required = spawnSync(
      'bash',
      [MANIFEST_SCRIPT, 'require', '--file', manifestFile, '--repo-root', fx.caller],
      { encoding: 'utf-8' },
    );
    expect(required.status, required.stdout + required.stderr).toBe(0);
  });

  /**
   * RUSH-2970 trap 1. A fresh attestation store has no recorded computer-mac
   * inputDigest, so the helper loop below reads "input changed" and dies
   * telling the operator to run publish-computer-helper-mac.sh — which does
   * not write a manifest, so re-running the producer hits the identical error.
   * Every hand-cut release walked into that loop. The producer now seeds the
   * manifest from the last published release first.
   *
   * `gh` is stubbed on the fixture's fake-bin PATH so this exercises the real
   * seed branch without a network call or a GitHub account.
   */
  it('seeds the manifest from the last release instead of dead-ending on a fresh store', () => {
    const root = tmp('attest-produce-manifest-seed-');
    const fx = buildManifestFixture(root);
    // Built with the real generator, so the fixture is a manifest the shipped
    // tooling actually produces rather than a hand-rolled shape.
    const priorManifest = priorReleaseManifest(root, fx.manifestDigests['computer-mac']);
    // A `gh` that answers exactly the two calls the seed makes.
    fs.writeFileSync(
      path.join(fx.fakebin, 'gh'),
      '#!/usr/bin/env bash\n' +
        'if [[ "$1" == release && "$2" == list ]]; then echo v9.9.8; exit 0; fi\n' +
        'if [[ "$1" == release && "$2" == download ]]; then\n' +
        '  dir=""; for ((i=1;i<=$#;i++)); do [[ "${!i}" == --dir ]] && { j=$((i+1)); dir="${!j}"; }; done\n' +
        `  cat > "$dir/release-manifest.json" <<'MANIFEST'\n${priorManifest}\nMANIFEST\n` +
        '  exit 0\n' +
        'fi\n' +
        'exit 1\n',
    );
    fs.chmodSync(path.join(fx.fakebin, 'gh'), 0o755);

    const result = runProduce(fx);

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toContain('Seeded the helper manifest from v9.9.8');
    // The dead-end this fix exists to remove must NOT have fired.
    expect(result.stdout + result.stderr).not.toContain('helper computer-mac input changed');

    const manifest = JSON.parse(fs.readFileSync(path.join(fx.store, 'release-manifest.json'), 'utf-8'));
    // The seeded computer-mac record carried forward, so the unchanged helper
    // needed no rebuild — the whole point.
    expect(manifest.helpers['computer-mac'].inputDigest).toBe(fx.manifestDigests['computer-mac']);
    // …and the seed did not disable the check: the other helpers were still
    // recorded fresh against this tree.
    for (const helper of ['keychain', 'menubar'] as const) {
      expect(manifest.helpers[helper].inputDigest).toBe(fx.manifestDigests[helper]);
    }
  });

  /**
   * The seed is a convenience, never a way to smuggle a changed helper through:
   * if the prior release's computer-mac digest does not match this tree, the
   * producer must still fail closed.
   */
  /**
   * The seed's diagnostic must name the REAL cause. A single `&&` chain made a
   * gh that fails on auth read as "no prior release" — hiding the very
   * misconfiguration worth surfacing — and an empty release list print the
   * literal string `null`, because `jq -r '.[0].tagName'` emits "null" for an
   * empty array. Each branch is asserted against the condition that triggers it.
   */
  it.each([
    {
      cause: 'gh cannot list (auth/network)',
      gh: '#!/usr/bin/env bash\nexit 1\n',
      expected: 'gh could not list releases',
      notExpected: 'no published release',
    },
    {
      cause: 'repo has zero releases',
      gh: '#!/usr/bin/env bash\n[[ "$1" == release && "$2" == list ]] && { echo null; exit 0; }\nexit 1\n',
      expected: 'no published release to seed from',
      notExpected: 'null carries no',
    },
    {
      cause: 'release carries no manifest asset',
      gh: '#!/usr/bin/env bash\n[[ "$1" == release && "$2" == list ]] && { echo v9.9.8; exit 0; }\n[[ "$1" == release && "$2" == download ]] && exit 0\nexit 1\n',
      expected: 'v9.9.8 carries no release-manifest.json',
      notExpected: 'no published release',
    },
  ])('names the real reason a seed did not happen: $cause', ({ gh, expected, notExpected }) => {
    const root = tmp('attest-produce-seed-why-');
    const fx = buildManifestFixture(root);
    const ghPath = path.join(fx.fakebin, 'gh');
    fs.writeFileSync(ghPath, gh);
    fs.chmodSync(ghPath, 0o755);

    const output = (() => {
      const r = runProduce(fx);
      return r.stdout + r.stderr;
    })();

    expect(output).toContain(expected);
    expect(output).not.toContain(notExpected);
    // Whatever the cause, it still falls back rather than dying here — the
    // computer-mac gate below is what fails closed.
    expect(output).toContain('Starting a fresh helper manifest');
  });

  it('still fails closed when the seeded computer-mac record does not match this tree', () => {
    const root = tmp('attest-produce-manifest-seed-drift-');
    const fx = buildManifestFixture(root);
    const staleManifest = priorReleaseManifest(root, 'sha256:' + 'b'.repeat(64));
    fs.writeFileSync(
      path.join(fx.fakebin, 'gh'),
      '#!/usr/bin/env bash\n' +
        'if [[ "$1" == release && "$2" == list ]]; then echo v9.9.8; exit 0; fi\n' +
        'if [[ "$1" == release && "$2" == download ]]; then\n' +
        '  dir=""; for ((i=1;i<=$#;i++)); do [[ "${!i}" == --dir ]] && { j=$((i+1)); dir="${!j}"; }; done\n' +
        `  cat > "$dir/release-manifest.json" <<'MANIFEST'\n${staleManifest}\nMANIFEST\n` +
        '  exit 0\n' +
        'fi\n' +
        'exit 1\n',
    );
    fs.chmodSync(path.join(fx.fakebin, 'gh'), 0o755);

    const result = runProduce(fx);

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('helper computer-mac input changed');
  });

  it('fails closed when computer-mac drifts with no prior record to carry forward', () => {
    const root = tmp('attest-produce-manifest-drift-');
    const fx = buildManifestFixture(root);
    // No seeded manifest at all: computer-mac has no recorded digest, and this
    // producer never rebuilds it, so it must refuse rather than ship a stale
    // or missing helper record.
    const result = runProduce(fx);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('helper computer-mac input changed');
    expect(result.stdout + result.stderr).toContain('publish-computer-helper-mac.sh');
  });
});
