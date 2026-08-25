import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, 'release-worktree.sh');
const roots: string[] = [];

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('release-worktree.sh', () => {
  it('runs from clean origin/main while leaving dirty main and feature checkouts untouched', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-worktree-'));
    roots.push(root);
    const remote = path.join(root, 'remote.git');
    const caller = path.join(root, 'caller');

    git(root, 'init', '--bare', remote);
    git(root, 'clone', remote, caller);
    git(caller, 'config', 'user.name', 'Release Test');
    git(caller, 'config', 'user.email', 'release-test@example.com');
    fs.mkdirSync(path.join(caller, 'apps/cli/scripts'), { recursive: true });
    fs.mkdirSync(path.join(caller, '.agents/worktrees'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(caller, 'apps/cli/scripts/release-worktree.sh'));
    fs.writeFileSync(
      path.join(caller, 'apps/cli/scripts/release.sh'),
      '#!/usr/bin/env bash\nset -euo pipefail\n' +
        'test "$(git rev-parse --abbrev-ref HEAD)" = HEAD\n' +
        'test -z "$(git status --porcelain)"\n' +
        'target=""\n' +
        'for arg in "$@"; do [[ "$arg" == --* ]] || { target="$arg"; break; }; done\n' +
        'printf "isolated:%s:%s\\n" "$target" "${*: -1}"\n',
    );
    fs.chmodSync(path.join(caller, 'apps/cli/scripts/release.sh'), 0o755);
    git(caller, 'add', '.');
    git(caller, 'commit', '-m', 'initial');
    git(caller, 'branch', '-M', 'main');
    git(caller, 'push', '-u', 'origin', 'main');
    git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(caller, 'remote', 'set-head', 'origin', '--auto');
    fs.writeFileSync(path.join(caller, 'dirty-main.txt'), 'shared main work in progress\n');
    git(caller, 'worktree', 'add', '-b', 'feature', path.join(root, 'feature'), 'origin/main');
    const feature = path.join(root, 'feature');
    fs.writeFileSync(path.join(feature, 'dirty.txt'), 'caller work in progress\n');

    const result = spawnSync(
      'bash',
      [path.join(feature, 'apps/cli/scripts/release-worktree.sh'), caller, '--skip-tests', '9.8.7'],
      { cwd: feature, encoding: 'utf-8' },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('isolated:9.8.7:--orchestration-phase');
    expect(fs.readFileSync(path.join(caller, 'dirty-main.txt'), 'utf-8')).toBe(
      'shared main work in progress\n',
    );
    expect(fs.readFileSync(path.join(feature, 'dirty.txt'), 'utf-8')).toBe('caller work in progress\n');
    expect(git(caller, 'status', '--porcelain')).toBe('?? dirty-main.txt');
    expect(git(feature, 'status', '--porcelain')).toBe('?? dirty.txt');
    expect(fs.readdirSync(path.join(caller, '.agents/worktrees'))).toEqual([]);
  });
});

/**
 * Builds a caller repo whose `release.sh` stub records the environment it was
 * handed, so a test can assert what the wrapper exported into it.
 */
function callerRepoRecordingEnv(root: string): string {
  const remote = path.join(root, 'remote.git');
  const caller = path.join(root, 'caller');
  git(root, 'init', '--bare', remote);
  git(root, 'clone', remote, caller);
  git(caller, 'config', 'user.name', 'Release Test');
  git(caller, 'config', 'user.email', 'release-test@example.com');
  fs.mkdirSync(path.join(caller, 'apps/cli/scripts'), { recursive: true });
  fs.mkdirSync(path.join(caller, '.agents/worktrees'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(caller, 'apps/cli/scripts/release-worktree.sh'));
  fs.writeFileSync(
    path.join(caller, 'apps/cli/scripts/release.sh'),
    '#!/usr/bin/env bash\nset -euo pipefail\n' +
      'printf "STORE=%s\\n" "${RELEASE_ATTESTATION_DIR:-<unset>}"\n',
  );
  fs.chmodSync(path.join(caller, 'apps/cli/scripts/release.sh'), 0o755);
  git(caller, 'add', '.');
  git(caller, 'commit', '-m', 'initial');
  git(caller, 'branch', '-M', 'main');
  git(caller, 'push', '-u', 'origin', 'main');
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(caller, 'remote', 'set-head', 'origin', '--auto');
  return caller;
}

/**
 * RUSH-2970 trap 2: `release.sh` re-execs into a throwaway worktree, where
 * REPO_ROOT resolves to the worktree — so the attestation store the producer
 * wrote in the CALLER's checkout was invisible and `require` reported
 * "missing exact attestation key" with `?` for every key component, reading
 * like a key mismatch rather than a wrong directory.
 */
describe('release-worktree.sh — the attestation store the caller owns', () => {
  it('exports RELEASE_ATTESTATION_DIR to the caller store when the caller has one', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-worktree-store-'));
    roots.push(root);
    const caller = callerRepoRecordingEnv(root);
    fs.mkdirSync(path.join(caller, '.release-attestations'), { recursive: true });

    const result = spawnSync(
      'bash',
      [path.join(caller, 'apps/cli/scripts/release-worktree.sh'), caller, '--skip-tests', '9.8.7'],
      { cwd: caller, encoding: 'utf-8', env: { ...process.env, RELEASE_ATTESTATION_DIR: '' } },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`STORE=${path.join(caller, '.release-attestations')}`);
  });

  it('never overrides an explicit RELEASE_ATTESTATION_DIR', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-worktree-store-'));
    roots.push(root);
    const caller = callerRepoRecordingEnv(root);
    fs.mkdirSync(path.join(caller, '.release-attestations'), { recursive: true });
    const explicit = path.join(root, 'operator-chosen-store');
    fs.mkdirSync(explicit, { recursive: true });

    const result = spawnSync(
      'bash',
      [path.join(caller, 'apps/cli/scripts/release-worktree.sh'), caller, '--skip-tests', '9.8.7'],
      { cwd: caller, encoding: 'utf-8', env: { ...process.env, RELEASE_ATTESTATION_DIR: explicit } },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`STORE=${explicit}`);
  });

  it('leaves it unset when the caller has no store, rather than inventing a path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-worktree-store-'));
    roots.push(root);
    const caller = callerRepoRecordingEnv(root);

    const result = spawnSync(
      'bash',
      [path.join(caller, 'apps/cli/scripts/release-worktree.sh'), caller, '--skip-tests', '9.8.7'],
      { cwd: caller, encoding: 'utf-8', env: { ...process.env, RELEASE_ATTESTATION_DIR: '' } },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('STORE=<unset>');
  });
});
