/**
 * agents devices — retired-subcommand tombstones.
 *
 * Split out of a single 18-test `ssh.device-config.test.ts` that ran ~44s
 * locally (151s on a loaded worker) — 8.4s per test, and one of the files
 * setting the suite's floor: vitest parallelises across FILES and runs one
 * file's tests sequentially in a single worker. Shared spawn harness lives in
 * `device-config-test-harness.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  guardedHome,
  run,
  centralDoc,
  deviceDoc,
  addDevice,
} from './device-config-test-harness.js';

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
