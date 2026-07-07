import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';

const cliEntry = path.resolve('src/index.ts');
const tsxBin = path.resolve('node_modules/.bin/tsx');
const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf-8')) as { version: string };

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-beta-'));
  tempDirs.push(dir);
  return dir;
}

function writeUpdateCache(home: string): void {
  const cacheDir = path.join(home, '.agents', '.cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, '.update-check'),
    JSON.stringify({ lastCheck: Date.now(), latestVersion: packageJson.version }),
    'utf-8'
  );
  // ensureInitialized() checks for ~/.agents/.system/.git to confirm setup.
  fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
}

function runAgents(args: string[], home: string) {
  return spawnSync(tsxBin, [cliEntry, ...args], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      HOME: home,
      AGENTS_SKIP_MIGRATION: '1',
      NODE_NO_WARNINGS: '1',
    },
    encoding: 'utf-8',
  });
}

function outputOf(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}${result.stderr}`;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('agents beta', () => {
  it('blocks beta-gated commands until enabled', () => {
    const home = makeTempHome();
    writeUpdateCache(home);

    const drive = runAgents(['drive', 'status'], home);
    const factory = runAgents(['factory', 'submit', 'EXAMPLE-1'], home);

    expect(drive.status).toBe(1);
    expect(outputOf(drive)).toContain('agents drive is in beta.');
    expect(outputOf(drive)).toContain('agents beta enable drive');

    expect(factory.status).toBe(1);
    expect(outputOf(factory)).toContain('agents factory is in beta.');
    expect(outputOf(factory)).toContain('agents beta enable factory');
  });

  it('stores beta flags in ~/.agents/agents.yaml when no personal repo exists', () => {
    const home = makeTempHome();
    writeUpdateCache(home);

    const enable = runAgents(['beta', 'enable', 'drive'], home);
    const list = runAgents(['beta', 'list'], home);
    const drive = runAgents(['drive', 'status'], home);

    expect(enable.status).toBe(0);
    expect(fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8')).toContain('beta:');
    expect(fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8')).toContain('- drive');
    expect(outputOf(list)).toContain(path.join(home, '.agents', 'agents.yaml'));
    expect(drive.status).toBe(0);
    expect(outputOf(drive)).toContain('Drive');
  });

  it('stores beta flags in ~/.agents/agents.yaml when a personal repo exists', () => {
    const home = makeTempHome();
    writeUpdateCache(home);
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });

    const enable = runAgents(['beta', 'enable', 'drive', 'factory'], home);
    const list = runAgents(['beta', 'list'], home);
    const drive = runAgents(['drive', 'status'], home);
    const factory = runAgents(['factory', 'submit', 'EXAMPLE-1'], home);

    expect(enable.status).toBe(0);
    expect(fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8')).toContain('beta:');
    expect(fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8')).toContain('- drive');
    expect(fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8')).toContain('- factory');
    expect(outputOf(list)).toContain(path.join(home, '.agents', 'agents.yaml'));
    expect(drive.status).toBe(0);
    expect(outputOf(drive)).toContain('Drive');
    expect(factory.status).toBe(1);
    expect(outputOf(factory)).toContain('FACTORY_FLOOR_URL is not set.');
  });

  it('gates session sync behind the session-sync beta feature (off by default)', () => {
    const home = makeTempHome();
    writeUpdateCache(home);

    // Fresh home: not opted in -> status is disabled and hints the beta enable.
    const before = runAgents(['sessions', 'sync', '--status'], home);
    expect(before.status).toBe(0);
    expect(outputOf(before)).toContain('disabled');
    expect(outputOf(before)).toContain('agents beta enable session-sync');

    // --enable delegates to the beta framework (single source of truth).
    const enable = runAgents(['sessions', 'sync', '--enable'], home);
    expect(enable.status).toBe(0);
    expect(fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8')).toContain('- session-sync');

    const after = runAgents(['sessions', 'sync', '--status'], home);
    expect(outputOf(after)).toContain('enabled (beta)');

    // --disable removes it again — no parallel switch left behind.
    const disable = runAgents(['sessions', 'sync', '--disable'], home);
    expect(disable.status).toBe(0);
    expect(fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8')).not.toContain('- session-sync');
  });
});
