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
// read the actual files the commands wrote: per-device docs under
// devices/<name>/agents.yaml (device layer) and central agents.yaml
// fleet.defaults.config (fleet layer).
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
      // Default identity is mac-mini so machine-local keys (scheduler, tmux,
      // browser consent) can be set in these tests. Override per-call to act
      // as a different box.
      AGENTS_SYNC_MACHINE_ID: 'mac-mini',
      ...extraEnv,
    },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

function centralDoc(): string {
  const p = path.join(testHome, '.agents', 'agents.yaml');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
}

function deviceDoc(name: string): string {
  const p = path.join(testHome, '.agents', 'devices', name, 'agents.yaml');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
}

function addDevice(name: string, target = 'muqsit@192.0.2.1'): void {
  const r = run(['devices', 'add', name, target]);
  expect(r.status, r.stderr).toBe(0);
}

describe('devices config', () => {
  it('sets, gets, and unsets device-scope keys in the per-device doc', () => {
    guardedHome();
    addDevice('mac-mini', 'muqsit@192.0.2.2');

    const set = run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '4']);
    expect(set.status, set.stderr).toBe(0);
    expect(set.stdout).toContain('agents.max-concurrent = 4');
    expect(run(['devices', 'config', 'mac-mini', 'scheduler.enabled', 'off']).status).toBe(0);

    const doc = deviceDoc('mac-mini');
    expect(doc).toContain('config:');
    expect(doc).toContain('maxAgents: 4');
    expect(doc).toContain('schedulerEnabled: false');
    // Device scope never lands in central.
    expect(centralDoc()).not.toContain('maxAgents');

    const got = run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '--json']);
    expect(got.status).toBe(0);
    expect(JSON.parse(got.stdout)).toEqual({ device: 'mac-mini', key: 'agents.max-concurrent', value: 4, source: 'device' });

    const unset = run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '--unset']);
    expect(unset.status).toBe(0);
    expect(JSON.parse(run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '--json']).stdout).value).toBeNull();
    expect(deviceDoc('mac-mini')).not.toContain('maxAgents');
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

  it('prints the resolved config bare (non-TTY) and as JSON with per-key sources', () => {
    guardedHome();
    addDevice('mac-mini', 'muqsit@192.0.2.2');
    expect(run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '4']).status).toBe(0);

    const show = run(['devices', 'config', 'mac-mini']);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain("Config for 'mac-mini'");
    expect(show.stdout).toContain('agents.max-concurrent');
    expect(show.stdout).toContain('auto-launch.enabled');

    const json = run(['devices', 'config', 'mac-mini', '--json']);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.device).toBe('mac-mini');
    expect(parsed.config['agents.max-concurrent']).toEqual({ value: 4, source: 'device' });
    expect(parsed.config['scheduler.enabled']).toEqual({ value: null, source: 'default' });
  });

  it('rejects bad values and unknown keys loudly', () => {
    guardedHome();
    addDevice('mac-mini', 'muqsit@192.0.2.2');

    expect(run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', 'four']).status).toBe(1);
    expect(run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '0']).status).toBe(1);
    const badBool = run(['devices', 'config', 'mac-mini', 'scheduler.enabled', 'maybe']);
    expect(badBool.status).toBe(1);
    expect(badBool.stderr).toContain('on/off');
    const unknown = run(['devices', 'config', 'mac-mini', 'nope.nope', '1']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("Unknown config key 'nope.nope'");
    expect(unknown.stderr).toContain('scheduler.enabled');
    expect(run(['devices', 'config', 'ghost', 'agents.max-concurrent', '2']).status).toBe(1);
  });

  it('stores ssh.* profile overrides in the device doc and resolves them into list --json', () => {
    guardedHome();
    addDevice('worker', 'muqsit@192.0.2.3');

    expect(run(['devices', 'config', 'worker', 'ssh.identity-file', '/keys/fleet worker']).status).toBe(0);
    expect(deviceDoc('worker')).toContain('sshIdentityFile: /keys/fleet worker');

    const listed = run(['devices', 'list', '--json']);
    expect(listed.status, listed.stderr).toBe(0);
    const worker = JSON.parse(listed.stdout).find((device: { name: string }) => device.name === 'worker');
    // The row is the EFFECTIVE profile — registry overlaid with the config layers.
    expect(worker.auth).toMatchObject({ method: 'key', identityFile: '/keys/fleet worker' });
    expect(worker.config).toMatchObject({ sshIdentityFile: '/keys/fleet worker' });
  });
});

