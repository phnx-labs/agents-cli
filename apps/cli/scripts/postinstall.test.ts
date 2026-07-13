import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  // realpath: node's ESM loader canonicalizes the entry script's path, so the
  // paths postinstall derives from import.meta.url are /private/var/... on
  // macOS while os.tmpdir() reports /var/... — equality asserts need one form.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

const makeTempHome = () => makeTempDir('agents-postinstall-home-');

// Hermetic package tree: a copy of the real postinstall.js next to a stub
// dist/. postinstall resolves its entrypoints relative to its own file
// (import.meta.url), so running the copy keeps these tests independent of
// whether THIS checkout currently has a built dist/bin/agents (it does on a
// machine that ran scripts/sign-cli-binary.sh; it does not in CI).
function stagePackageTree(opts: { nativeBin?: string } = {}): string {
  const root = makeTempDir('agents-postinstall-pkg-');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist', 'bin'), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, 'scripts', 'postinstall.js'),
    path.join(root, 'scripts', 'postinstall.js'),
  );
  fs.writeFileSync(path.join(root, 'dist', 'index.js'), '// stub entrypoint\n');
  if (opts.nativeBin !== undefined) {
    fs.writeFileSync(path.join(root, 'dist', 'bin', 'agents'), opts.nativeBin, { mode: 0o755 });
  }
  return root;
}

function runPostinstall(
  root: string,
  home: string,
  extraEnv: Record<string, string | undefined> = {},
) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    // postinstall derives paths from os.homedir(), which reads USERPROFILE
    // on Windows (HOME is POSIX-only). Pin both so the temp home is honored.
    HOME: home,
    USERPROFILE: home,
    npm_config_global: 'true',
    AGENTS_INIT_SHELL: '0',
    SHELL: '/bin/sh',
    ...extraEnv,
  };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'postinstall.js')], {
    env: env as NodeJS.ProcessEnv,
    encoding: 'utf-8',
  });
}

function readShim(home: string, name: string): string {
  return fs.readFileSync(path.join(home, '.agents', '.cache', 'shims', name), 'utf-8');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('postinstall alias shims', () => {
  it('writes aliases that exec the absolute agents-cli entrypoint', () => {
    const home = makeTempHome();
    const root = stagePackageTree();
    const result = runPostinstall(root, home);

    expect(result.status, result.stderr).toBe(0);

    const script = readShim(home, 'sessions');
    const match = script.match(/^AGENTS_BIN='([^']+)'$/m);

    expect(match).not.toBeNull();
    expect(path.isAbsolute(match![1])).toBe(true);
    expect(match![1]).toBe(path.join(root, 'dist', 'index.js'));
    expect(script).toContain('if [ -z "$AGENTS_BIN" ] || [ ! -x "$AGENTS_BIN" ]; then');
    expect(script).toContain('agents: agents-cli entrypoint missing or not executable: $AGENTS_BIN');
    expect(script).toContain('exec "$AGENTS_BIN" sessions "$@"');
    expect(script).not.toContain('exec agents sessions "$@"');
  });

  it('shims-only mode writes aliases silently without the install flow', () => {
    // The self-updater installs with --ignore-scripts and then re-invokes
    // postinstall with this env var to refresh the alias shims. It must not
    // prompt, print, or take the local/global install branches.
    const home = makeTempHome();
    const root = stagePackageTree();
    const result = runPostinstall(root, home, {
      npm_config_global: undefined,
      AGENTS_INIT_SHELL: undefined,
      AGENTS_POSTINSTALL_SHIMS_ONLY: '1',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');

    for (const name of ['sessions', 'secrets', 'browser', 'pty', 'teams']) {
      const script = readShim(home, name);
      expect(script).toContain(`exec "$AGENTS_BIN" ${name} "$@"`);
      expect(script).toContain(path.join(root, 'dist', 'index.js'));
    }
  });
});

describe('postinstall signed-binary resolution (#315)', () => {
  it.runIf(process.platform === 'darwin')(
    'darwin: a runnable dist/bin/agents becomes the shim entrypoint',
    () => {
      const home = makeTempHome();
      const root = stagePackageTree({ nativeBin: '#!/bin/sh\necho 0.0.0-test\n' });
      const result = runPostinstall(root, home);

      expect(result.status, result.stderr).toBe(0);
      const script = readShim(home, 'sessions');
      const match = script.match(/^AGENTS_BIN='([^']+)'$/m);
      expect(match).not.toBeNull();
      expect(match![1]).toBe(path.join(root, 'dist', 'bin', 'agents'));
    },
  );

  it.runIf(process.platform === 'darwin')(
    'darwin: a present-but-broken dist/bin/agents falls back to the JS entrypoint with a warning',
    () => {
      const home = makeTempHome();
      const root = stagePackageTree({ nativeBin: '#!/bin/sh\nexit 7\n' });
      const result = runPostinstall(root, home);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain('failed to run');
      const script = readShim(home, 'sessions');
      const match = script.match(/^AGENTS_BIN='([^']+)'$/m);
      expect(match).not.toBeNull();
      expect(match![1]).toBe(path.join(root, 'dist', 'index.js'));
    },
  );

  it.runIf(process.platform !== 'darwin')(
    'non-darwin: dist/bin/agents is ignored even when present',
    () => {
      const home = makeTempHome();
      const root = stagePackageTree({ nativeBin: '#!/bin/sh\necho 0.0.0-test\n' });
      const result = runPostinstall(root, home);

      expect(result.status, result.stderr).toBe(0);
      const script = readShim(home, 'sessions');
      const match = script.match(/^AGENTS_BIN='([^']+)'$/m);
      expect(match).not.toBeNull();
      expect(match![1]).toBe(path.join(root, 'dist', 'index.js'));
    },
  );

  it.runIf(process.platform === 'darwin')(
    'darwin: repoints a ~/.local/bin link left at OUR dist/index.js, never a foreign link',
    () => {
      const home = makeTempHome();
      const root = stagePackageTree({ nativeBin: '#!/bin/sh\necho 0.0.0-test\n' });
      const binDir = path.join(home, '.local', 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      // A link a pre-#315 install left at the JS entrypoint: must be repointed.
      fs.symlinkSync(path.join(root, 'dist', 'index.js'), path.join(binDir, 'agents'));
      // A dev build's link pointing elsewhere: must be left untouched.
      const devTarget = path.join(root, 'somewhere-else', 'agents-dev');
      fs.symlinkSync(devTarget, path.join(binDir, 'ag'));

      // The retarget lives in ensureAgentsResolvablePosix, which is skipped
      // under CI=... — drop the gate for this child process only.
      const result = runPostinstall(root, home, { CI: undefined, AGENTS_NO_HEAL: undefined });

      expect(result.status, result.stderr).toBe(0);
      expect(fs.readlinkSync(path.join(binDir, 'agents'))).toBe(
        path.join(root, 'dist', 'bin', 'agents'),
      );
      expect(fs.readlinkSync(path.join(binDir, 'ag'))).toBe(devTarget);
      expect(result.stdout).toContain('Repointed');
    },
  );
});
