import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');

let testHome: string;

afterEach(() => {
  if (testHome) fs.rmSync(testHome, { recursive: true, force: true });
});

function guardedHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-teams-home-'));
  const systemDir = path.join(home, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
  testHome = home;
  return home;
}

function run(args: string[]): { stdout: string; status: number | null } {
  const home = guardedHome();
  const r = spawnSync('bun', [INDEX, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      AGENTS_NO_UPDATE_CHECK: '1',
      AGENTS_NO_USAGE_TRACK: '1',
      AGENTS_SKIP_MIGRATION: '1',
    },
  });
  return { stdout: r.stdout ?? '', status: r.status };
}

describe('teams list output modes', () => {
  it('keeps piped stdout human-readable unless --json is passed', () => {
    const { stdout, status } = run(['teams', 'list']);
    expect(status).toBe(0);
    expect(stdout).toContain("You haven't started any teams yet.");
    expect(() => JSON.parse(stdout)).toThrow();
  });

  it('emits JSON when --json is passed', () => {
    const { stdout, status } = run(['teams', 'list', '--json']);
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ teams: [] });
  });
});
