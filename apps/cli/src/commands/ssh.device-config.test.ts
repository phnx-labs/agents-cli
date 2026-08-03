import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

// End-to-end tests for the device-config subcommands (`agents devices
// set-interactive|configure|note`). Spawns the REAL CLI against a throwaway
// HOME (same pattern as ssh.test.ts) — no mocking; the assertions read the
// actual agents.yaml files the commands wrote.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');

let testHome = '';

afterEach(() => {
  if (testHome) fs.rmSync(testHome, { recursive: true, force: true });
  testHome = '';
});

function guardedHome(): void {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-devices-config-home-'));
  const systemDir = path.join(testHome, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
}

function run(args: string[], extraEnv: Record<string, string> = {}): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('bun', [INDEX, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: testHome,
      // os.homedir() reads USERPROFILE on Windows, so HOME alone leaves the
      // spawned CLI resolving the real profile ('agents-cli is not set up').
      USERPROFILE: testHome,
      AGENTS_NO_UPDATE_CHECK: '1',
      AGENTS_NO_USAGE_TRACK: '1',
      ...extraEnv,
    },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

function deviceDoc(host: string): string {
  const p = path.join(testHome, '.agents', 'devices', host, 'agents.yaml');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
}
function centralDoc(): string {
  const p = path.join(testHome, '.agents', 'agents.yaml');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
}

describe('devices set-interactive', () => {
  it('reports unset, sets a registered device, reads back, and unsets', () => {
    guardedHome();

    const empty = run(['devices', 'set-interactive']);
    expect(empty.status).toBe(0);
    expect(empty.stdout).toContain('No interactive host set');

    expect(run(['devices', 'add', 'zion', 'muqsit@192.0.2.1']).status).toBe(0);

    const set = run(['devices', 'set-interactive', 'zion']);
    expect(set.status, set.stderr).toBe(0);
    expect(set.stdout).toContain("Interactive host: 'zion'");
    // User scope → central agents.yaml under config:.
    expect(centralDoc()).toContain('interactiveHost: zion');

    const got = run(['devices', 'set-interactive', '--json']);
    expect(got.status).toBe(0);
    expect(JSON.parse(got.stdout).interactiveHost).toBe('zion');

    const unset = run(['devices', 'set-interactive', '--unset']);
    expect(unset.status).toBe(0);
    expect(JSON.parse(run(['devices', 'set-interactive', '--json']).stdout).interactiveHost).toBeNull();
  });

  it('rejects a device that is not registered', () => {
    guardedHome();
    const r = run(['devices', 'set-interactive', 'ghost']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Unknown device 'ghost'");
  });
});

describe('devices configure', () => {
  it('writes device-scope keys into the named device’s doc and prints them back', () => {
    guardedHome();
    expect(run(['devices', 'add', 'mac-mini', 'muqsit@192.0.2.2']).status).toBe(0);

    const set = run(['devices', 'configure', 'mac-mini', '--max-agents', '4', '--scheduler', 'off']);
    expect(set.status, set.stderr).toBe(0);
    expect(set.stdout).toContain('agents.max-concurrent = 4');

    const doc = deviceDoc('mac-mini');
    expect(doc).toContain('maxAgents: 4');
    expect(doc).toContain('schedulerEnabled: false');
    // Device scope never lands in central.
    expect(centralDoc()).not.toContain('maxAgents');

    const got = run(['devices', 'configure', 'mac-mini', '--json']);
    expect(got.status).toBe(0);
    const parsed = JSON.parse(got.stdout);
    expect(parsed.device).toBe('mac-mini');
    expect(parsed.config).toMatchObject({
      'agents.max-concurrent': 4,
      'scheduler.enabled': false,
    });

    // No flags → print current config.
    const show = run(['devices', 'configure', 'mac-mini']);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain("Config for 'mac-mini'");
    expect(show.stdout).toContain('agents.max-concurrent');
  });

  it('rejects bad values loudly', () => {
    guardedHome();
    expect(run(['devices', 'add', 'mac-mini', 'muqsit@192.0.2.2']).status).toBe(0);

    expect(run(['devices', 'configure', 'mac-mini', '--max-agents', '0']).status).toBe(1);
    const badBool = run(['devices', 'configure', 'mac-mini', '--scheduler', 'maybe']);
    expect(badBool.status).toBe(1);
    expect(badBool.stderr).toContain("expects 'on' or 'off'");
    expect(run(['devices', 'configure', 'ghost', '--max-agents', '2']).status).toBe(1);
  });
});

describe('devices note', () => {
  it('appends notes, lists them, and clears', () => {
    guardedHome();
    expect(run(['devices', 'add', 'mac-mini', 'muqsit@192.0.2.2']).status).toBe(0);

    const first = run(['devices', 'note', 'mac-mini', 'runs the releases']);
    expect(first.status, first.stderr).toBe(0);
    const second = run(['devices', 'note', 'mac-mini', 'do not', 'reboot']);
    expect(second.status).toBe(0);

    const doc = deviceDoc('mac-mini');
    expect(doc).toContain('- runs the releases');
    expect(doc).toContain('- do not reboot');

    const got = run(['devices', 'note', 'mac-mini', '--json']);
    expect(JSON.parse(got.stdout).notes).toEqual(['runs the releases', 'do not reboot']);

    const show = run(['devices', 'note', 'mac-mini']);
    expect(show.stdout).toContain('runs the releases');
    expect(show.stdout).toContain('do not reboot');

    expect(run(['devices', 'note', 'mac-mini', '--clear']).status).toBe(0);
    expect(JSON.parse(run(['devices', 'note', 'mac-mini', '--json']).stdout).notes).toEqual([]);
  });
});

describe('devices list surfaces the config', () => {
  it('marks the interactive host in the table and carries config in --json', () => {
    guardedHome();
    expect(run(['devices', 'add', 'zion', 'muqsit@192.0.2.1']).status).toBe(0);
    expect(run(['devices', 'add', 'mac-mini', 'muqsit@192.0.2.2']).status).toBe(0);
    expect(run(['devices', 'set-interactive', 'zion']).status).toBe(0);
    expect(run(['devices', 'configure', 'mac-mini', '--max-agents', '4']).status).toBe(0);

    const table = run(['devices', 'list', '--no-stats']);
    expect(table.status, table.stderr).toBe(0);
    expect(table.stdout).toContain('★ interactive');

    const json = run(['devices', 'list', '--json']);
    expect(json.status).toBe(0);
    const rows = JSON.parse(json.stdout) as Array<{ name: string; interactive: boolean; config?: Record<string, unknown> }>;
    const zion = rows.find((r) => r.name === 'zion');
    const macMini = rows.find((r) => r.name === 'mac-mini');
    expect(zion?.interactive).toBe(true);
    expect(macMini?.interactive).toBe(false);
    expect(macMini?.config).toMatchObject({ maxAgents: 4 });
  });
});
