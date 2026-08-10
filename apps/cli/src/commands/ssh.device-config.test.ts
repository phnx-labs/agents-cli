import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

// End-to-end tests for the unified `agents devices config` surface and the
// retired-subcommand tombstones (configure / note / set / set-interactive /
// enable / disable / prefer / unprefer). Spawns the REAL CLI against a
// throwaway HOME (same pattern as ssh.test.ts) — no mocking; the assertions
// read the actual central agents.yaml the commands wrote.
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

function centralDoc(): string {
  const p = path.join(testHome, '.agents', 'agents.yaml');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
}

function addDevice(name: string, target = 'muqsit@192.0.2.1'): void {
  const r = run(['devices', 'add', name, target]);
  expect(r.status, r.stderr).toBe(0);
}

describe('devices config', () => {
  it('sets, gets, and unsets device-scope keys in the central fleet block', () => {
    guardedHome();
    addDevice('mac-mini', 'muqsit@192.0.2.2');

    const set = run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '4']);
    expect(set.status, set.stderr).toBe(0);
    expect(set.stdout).toContain('agents.max-concurrent = 4');
    // scheduler.enabled is machine-local: only mac-mini reads it, so it cannot
    // be set from here at all. The refusal names the ssh form to use instead.
    const peerMachineKey = run(['devices', 'config', 'mac-mini', 'scheduler.enabled', 'off']);
    expect(peerMachineKey.status).toBe(1);
    expect(peerMachineKey.stderr).toContain('machine-local');

    const central = centralDoc();
    expect(central).toContain('fleet:');
    expect(central).toContain('mac-mini:');
    expect(central).toContain('maxAgents: 4');
    // ...and it never reached the fleet-shared file.
    expect(central).not.toContain('schedulerEnabled');

    const got = run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '--json']);
    expect(got.status).toBe(0);
    expect(JSON.parse(got.stdout)).toEqual({ device: 'mac-mini', key: 'agents.max-concurrent', value: 4 });

    const unset = run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '--unset']);
    expect(unset.status).toBe(0);
    expect(JSON.parse(run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '--json']).stdout).value).toBeNull();
    expect(centralDoc()).not.toContain('maxAgents');
  });

  it('appends notes and accepts on/off/true/false booleans', () => {
    guardedHome();
    addDevice('mac-mini', 'muqsit@192.0.2.2');

    expect(run(['devices', 'config', 'mac-mini', 'notes', 'runs the releases']).status).toBe(0);
    expect(run(['devices', 'config', 'mac-mini', 'notes', 'do not', 'reboot']).status).toBe(0);
    const notes = JSON.parse(run(['devices', 'config', 'mac-mini', 'notes', '--json']).stdout);
    expect(notes.value).toEqual(['runs the releases', 'do not reboot']);

    expect(run(['devices', 'config', 'mac-mini', 'auto-launch.enabled', 'false']).status).toBe(0);
    const flag = JSON.parse(run(['devices', 'config', 'mac-mini', 'auto-launch.enabled', '--json']).stdout);
    expect(flag.value).toBe(false);
    expect(run(['devices', 'config', 'mac-mini', 'auto-launch.enabled', 'true']).status).toBe(0);
  });

  it('prints the resolved config bare (non-TTY) and as JSON', () => {
    guardedHome();
    addDevice('mac-mini', 'muqsit@192.0.2.2');
    expect(run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '4']).status).toBe(0);

    const show = run(['devices', 'config', 'mac-mini']);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain("Config for 'mac-mini'");
    expect(show.stdout).toContain('agents.max-concurrent');
    expect(show.stdout).toContain('auto-launch.enabled');

    const json = run(['devices', 'config', 'mac-mini', '--json']);
    expect(JSON.parse(json.stdout)).toEqual({ device: 'mac-mini', config: { 'agents.max-concurrent': 4 } });
  });

  it('rejects bad values and unknown keys loudly', () => {
    guardedHome();
    addDevice('mac-mini', 'muqsit@192.0.2.2');

    expect(run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', 'four']).status).toBe(1);
    expect(run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '0']).status).toBe(1);
    const badBool = run(['devices', 'config', 'mac-mini', 'auto-launch.enabled', 'maybe']);
    expect(badBool.status).toBe(1);
    expect(badBool.stderr).toContain('on/off');
    const unknown = run(['devices', 'config', 'mac-mini', 'nope.nope', '1']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("Unknown config key 'nope.nope'");
    expect(unknown.stderr).toContain('scheduler.enabled');
    expect(run(['devices', 'config', 'ghost', 'agents.max-concurrent', '2']).status).toBe(1);
  });

  it('stores ssh.* profile overrides centrally and resolves them into list --json', () => {
    guardedHome();
    addDevice('worker', 'muqsit@192.0.2.3');

    expect(run(['devices', 'config', 'worker', 'ssh.identity-file', '/keys/fleet worker']).status).toBe(0);
    expect(centralDoc()).toContain('sshIdentityFile: /keys/fleet worker');

    const listed = run(['devices', 'list', '--json']);
    expect(listed.status, listed.stderr).toBe(0);
    const worker = JSON.parse(listed.stdout).find((device: { name: string }) => device.name === 'worker');
    // The row is the EFFECTIVE profile — registry overlaid with the config.
    expect(worker.auth).toMatchObject({ method: 'key', identityFile: '/keys/fleet worker' });
    expect(worker.config).toMatchObject({ sshIdentityFile: '/keys/fleet worker' });
  });
});

