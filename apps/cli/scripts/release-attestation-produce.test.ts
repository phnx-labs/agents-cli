/**
 * release-attestation-produce.sh, exercised against a REAL git repo (no
 * mocks) with fake `bun`/`npm` binaries standing in for the real toolchain --
 * this test is about the script's orchestration (worktree isolation, fail-
 * closed on a red suite, attestation write + tarball placement), not about
 * re-running the real suite or a real `npm pack` inside a test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
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

function runProduce(fx: ReturnType<typeof buildFixture>, extraArgs: string[] = []) {
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
    { encoding: 'utf-8', env: { ...process.env, PATH: `${fx.fakebin}:${process.env.PATH}` } },
  );
}

describe('release-attestation-produce.sh', () => {
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