describe('devices config --fleet (fleet-wide defaults layer)', () => {
  it('writes central fleet.defaults.config and every device inherits it', () => {
    guardedHome();
    addDevice('mac-mini', 'muqsit@192.0.2.2');
    addDevice('zion', 'muqsit@192.0.2.1');

    const set = run(['devices', 'config', '--fleet', 'scheduler.enabled', 'off']);
    expect(set.status, set.stderr).toBe(0);
    expect(set.stdout).toContain('scheduler.enabled = false');

    const central = centralDoc();
    expect(central).toContain('defaults:');
    expect(central).toContain('schedulerEnabled: false');
    // No device doc is written for a fleet default.
    expect(deviceDoc('mac-mini')).not.toContain('schedulerEnabled');

    // This box can read the fleet-sourced effective value.
    const self = JSON.parse(run(['devices', 'config', 'mac-mini', 'scheduler.enabled', '--json']).stdout);
    expect(self).toEqual({ device: 'mac-mini', key: 'scheduler.enabled', value: false, source: 'fleet' });
    // A peer cannot read a machine-local key, even when the value is a fleet default.
    const peer = run(['devices', 'config', 'zion', 'scheduler.enabled', '--json']);
    expect(peer.status).toBe(1);
    expect(peer.stderr).toContain('machine-local');
  });

  it('a device value wins over the fleet default; unsetting falls back to it', () => {
    guardedHome();
    addDevice('mac-mini', 'muqsit@192.0.2.2');

    expect(run(['devices', 'config', '--fleet', 'agents.max-concurrent', '2']).status).toBe(0);
    expect(run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '4']).status).toBe(0);
    expect(JSON.parse(run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '--json']).stdout))
      .toEqual({ device: 'mac-mini', key: 'agents.max-concurrent', value: 4, source: 'device' });

    expect(run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '--unset']).status).toBe(0);
    expect(JSON.parse(run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '--json']).stdout))
      .toEqual({ device: 'mac-mini', key: 'agents.max-concurrent', value: 2, source: 'fleet' });

    // --fleet --unset removes the default; the key is back to built-in behavior.
    expect(run(['devices', 'config', '--fleet', 'agents.max-concurrent', '--unset']).status).toBe(0);
    expect(JSON.parse(run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '--json']).stdout))
      .toEqual({ device: 'mac-mini', key: 'agents.max-concurrent', value: null, source: 'default' });
  });

  it('bare --fleet prints the defaults layer; user-scope keys reject --fleet', () => {
    guardedHome();
    expect(run(['devices', 'config', '--fleet', 'agents.max-concurrent', '2']).status).toBe(0);

    const bare = run(['devices', 'config', '--fleet']);
    expect(bare.status).toBe(0);
    expect(bare.stdout).toContain('Fleet-wide config defaults');
    expect(bare.stdout).toContain('agents.max-concurrent');

    const json = JSON.parse(run(['devices', 'config', '--fleet', '--json']).stdout);
    expect(json.fleet).toBe(true);
    expect(json.config['agents.max-concurrent']).toEqual({ value: 2, source: 'fleet' });

    const userScope = run(['devices', 'config', '--fleet', 'interactive.host', 'zion']);
    expect(userScope.status).toBe(1);
    expect(userScope.stderr).toContain('user-scope');
  });
});

