import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');
const PACKAGE_VERSION = (JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'),
) as { version: string }).version;

let testHome = '';
let ambientAgent: ChildProcess | undefined;
let ambientBinDir = '';
const ambientProcessIt = process.platform === 'win32' ? it.skip : it;

afterEach(() => {
  if (ambientAgent?.pid && !ambientAgent.killed) ambientAgent.kill();
  ambientAgent = undefined;
  if (ambientBinDir) fs.rmSync(ambientBinDir, { recursive: true, force: true });
  ambientBinDir = '';
  if (testHome) fs.rmSync(testHome, { recursive: true, force: true });
  testHome = '';
});

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-hq-home-'));
  const systemDir = path.join(home, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: Date.now(), latestVersion: PACKAGE_VERSION }),
  );
  return home;
}

function runHqFloor(): ReturnType<typeof spawnSync> {
  testHome = makeHome();
  return spawnSync('bun', [INDEX, 'hq', 'floor', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: testHome,
      AGENTS_NO_UPDATE_CHECK: '1',
      AGENTS_NO_AUTOPULL: '1',
      AGENTS_SKIP_MIGRATION: '1',
    },
  });
}

function parseFloor(stdout: string): {
  version: number;
  counters: {
    rooms: number;
    agents: number;
    teams: number;
    needsInput: number;
    failed: number;
    prs: number;
  };
  rooms: Array<{ counts: { agents: number; needsInput: number; failed: number } }>;
  agents: Array<{ pid?: number; mood?: string; prUrl?: string }>;
  ambientEvents: unknown[];
  actions: Array<{ id: string; command: string[] }>;
} {
  return JSON.parse(stdout);
}

async function waitForProcess(pid: number): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf-8' });
    if (result.stdout.trim() === 'codex') return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`ambient codex process ${pid} did not appear in ps`);
}

async function startAmbientAgentProcess(): Promise<number> {
  ambientBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-hq-bin-'));
  const codexPath = path.join(ambientBinDir, 'codex');
  fs.symlinkSync('/bin/sleep', codexPath);
  ambientAgent = spawn(codexPath, ['30'], { stdio: 'ignore' });
  if (!ambientAgent.pid) throw new Error('failed to spawn ambient codex process');
  await waitForProcess(ambientAgent.pid);
  return ambientAgent.pid;
}

describe('hq command', () => {
  it('emits a parseable floor snapshot through the real CLI parser', () => {
    const result = runHqFloor();

    expect(result.status).toBe(0);
    const parsed = parseFloor(result.stdout);
    expect(parsed.version).toBe(1);
    expect(parsed.counters.rooms).toBe(parsed.rooms.length);
    expect(parsed.counters.agents).toBe(parsed.agents.length);
    expect(parsed.counters.needsInput).toBe(parsed.agents.filter((a) => a.mood === 'waiting').length);
    expect(parsed.counters.failed).toBe(parsed.agents.filter((a) => a.mood === 'blocked').length);
    expect(parsed.counters.prs).toBe(parsed.agents.filter((a) => a.prUrl).length);
    expect(parsed.actions.find((a) => a.id === 'floor:create-team')?.command).toEqual([
      'teams',
      'create',
      '{team}',
      '--description',
      '{description}',
    ]);
  });

  ambientProcessIt('keeps the real CLI parser hermetic with ambient agent processes', async () => {
    const pid = await startAmbientAgentProcess();
    const result = runHqFloor();

    expect(result.status).toBe(0);
    const parsed = parseFloor(result.stdout);
    expect(parsed.agents.some((agent) => agent.pid === pid)).toBe(true);
    expect(parsed.counters.agents).toBe(parsed.agents.length);
    expect(parsed.counters.rooms).toBe(parsed.rooms.length);
    expect(parsed.rooms.reduce((sum, room) => sum + room.counts.agents, 0)).toBe(parsed.counters.agents);
  });
});