describe('retired-subcommand tombstones', () => {
  it('configure forwards: stderr notice, same central write, same --json shape', () => {
    guardedHome();
    addDevice('mac-mini', 'muqsit@192.0.2.2');

    const set = run(['devices', 'configure', 'mac-mini', '--max-agents', '4']);
    expect(set.status, set.stderr).toBe(0);
    expect(set.stderr).toContain('Deprecated');
    expect(set.stderr).toContain('devices config');
    expect(set.stdout).not.toContain('Deprecated');
    expect(set.stdout).toContain('agents.max-concurrent = 4');

    // `--scheduler` against a PEER is refused now that scheduler.enabled is
    // machine-local — the tombstone forwards to config, which rejects it.
    const peerScheduler = run(['devices', 'configure', 'mac-mini', '--scheduler', 'off']);
    expect(peerScheduler.status).toBe(1);
    expect(peerScheduler.stderr).toContain('machine-local');

    const central = centralDoc();
    expect(central).toContain('maxAgents: 4');
    expect(central).not.toContain('schedulerEnabled');

    const got = run(['devices', 'configure', 'mac-mini', '--json']);
    expect(got.status).toBe(0);
    const parsed = JSON.parse(got.stdout);
    expect(parsed.device).toBe('mac-mini');
    expect(parsed.config).toMatchObject({ 'agents.max-concurrent': 4 });

    const show = run(['devices', 'configure', 'mac-mini']);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain("Config for 'mac-mini'");

    // Old validation errors survive the forward.
    expect(run(['devices', 'configure', 'mac-mini', '--max-agents', '0']).status).toBe(1);
    const badBool = run(['devices', 'configure', 'mac-mini', '--scheduler', 'maybe']);
    expect(badBool.status).toBe(1);
    expect(badBool.stderr).toContain("expects 'on' or 'off'");
  });

  it('note forwards: appends, lists, clears — same output shapes', () => {
    guardedHome();
    addDevice('mac-mini', 'muqsit@192.0.2.2');

    const first = run(['devices', 'note', 'mac-mini', 'runs the releases']);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stderr).toContain('Deprecated');
    expect(run(['devices', 'note', 'mac-mini', 'do not', 'reboot']).status).toBe(0);

    expect(centralDoc()).toContain('- runs the releases');
    expect(centralDoc()).toContain('- do not reboot');

    const got = run(['devices', 'note', 'mac-mini', '--json']);
    expect(JSON.parse(got.stdout).notes).toEqual(['runs the releases', 'do not reboot']);

    const show = run(['devices', 'note', 'mac-mini']);
    expect(show.stdout).toContain('runs the releases');

    expect(run(['devices', 'note', 'mac-mini', '--clear']).status).toBe(0);
    expect(JSON.parse(run(['devices', 'note', 'mac-mini', '--json']).stdout).notes).toEqual([]);
  });

  it('set-interactive forwards: notice, central user-scope key, same --json shape', () => {
    guardedHome();

    const empty = run(['devices', 'set-interactive']);
    expect(empty.status).toBe(0);
    expect(empty.stderr).toContain('Deprecated');
    expect(empty.stdout).toContain('No interactive host set');

    addDevice('zion');
    const set = run(['devices', 'set-interactive', 'zion']);
    expect(set.status, set.stderr).toBe(0);
    expect(set.stdout).toContain("Interactive host: 'zion'");
    expect(centralDoc()).toContain('interactiveHost: zion');

    const got = run(['devices', 'set-interactive', '--json']);
    expect(JSON.parse(got.stdout).interactiveHost).toBe('zion');

    expect(run(['devices', 'set-interactive', '--unset']).status).toBe(0);
    expect(JSON.parse(run(['devices', 'set-interactive', '--json']).stdout).interactiveHost).toBeNull();

    const ghost = run(['devices', 'set-interactive', 'ghost']);
    expect(ghost.status).toBe(1);
    expect(ghost.stderr).toContain("Unknown device 'ghost'");
  });

  it('set forwards: ssh.* flags land in the central block; key-auth guard holds', () => {
    guardedHome();
    addDevice('worker', 'muqsit@192.0.2.3');
    expect(run(['devices', 'set', 'worker', '--auth', 'password', '--bundle', 'legacy', '--bundle-key', 'password']).status).toBe(0);

    const set = run(['devices', 'set', 'worker', '--auth', 'key', '--identity-file', '/keys/fleet worker']);
    expect(set.status, set.stderr).toBe(0);
    expect(set.stderr).toContain('Deprecated');
    expect(centralDoc()).toContain('sshIdentityFile: /keys/fleet worker');

    const listed = run(['devices', 'list', '--json']);
    const worker = JSON.parse(listed.stdout).find((device: { name: string }) => device.name === 'worker');
    expect(worker.auth).toMatchObject({ method: 'key', identityFile: '/keys/fleet worker' });

    expect(run(['devices', 'set', 'worker', '--clear-identity-file']).status).toBe(0);
    const cleared = JSON.parse(run(['devices', 'list', '--json']).stdout).find((device: { name: string }) => device.name === 'worker');
    expect(cleared.auth.identityFile).toBeUndefined();

    expect(run(['devices', 'set', 'worker', '--auth', 'password', '--bundle', 'legacy']).status).toBe(0);
    const invalid = run(['devices', 'set', 'worker', '--identity-file', '/keys/wrong-mode']);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('--identity-file requires key auth');
  });

  it('enable/disable/prefer/unprefer forward to the auto-launch keys', () => {
    guardedHome();
    addDevice('zion');

    const off = run(['devices', 'disable', 'zion']);
    expect(off.status, off.stderr).toBe(0);
    expect(off.stderr).toContain('Deprecated');
    expect(off.stderr).toContain('auto-launch.enabled off');
    expect(centralDoc()).toContain('autoLaunchEnabled: false');

    expect(run(['devices', 'enable', 'zion']).status).toBe(0);
    expect(centralDoc()).not.toContain('autoLaunchEnabled');

    expect(run(['devices', 'prefer', 'zion']).status).toBe(0);
    expect(centralDoc()).toContain('autoLaunchPreferred: true');
    expect(run(['devices', 'unprefer', 'zion']).status).toBe(0);
    expect(centralDoc()).not.toContain('autoLaunchPreferred');

    const ghost = run(['devices', 'disable', 'zoin']);
    expect(ghost.status).toBe(1);
    expect(ghost.stderr).toMatch(/Unknown device 'zoin'/);
  });

  it('none of the retired names appears in devices --help', () => {
    guardedHome();
    const help = run(['devices', '--help']);
    expect(help.status).toBe(0);
    for (const retired of ['configure', 'note', 'set-interactive', 'enable', 'disable', 'prefer', 'unprefer']) {
      expect(help.stdout).not.toMatch(new RegExp(`^  ${retired}\\b`, 'm'));
    }
    expect(help.stdout).toContain('config');
  });
});

describe('devices list surfaces the config', () => {
  it('marks the interactive host in the table and carries config in --json', () => {
    guardedHome();
    addDevice('zion');
    addDevice('mac-mini', 'muqsit@192.0.2.2');
    expect(run(['devices', 'config', 'zion', 'interactive.host', 'zion']).status).toBe(0);
    expect(run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '4']).status).toBe(0);

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
