import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-resources-home-'));
  tempDirs.push(home);
  const systemDir = path.join(home, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
  return home;
}

function makeProject(): string {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-resources-project-'));
  tempDirs.push(project);
  return project;
}

function run(home: string, cwd: string, args: string[]): { stdout: string; status: number | null } {
  const r = spawnSync('bun', [INDEX, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, AGENTS_NO_UPDATE_CHECK: '1' },
  });
  return { stdout: r.stdout ?? '', status: r.status };
}

describe('resources command', () => {
  it('prints the merged resource union with the winning layer for duplicates', () => {
    const home = makeHome();
    const project = makeProject();
    fs.mkdirSync(path.join(home, '.agents', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(home, '.agents', '.system', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(project, '.agents', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents', '.system', 'skills', 'shared.md'), 'system');
    fs.writeFileSync(path.join(home, '.agents', 'skills', 'shared.md'), 'user');
    fs.writeFileSync(path.join(project, '.agents', 'skills', 'shared.md'), 'project');
    fs.writeFileSync(path.join(home, '.agents', '.system', 'skills', 'system-only.md'), 'system');

    const { stdout, status } = run(home, project, ['resources', '--merged']);

    expect(status).toBe(0);
    expect(stdout).toContain('Resources (2 merged)');
    expect(stdout).toContain('Skills (2)');
    expect(stdout).toMatch(/shared\s+project/);
    expect(stdout).toMatch(/system-only\s+system/);
    expect(stdout).not.toMatch(/shared\s+user/);
  });
});
