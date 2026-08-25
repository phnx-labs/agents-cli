/**
 * Exact-tree release attestations, exercised against REAL files and a REAL git
 * repo (no mocks). Parent-commit evidence, lock/policy/toolchain drift, and a
 * missing key must fail closed. Promote checks the on-disk tarball digest.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, 'release-attestation.sh');
const temps: string[] = [];

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sh(args: string[], cwd?: string): { status: number; out: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], { cwd, encoding: 'utf-8' });
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function sha256(file: string): string {
  const r = spawnSync('sha256sum', [file], { encoding: 'utf-8' });
  if (r.status === 0) return r.stdout.trim().split(/\s+/)[0];
  const s = spawnSync('shasum', ['-a', '256', file], { encoding: 'utf-8' });
  if (s.status !== 0) throw new Error(`sha256 failed: ${s.stderr}`);
  return s.stdout.trim().split(/\s+/)[0];
}

function initRepo(): { root: string; tree: string; commit: string } {
  const root = tmp('rel-attest-repo-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  fs.mkdirSync(path.join(root, 'apps/cli'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apps/cli/bun.lock'), 'lock-v1\n');
  fs.writeFileSync(path.join(root, 'apps/cli/vitest.config.ts'), 'export default {}\n');
  fs.writeFileSync(path.join(root, 'apps/cli/package.json'), '{"version":"1.0.0"}\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return {
    root,
    tree: git(root, 'rev-parse', 'HEAD^{tree}'),
    commit: git(root, 'rev-parse', 'HEAD'),
  };
}

function packTgz(dir: string, filename: string, body: string): { path: string; digest: string } {
  const tgz = path.join(dir, filename);
  fs.writeFileSync(tgz, body);
  return { path: tgz, digest: `sha256:${sha256(tgz)}` };
}

function record(opts: {
  tree: string;
  lock: string;
  policy: string;
  bun?: string;
  node?: string;
  platform?: string;
  suite?: string;
  filename: string;
  digest: string;
  conclusion?: string;
}): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: 'merge-candidate',
    candidateTree: opts.tree,
    candidateCommit: 'deadbeef',
    lockfileDigest: opts.lock,
    policyVersion: opts.policy,
    toolchain: { bun: opts.bun ?? '1.2.3', node: opts.node ?? 'v24.0.0', os: opts.platform ?? 'Linux-x86_64' },
    platform: opts.platform ?? 'Linux-x86_64',
    suite: opts.suite ?? 'selected',
    conclusion: opts.conclusion ?? 'pass',
    tarball: { filename: opts.filename, digest: opts.digest },
  });
}

const describeUnix = process.platform === 'win32' ? describe.skip : describe;

describeUnix('release-attestation.sh', () => {
  it('identity binds tree, lockfile, policy, and toolchain from a real repo', () => {
    const { root, tree, commit } = initRepo();
    const { status, out } = sh(['identity', '--repo-root', root], root);
    expect(status, out).toBe(0);
    const id = JSON.parse(out);
    expect(id.candidateTree).toBe(tree);
    expect(id.candidateCommit).toBe(commit);
    expect(id.lockfileDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(id.policyVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(id.toolchain.bun).toBeTruthy();
    expect(id.toolchain.node).toBeTruthy();
    expect(id.platform).toBeTruthy();
  });

  it('policyVersion depends only on file content, not the --repo-root checkout path (RUSH-2749)', () => {
    // release.sh re-execs into a freshly-named throwaway worktree on every
    // invocation (.agents/worktrees/release-v<version>-<pid>), and a
    // producer runs in its own separate worktree too -- so no two real
    // callers ever share one literal --repo-root. policy_version_of used to
    // hash the absolute file PATH alongside its content, so identical files
    // at two different checkouts of the exact same commit produced two
    // different policyVersion values, and no attestation any producer wrote
    // could ever satisfy release.sh's own require() call.
    const { root, commit } = initRepo();
    const idA = JSON.parse(sh(['identity', '--repo-root', root], root).out);

    const clone = tmp('rel-attest-clone-');
    spawnSync('git', ['clone', '-q', root, clone]);
    git(clone, 'checkout', '-q', commit);
    const idB = JSON.parse(sh(['identity', '--repo-root', clone], clone).out);

    expect(idA.policyVersion).toBe(idB.policyVersion);
    expect(idA.lockfileDigest).toBe(idB.lockfileDigest);
  });

  it('require accepts the exact tree/toolchain/lock/policy key and rejects a parent tree', () => {
    const { root, tree } = initRepo();
    const id = JSON.parse(sh(['identity', '--repo-root', root], root).out);
    const store = tmp('rel-attest-store-');
    const tarball = packTgz(store, 'phnx-labs-agents-cli-1.0.0.tgz', 'pretested-bytes');
    const src = path.join(store, 'in.json');
    fs.writeFileSync(
      src,
      record({
        tree,
        lock: id.lockfileDigest,
        policy: id.policyVersion,
        bun: id.toolchain.bun,
        node: id.toolchain.node,
        platform: id.platform,
        filename: 'phnx-labs-agents-cli-1.0.0.tgz',
        digest: tarball.digest,
      }),
    );
    const written = sh(['write', '--dir', store, '--file', src], root);
    expect(written.status, written.out).toBe(0);

    const ok = sh(
      [
        'require',
        '--dir',
        store,
        '--tree',
        tree,
        '--lock',
        id.lockfileDigest,
        '--policy',
        id.policyVersion,
        '--bun',
        id.toolchain.bun,
        '--node',
        id.toolchain.node,
        '--platform',
        id.platform,
        '--suite',
        'selected',
      ],
      root,
    );
    expect(ok.status, ok.out).toBe(0);
    expect(ok.out.trim()).toBe(written.out.trim());

    fs.writeFileSync(path.join(root, 'apps/cli/src.ts'), 'changed\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'child');
    const child = git(root, 'rev-parse', 'HEAD^{tree}');
    expect(child).not.toBe(tree);

    const otherHost = sh(
      [
        'require',
        '--dir',
        store,
        '--tree',
        tree,
        '--lock',
        id.lockfileDigest,
        '--policy',
        id.policyVersion,
        '--suite',
        'selected',
        '--repo-root',
        root,
      ],
      root,
    );
    expect(otherHost.status, otherHost.out).toBe(0);

    const parent = sh(
      [
        'require',
        '--dir',
        store,
        '--tree',
        child,
        '--lock',
        id.lockfileDigest,
        '--policy',
        id.policyVersion,
        '--bun',
        id.toolchain.bun,
        '--node',
        id.toolchain.node,
        '--platform',
        id.platform,
        '--suite',
        'selected',
      ],
      root,
    );
    expect(parent.status).not.toBe(0);
    expect(parent.out).toContain('missing exact attestation key');
    expect(parent.out).toContain(`tree=${child}`);
    expect(parent.out).not.toContain(tree);
  });

  it('rejects lock, policy, and toolchain mismatches and a failing conclusion', () => {
    const store = tmp('rel-attest-bad-');
    const tarball = packTgz(store, 'phnx-labs-agents-cli-1.0.0.tgz', 'x');
    const base = {
      tree: 'aaa',
      lock: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      policy: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
      filename: 'phnx-labs-agents-cli-1.0.0.tgz',
      digest: tarball.digest,
    };
    const file = path.join(store, 'a.json');
    fs.writeFileSync(file, record(base));
    expect(sh(['verify', '--file', file, '--tree', 'bbb']).status).not.toBe(0);
    expect(sh(['verify', '--file', file, '--tree', 'aaa', '--lock', 'sha256:dead']).out).toContain(
      'lock',
    );
    expect(sh(['verify', '--file', file, '--tree', 'aaa', '--policy', 'sha256:dead']).out).toContain(
      'policy',
    );
    expect(sh(['verify', '--file', file, '--tree', 'aaa', '--bun', '0.0.0']).out).toContain('bun');
    fs.writeFileSync(file, record({ ...base, conclusion: 'fail' }));
    expect(sh(['verify', '--file', file, '--tree', 'aaa']).status).not.toBe(0);
  });

  it('promote accepts the attested tgz and refuses a rebuilt/different file', () => {
    const store = tmp('rel-attest-promote-');
    const tarball = packTgz(store, 'phnx-labs-agents-cli-9.9.9.tgz', 'exact-bytes');
    const file = path.join(store, 'att.json');
    fs.writeFileSync(
      file,
      record({
        tree: 'ttt',
        lock: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        policy: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        filename: 'phnx-labs-agents-cli-9.9.9.tgz',
        digest: tarball.digest,
      }),
    );
    const ok = sh(['promote', '--file', file, '--tarball', tarball.path, '--tree', 'ttt']);
    expect(ok.status, ok.out).toBe(0);
    expect(ok.out.trim()).toBe(tarball.path);

    const other = packTgz(store, 'phnx-labs-agents-cli-9.9.9.tgz', 'REBUILT');
    const bad = sh(['promote', '--file', file, '--tarball', other.path, '--tree', 'ttt']);
    expect(bad.status).not.toBe(0);
    expect(bad.out).toContain('refusing to publish a different artifact');
  });

  it('benchmarks require+promote well under the 180s ordinary-release P99', () => {
    const { root, tree } = initRepo();
    const id = JSON.parse(sh(['identity', '--repo-root', root], root).out);
    const store = tmp('rel-attest-bench-');
    const tarball = packTgz(store, 'phnx-labs-agents-cli-1.0.0.tgz', 'bench');
    const src = path.join(store, 'in.json');
    fs.writeFileSync(
      src,
      record({
        tree,
        lock: id.lockfileDigest,
        policy: id.policyVersion,
        bun: id.toolchain.bun,
        node: id.toolchain.node,
        platform: id.platform,
        filename: 'phnx-labs-agents-cli-1.0.0.tgz',
        digest: tarball.digest,
      }),
    );
    sh(['write', '--dir', store, '--file', src], root);
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const req = sh(
        [
          'require',
          '--dir',
          store,
          '--tree',
          tree,
          '--lock',
          id.lockfileDigest,
          '--policy',
          id.policyVersion,
          '--bun',
          id.toolchain.bun,
          '--node',
          id.toolchain.node,
          '--platform',
          id.platform,
          '--suite',
          'selected',
        ],
        root,
      );
      expect(req.status, req.out).toBe(0);
      const promo = sh(['promote', '--file', req.out.trim(), '--tarball', tarball.path, '--tree', tree]);
      expect(promo.status, promo.out).toBe(0);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p99 = samples[samples.length - 1];
    expect(p99).toBeLessThan(10_000);
  });
});
