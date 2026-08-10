import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

const makeTempHome = () => makeTempDir('agents-install-home-');

/**
 * Hermetic package tree: the real scripts/install.sh next to a stub dist/ and a
 * dependency-free package.json. install.sh cd's to its own parent and packs
 * whatever is there, so the copy exercises the real pack -> npm install -> link
 * path without needing this checkout to carry a built dist/ (the CI test shards
 * run vitest straight after `bun install`, with no `bun run build`).
 */
function stagePackageTree(): string {
  const root = makeTempDir('agents-install-pkg-');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, 'scripts', 'install.sh'),
    path.join(root, 'scripts', 'install.sh'),
  );
  fs.chmodSync(path.join(root, 'scripts', 'install.sh'), 0o755);
  fs.writeFileSync(
    path.join(root, 'dist', 'index.js'),
    '#!/usr/bin/env node\nconsole.log("0.0.0-stub");\n',
    { mode: 0o755 },
  );
  // install.sh stages this into the tarball; its own scripts entry is stripped
  // from the staged package.json, so the content never runs.
  fs.writeFileSync(path.join(root, 'scripts', 'postinstall.js'), '// stub\n');
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: '@phnx-labs/agents-cli',
        version: '9.9.9',
        bin: { agents: 'dist/index.js', ag: 'dist/index.js', browser: 'dist/index.js' },
        files: ['dist'],
      },
      null,
      2,
    ),
  );
  return root;
}

function runInstall(root: string, home: string, extraArgs: string[] = []) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    // The daemon bounce is opt-in, but keep CI semantics explicit either way.
    CI: undefined,
    AGENTS_NO_HEAL: undefined,
  };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  return spawnSync(
    'bash',
    [path.join(root, 'scripts', 'install.sh'), '--skip-build', '--skip-tests', ...extraArgs],
    { env: env as NodeJS.ProcessEnv, encoding: 'utf-8', cwd: root },
  );
}

const linkDir = (home: string) => path.join(home, '.local', 'bin');
const devPrefix = (home: string) => path.join(home, '.local', 'agents-cli-dev');

/** Exists as a path entry, following symlinks — false for a dangling link. */
const resolves = (p: string) => fs.existsSync(p);
/** Exists as a directory entry — true even for a dangling symlink. */
const present = (p: string) => fs.existsSync(p) || fs.lstatSync(p, { throwIfNoEntry: false }) != null;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === 'win32')('install.sh dev bin naming', () => {
  it('publishes agents-dev/ag-dev and never the production names', () => {
    const home = makeTempHome();
    const root = stagePackageTree();
    const result = runInstall(root, home);

    expect(result.status, result.stderr).toBe(0);

    // The dev build is reachable under its own name.
    expect(resolves(path.join(linkDir(home), 'agents-dev'))).toBe(true);
    expect(resolves(path.join(linkDir(home), 'ag-dev'))).toBe(true);
    expect(fs.realpathSync(path.join(linkDir(home), 'agents-dev'))).toContain(devPrefix(home));

    // The production command names are never created.
    for (const name of ['agents', 'ag', 'browser']) {
      expect(present(path.join(linkDir(home), name)), `${name} must not be created`).toBe(false);
    }
  });

  it('removes a dangling shadow link a previous run left in the dev prefix', () => {
    const home = makeTempHome();
    const root = stagePackageTree();
    fs.mkdirSync(linkDir(home), { recursive: true });

    // The exact shape an older install.sh leaves once the dev prefix is cleaned:
    // a symlink into the dev prefix whose target no longer exists. `[[ -e ]]` is
    // false for this, which is why the cleanup uses `[[ -L ]]` + readlink.
    const shadow = path.join(linkDir(home), 'agents');
    fs.symlinkSync(path.join(devPrefix(home), 'bin', 'agents'), shadow);
    expect(fs.existsSync(shadow)).toBe(false); // dangling
    expect(fs.lstatSync(shadow).isSymbolicLink()).toBe(true);

    const result = runInstall(root, home);
    expect(result.status, result.stderr).toBe(0);

    expect(fs.lstatSync(shadow, { throwIfNoEntry: false })).toBeUndefined();
    expect(result.stdout).toContain('Removed stale dev link');
  });

  it('leaves a production `agents` link that points outside the dev prefix untouched', () => {
    const home = makeTempHome();
    const root = stagePackageTree();
    fs.mkdirSync(linkDir(home), { recursive: true });

    // Stand-in for the registry install / Homebrew / a hand-made alias.
    const decoyTarget = path.join(home, 'registry-install', 'agents');
    fs.mkdirSync(path.dirname(decoyTarget), { recursive: true });
    fs.writeFileSync(decoyTarget, '#!/bin/sh\necho registry\n', { mode: 0o755 });
    const link = path.join(linkDir(home), 'agents');
    fs.symlinkSync(decoyTarget, link);

    const result = runInstall(root, home);
    expect(result.status, result.stderr).toBe(0);

    expect(fs.readlinkSync(link)).toBe(decoyTarget);
  });

  it('leaves the shared daemon on production code unless --bounce-daemon is passed', () => {
    const home = makeTempHome();
    const root = stagePackageTree();
    const result = runInstall(root, home);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Shared daemon left on production code');
    expect(result.stdout).not.toContain('Reloading daemon onto this build');
  });
});