describe('retired-subcommand tombstones', () => {
  it('configure forwards: stderr notice, device-doc write, --json shape', () => {
    guardedHome();
    addDevice('mac-mini', 'muqsit@192.0.2.2');

    const set = run(['devices', 'configure', 'mac-mini', '--max-agents', '4', '--scheduler', 'off']);
    expect(set.status, set.stderr).toBe(0);
    expect(set.stderr).toContain('Deprecated');
    expect(set.stderr).toContain('devices config');
    expect(set.stdout).not.toContain('Deprecated');
    expect(set.stdout).toContain('agents.max-concurrent = 4');

    const doc = deviceDoc('mac-mini');
    expect(doc).toContain('maxAgents: 4');
    expect(doc).toContain('schedulerEnabled: false');

    const got = run(['devices', 'configure', 'mac-mini', '--json']);
    expect(got.status).toBe(0);
    const parsed = JSON.parse(got.stdout);
    expect(parsed.device).toBe('mac-mini');
    expect(parsed.config['agents.max-concurrent']).toEqual({ value: 4, source: 'device' });
    expect(parsed.config['scheduler.enabled']).toEqual({ value: false, source: 'device' });

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

    expect(deviceDoc('mac-mini')).toContain('- runs the releases');
    expect(deviceDoc('mac-mini')).toContain('- do not reboot');

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

  it('set forwards: ssh.* flags land in the device doc; key-auth guard holds', () => {
    guardedHome();
    addDevice('worker', 'muqsit@192.0.2.3');
    expect(run(['devices', 'set', 'worker', '--auth', 'password', '--bundle', 'legacy', '--bundle-key', 'password']).status).toBe(0);

    const set = run(['devices', 'set', 'worker', '--auth', 'key', '--identity-file', '/keys/fleet worker']);
    expect(set.status, set.stderr).toBe(0);
    expect(set.stderr).toContain('Deprecated');
    expect(deviceDoc('worker')).toContain('sshIdentityFile: /keys/fleet worker');

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

  it('enable/disable/prefer/unprefer forward to the auto-launch keys in the device doc', () => {
    guardedHome();
    addDevice('zion');

    const off = run(['devices', 'disable', 'zion']);
    expect(off.status, off.stderr).toBe(0);
    expect(off.stderr).toContain('Deprecated');
    expect(off.stderr).toContain('auto-launch.enabled off');
    expect(deviceDoc('zion')).toContain('autoLaunchEnabled: false');

    expect(run(['devices', 'enable', 'zion']).status).toBe(0);
    expect(deviceDoc('zion')).not.toContain('autoLaunchEnabled');

    expect(run(['devices', 'prefer', 'zion']).status).toBe(0);
    expect(deviceDoc('zion')).toContain('autoLaunchPreferred: true');
    expect(run(['devices', 'unprefer', 'zion']).status).toBe(0);
    expect(deviceDoc('zion')).not.toContain('autoLaunchPreferred');

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
  it('marks the interactive host in the table and carries device-layer config in --json', () => {
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

describe('devices role', () => {
  it('a fleet-default worker role reaches a doc-less device in autoPoolWorkers', () => {
    guardedHome();
    addDevice('mac-mini', 'muqsit@192.0.2.2');
    addDevice('yosemite-s0', 'muqsit@192.0.2.3');

    // Fleet-wide default: every registered device is a worker.
    expect(run(['devices', 'config', '--fleet', 'role', 'worker']).status).toBe(0);

    // Marking yosemite-s0's own role creates ITS per-device doc; mac-mini
    // never gets one and must still resolve to 'worker' through the fleet
    // default — the exact gap #2622's non-author review flagged.
    const setRole = run(['devices', 'role', 'yosemite-s0', 'worker', '--json']);
    expect(setRole.status, setRole.stderr).toBe(0);
    const parsed = JSON.parse(setRole.stdout) as { autoPoolWorkers: string[] };
    expect(parsed.autoPoolWorkers).toContain('yosemite-s0');
    expect(parsed.autoPoolWorkers).toContain('mac-mini');

    // The human-readable path names it too.
    const text = run(['devices', 'role', 'yosemite-s0', 'worker']);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain('mac-mini');
  });
});

describe('devices describe (RUSH-3062 surface)', () => {
  // `describe` is thin sugar over the 'description' config key — these tests
  // pin that BOTH names drive the same store, not two parallel code paths.
  // Every `run()` is a full process spawn (~2s) and cli/AGENTS.md treats the
  // required check's latency as a correctness requirement, so this asserts through
  // the device doc — a file read — wherever a second CLI round-trip would only
  // re-read what was just written. The CLI reads that remain are the ones whose
  // POINT is the CLI surface: that `describe --json` and `config --json` return
  // the identical object, i.e. one store behind two names.
  it('describe: sets, reads back, unsets — and shares one store with `devices config`', () => {
    guardedHome();
    addDevice('mac-mini', 'muqsit@192.0.2.2');

    const set = run(['devices', 'describe', 'mac-mini', 'signing + notarize box']);
    expect(set.status, set.stderr).toBe(0);
    expect(set.stdout).toContain('description');
    expect(deviceDoc('mac-mini')).toContain('description: signing + notarize box');

    // The one assertion that genuinely needs both surfaces: same store, two names.
    const viaConfig = JSON.parse(run(['devices', 'config', 'mac-mini', 'description', '--json']).stdout);
    expect(viaConfig).toEqual({ device: 'mac-mini', key: 'description', value: 'signing + notarize box', source: 'device' });
    expect(JSON.parse(run(['devices', 'describe', 'mac-mini', '--json']).stdout)).toEqual(viaConfig);

    // Unquoted multi-word text joins the argv parts, same as config.
    expect(run(['devices', 'describe', 'mac-mini', 'gpu', 'box', '-', 'cuda', '12.4']).status).toBe(0);
    expect(deviceDoc('mac-mini')).toContain('description: gpu box - cuda 12.4');

    const unset = run(['devices', 'describe', 'mac-mini', '--unset']);
    expect(unset.status, unset.stderr).toBe(0);
    expect(deviceDoc('mac-mini')).not.toContain('description:');

    // Failure modes share this setup rather than paying for their own.
    const unknown = run(['devices', 'describe', 'zoin', 'nope']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toMatch(/Unknown device 'zoin'/);

    const tooLong = run(['devices', 'describe', 'mac-mini', 'x'.repeat(81)]);
    expect(tooLong.status).toBe(1);
    expect(tooLong.stderr).toContain('at most 80 characters');
  });

  it('end-to-end: describe + ignore reach both the human table and --json', () => {
    guardedHome();
    addDevice('mac-mini', 'muqsit@192.0.2.2');
    expect(run(['devices', 'describe', 'mac-mini', 'signing box']).status).toBe(0);
    expect(run(['devices', 'ignore', 'old-laptop']).status).toBe(0);

    const json = run(['devices', 'list', '--json']);
    expect(json.status, json.stderr).toBe(0);
    const row = (JSON.parse(json.stdout) as Array<Record<string, any>>).find((r) => r.name === 'mac-mini');
    expect(row).toBeDefined();
    expect(row!.description).toBe('signing box');
    // New disk fields ride the existing `health` object — additive, no renames.
    expect(row!.health.diskTotalBytes).toBeGreaterThan(0);
    expect(row!.health.diskFreeBytes).toBeGreaterThan(0);
    expect(row!.health.diskUsedPercent).toBeGreaterThanOrEqual(0);
    expect(row!.health.memTotalBytes).toBeGreaterThan(0);
    expect(row!.interactive).toBe(false);
    expect(row!.autoPool).toBeDefined();

    const list = run(['devices', 'list'], { COLUMNS: '200' });
    expect(list.status, list.stderr).toBe(0);
    const plain = list.stdout.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toMatch(/device\s+platform\s+spec\s+load\s+mem\s+disk\s+headroom/);
    expect(plain).toContain('signing box');
    expect(plain).toContain('disk free'); // Fleet capacity footer
    expect(plain).toContain("1 ignored node not listed — 'agents devices ignored'");
    // The local probe yields a real spec cell: "<n>c <RAM> <disk>", e.g.
    // "4c 15.6G 144G" or "20c 122G 3.7T". fmtBytes emits one optional decimal and
    // any of K/M/G/T/P, and which a runner produces depends on its hardware — so
    // match the SHAPE, not one machine's formatting. (/\d+c \d+G? \d/ passed on a
    // box rendering "122G" and failed on a runner rendering "15.6G".)
    expect(plain).toMatch(/\d+c \d+(\.\d+)?[KMGTP] \d+(\.\d+)?[KMGTP]/);
  });
});
