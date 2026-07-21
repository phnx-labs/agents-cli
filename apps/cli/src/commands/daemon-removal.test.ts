import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function run(args: string[]): ReturnType<typeof spawnSync> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-daemon-removed-'));
  const systemDir = path.join(home, '.agents', '.system', '.git');
  fs.mkdirSync(systemDir, { recursive: true });
  try {
    return spawnSync('node', ['--import', 'tsx', 'src/index.ts', ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        AGENTS_SKIP_MIGRATION: '1',
        AGENTS_NO_AUTOPULL: '1',
        AGENTS_CLI_DISABLE_AUTO_UPDATE: '1',
      },
      encoding: 'utf-8',
      timeout: 30_000,
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('removed daemon command', () => {
  it('does not resolve the legacy agents daemon command tree', () => {
    const res = run(['daemon', 'start']);
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}\n${res.stderr}`).toContain("unknown command 'daemon'");
  });
});
