import { describe, it, expect } from 'vitest';
import {
  planFleetTargets,
  remoteFleetTargets,
  fanOutDevices,
  runFleet,
  skipLabel,
  upgradeCommand,
  type FleetTarget,
} from './fleet.js';
import type { DeviceProfile, DeviceRegistry } from './registry.js';

function device(overrides: Partial<DeviceProfile> & { name: string }): DeviceProfile {
  const now = '2026-07-14T00:00:00.000Z';
  return {
    name: overrides.name,
    platform: overrides.platform ?? 'linux',
    shell: overrides.shell ?? 'posix',
    user: overrides.user ?? 'muqsit',
    address: overrides.address ?? { via: 'manual', dnsName: `${overrides.name}.ts.net` },
    auth: overrides.auth ?? { method: 'key' },
    tailscale: overrides.tailscale,
    role: overrides.role,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

describe('planFleetTargets', () => {
  it('skips Tailscale-offline devices and keeps online ones', () => {
    const reg: DeviceRegistry = {
      alive: device({ name: 'alive', tailscale: { online: true, direct: true } }),
      dead: device({ name: 'dead', tailscale: { online: false, direct: false, lastSeen: 'yesterday' } }),
      manual: device({ name: 'manual' }), // no tailscale snapshot → try
    };
    const plan = planFleetTargets(reg);
    const byName = Object.fromEntries(plan.map((t) => [t.device.name, t]));
    expect(byName.alive.skip).toBeUndefined();
    expect(byName.dead.skip).toBe('offline');
    expect(byName.manual.skip).toBeUndefined();
  });

  it('skips devices with no address', () => {
    const reg: DeviceRegistry = {
      bare: device({ name: 'bare', address: { via: 'manual' } }),
    };
    const plan = planFleetTargets(reg);
    expect(plan[0].skip).toBe('no-address');
  });

  it('skips a control device (a cockpit) even when online with a real platform', () => {
    const reg: DeviceRegistry = {
      worker: device({ name: 'worker', tailscale: { online: true, direct: true } }),
      phone: device({
        name: 'phone',
        platform: 'linux', // a real platform — must still be skipped by role
        role: 'control',
        tailscale: { online: true, direct: true },
      }),
    };
    const byName = Object.fromEntries(planFleetTargets(reg).map((t) => [t.device.name, t]));
    expect(byName.worker.skip).toBeUndefined();
    expect(byName.phone.skip).toBe('control'); // update/run/list never dial it
  });
});

describe('remoteFleetTargets (fleet health/drift gate targeting)', () => {
  it('drops this machine and control cockpits, but keeps offline/no-address as faults', () => {
    const reg: DeviceRegistry = {
      zion: device({ name: 'zion', tailscale: { online: true, direct: true } }), // self
      worker: device({ name: 'worker', tailscale: { online: true, direct: true } }),
      cockpit: device({ name: 'cockpit', role: 'control', tailscale: { online: true, direct: true } }),
      dead: device({ name: 'dead', tailscale: { online: false, direct: false, lastSeen: 'y' } }),
    };
    const targets = remoteFleetTargets(planFleetTargets(reg), 'zion');
    const byName = Object.fromEntries(targets.map((t) => [t.device.name, t]));
    // A registered cockpit must NOT reach the fan-out — otherwise the CI gate
    // (check --devices / fleet status --strict) fails on every run for its skip.
    expect(byName.cockpit).toBeUndefined();
    expect(byName.zion).toBeUndefined(); // self is probed in-process, not fanned out
    expect(byName.worker.skip).toBeUndefined(); // a real probe target
    expect(byName.dead.skip).toBe('offline'); // genuine fault — kept, surfaces as unreachable
  });
});

describe('runFleet', () => {
  it('skips offline targets and reports per-device ok/failed', () => {
    const targets: FleetTarget[] = [
      { device: device({ name: 'a' }) },
      { device: device({ name: 'b' }), skip: 'offline' },
      { device: device({ name: 'c' }) },
    ];
    const results = runFleet(targets, ['agents', 'upgrade', '--yes'], {
      runner: (d) => {
        if (d.name === 'a') return { code: 0, stdout: 'ok', stderr: '' };
        return { code: 1, stdout: '', stderr: 'npm ERR' };
      },
    });
    expect(results).toEqual([
      { name: 'a', status: 'ok', code: 0, detail: undefined },
      { name: 'b', status: 'skipped', code: null, reason: 'offline' },
      { name: 'c', status: 'failed', code: 1, detail: 'npm ERR' },
    ]);
  });

  it('records a throwing device as failed and continues the rest', () => {
    const targets: FleetTarget[] = [
      { device: device({ name: 'a' }) },
      { device: device({ name: 'b' }) },
      { device: device({ name: 'c' }) },
    ];
    const results = runFleet(targets, ['true'], {
      runner: (d) => {
        if (d.name === 'b') throw new Error('password auth but no secrets bundle');
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    expect(results.map((r) => r.status)).toEqual(['ok', 'failed', 'ok']);
    expect(results[1].detail).toMatch(/password auth/);
  });

  it('runs the self target locally (never ssh) so fleet update upgrades this box too', () => {
    const targets: FleetTarget[] = [
      { device: device({ name: 'zion' }) }, // this machine
      { device: device({ name: 'worker' }) },
    ];
    const sshed: string[] = [];
    const localRan: string[][] = [];
    const results = runFleet(targets, ['agents', 'upgrade', '--yes'], {
      self: 'zion',
      runner: (d) => { sshed.push(d.name); return { code: 0, stdout: '', stderr: '' }; },
      localRunner: (cmd) => { localRan.push(cmd); return { code: 0, stdout: '', stderr: '' }; },
    });
    // self went through the local runner, NOT ssh; the remote box still ssh'd.
    expect(sshed).toEqual(['worker']);
    expect(localRan).toEqual([['agents', 'upgrade', '--yes']]);
    expect(results.map((r) => [r.name, r.status])).toEqual([['zion', 'ok'], ['worker', 'ok']]);
  });

  it('a failing local self upgrade is reported as failed, not swallowed', () => {
    const targets: FleetTarget[] = [{ device: device({ name: 'zion' }) }];
    const results = runFleet(targets, ['agents', 'upgrade', '--yes'], {
      self: 'zion',
      localRunner: () => ({ code: 1, stdout: '', stderr: 'network down' }),
    });
    expect(results).toEqual([{ name: 'zion', status: 'failed', code: 1, detail: 'network down' }]);
  });
});

describe('fanOutDevices', () => {
  it('runs targets concurrently while preserving input order', async () => {
    const started: string[] = [];
    const results = await fanOutDevices(
      [{ name: 'slow' }, { name: 'fast' }],
      async (target) => {
        started.push(target.name);
        if (target.name === 'slow') await new Promise((resolve) => setTimeout(resolve, 20));
        return `${target.name}-ok`;
      },
    );

    expect(started).toEqual(['slow', 'fast']);
    expect(results.map((r) => [r.name, r.status, r.value])).toEqual([
      ['slow', 'ok', 'slow-ok'],
      ['fast', 'ok', 'fast-ok'],
    ]);
  });

  it('records skipped and failed devices without aborting the fan-out', async () => {
    const results = await fanOutDevices(
      [{ name: 'a' }, { name: 'b', skip: 'offline' }, { name: 'c' }],
      async (target) => {
        if (target.name === 'c') throw new Error('timed out');
        return target.name;
      },
    );

    expect(results).toEqual([
      { name: 'a', status: 'ok', value: 'a' },
      { name: 'b', status: 'skipped', reason: 'offline' },
      { name: 'c', status: 'failed', error: 'timed out' },
    ]);
  });
});

describe('upgradeCommand', () => {
  it('defaults to latest with --yes', () => {
    expect(upgradeCommand()).toEqual(['agents', 'upgrade', '--yes']);
    expect(upgradeCommand('1.20.62')).toEqual(['agents', 'upgrade', '1.20.62', '--yes']);
    expect(upgradeCommand('latest')).toEqual(['agents', 'upgrade', 'latest', '--yes']);
  });

  it('rejects shell metacharacters in the version pin', () => {
    expect(() => upgradeCommand('1.0.0; curl evil')).toThrow(/Invalid version/);
    expect(() => upgradeCommand('$(reboot)')).toThrow(/Invalid version/);
    expect(() => upgradeCommand('1.0.0 && true')).toThrow(/Invalid version/);
  });
});

describe('skipLabel', () => {
  it('labels each reason', () => {
    expect(skipLabel('offline')).toBe('offline');
    expect(skipLabel('no-address')).toBe('no address');
  });
});
