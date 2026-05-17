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
});
