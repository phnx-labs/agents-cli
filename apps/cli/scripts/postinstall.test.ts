import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');
const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-postinstall-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('postinstall alias shims', () => {
  it('writes aliases that exec the absolute agents-cli entrypoint', () => {
    const home = makeTempHome();
    const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'postinstall.js')], {
      env: {
        ...process.env,
        HOME: home,
        // postinstall derives SHIMS_DIR from os.homedir(), which reads USERPROFILE
        // on Windows (HOME is POSIX-only). Pin both so the temp home is honored.
        USERPROFILE: home,
        npm_config_global: 'true',
        AGENTS_INIT_SHELL: '0',
        SHELL: '/bin/sh',
      },
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr).toBe(0);

    const aliasPath = path.join(home, '.agents', '.cache', 'shims', 'sessions');
    const script = fs.readFileSync(aliasPath, 'utf-8');
    const match = script.match(/^AGENTS_BIN='([^']+)'$/m);

    expect(match).not.toBeNull();
    expect(path.isAbsolute(match![1])).toBe(true);
    expect(match![1]).toBe(path.join(REPO_ROOT, 'dist', 'index.js'));
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
    const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'postinstall.js')], {
      env: {
        ...process.env,
        HOME: home,
        // os.homedir() reads USERPROFILE on Windows; pin it alongside HOME.
        USERPROFILE: home,
        AGENTS_POSTINSTALL_SHIMS_ONLY: '1',
        SHELL: '/bin/sh',
      },
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');

    for (const name of ['sessions', 'secrets', 'browser', 'pty', 'teams']) {
      const script = fs.readFileSync(path.join(home, '.agents', '.cache', 'shims', name), 'utf-8');
      expect(script).toContain(`exec "$AGENTS_BIN" ${name} "$@"`);
      expect(script).toContain(path.join(REPO_ROOT, 'dist', 'index.js'));
    }
  });
});
