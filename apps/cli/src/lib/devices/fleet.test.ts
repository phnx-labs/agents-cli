import { describe, it, expect } from 'vitest';
import {
  planFleetTargets,
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

describe('runFleet', () => {
  it('skips offline targets and reports per-device ok/failed', () => {
    const targets: FleetTarget[] = [
      { device: device({ name: 'a' }) },
      { device: device({ name: 'b' }), skip: 'offline' },
      { device: device({ name: 'c' }) },
    ];
    const results = runFleet(targets, ['agents', 'upgrade', '--yes'], (d) => {
      if (d.name === 'a') return { code: 0, stdout: 'ok', stderr: '' };
      return { code: 1, stdout: '', stderr: 'npm ERR' };
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
    const results = runFleet(targets, ['true'], (d) => {
      if (d.name === 'b') throw new Error('password auth but no secrets bundle');
      return { code: 0, stdout: '', stderr: '' };
    });
    expect(results.map((r) => r.status)).toEqual(['ok', 'failed', 'ok']);
    expect(results[1].detail).toMatch(/password auth/);
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
