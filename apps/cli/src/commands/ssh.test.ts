import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');

let testHome = '';

afterEach(() => {
  if (testHome) fs.rmSync(testHome, { recursive: true, force: true });
  testHome = '';
});

function guardedHome(): void {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-devices-home-'));
  const systemDir = path.join(testHome, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
}

function run(args: string[]): { stdout: string; status: number | null } {
  const r = spawnSync('bun', [INDEX, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: testHome, AGENTS_NO_UPDATE_CHECK: '1' },
  });
  return { stdout: r.stdout ?? '', status: r.status };
}

describe('devices command', () => {
  it('runs the list action when invoked without a subcommand', () => {
    guardedHome();
    const { stdout, status } = run(['devices']);

    expect(status).toBe(0);
    expect(stdout).toContain("No devices. Run 'agents devices sync'");
    expect(stdout).not.toContain('Usage: agents devices');
  });
});
