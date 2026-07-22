import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
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

afterEach(() => {
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

describe('hq command', () => {
  it('emits a parseable floor snapshot through the real CLI parser', () => {
    testHome = makeHome();
    const result = spawnSync('bun', [INDEX, 'hq', 'floor', '--json'], {
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

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      version: number;
      counters: { rooms: number; agents: number; teams: number };
      rooms: unknown[];
      agents: unknown[];
      ambientEvents: unknown[];
      actions: Array<{ id: string; command: string[] }>;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.counters).toMatchObject({ rooms: 0, agents: 0, teams: 0 });
    expect(parsed.rooms).toEqual([]);
    expect(parsed.agents).toEqual([]);
    expect(parsed.ambientEvents).toEqual([]);
    expect(parsed.actions.find((a) => a.id === 'floor:create-team')?.command).toEqual([
      'teams',
      'create',
      '{team}',
      '--description',
      '{description}',
    ]);
  });
});
