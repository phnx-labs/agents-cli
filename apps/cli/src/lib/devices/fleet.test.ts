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
});

describe('upgradeCommand', () => {
  it('defaults to latest with --yes', () => {
    expect(upgradeCommand()).toEqual(['agents', 'upgrade', '--yes']);
    expect(upgradeCommand('1.20.62')).toEqual(['agents', 'upgrade', '1.20.62', '--yes']);
  });
});

describe('skipLabel', () => {
  it('labels each reason', () => {
    expect(skipLabel('offline')).toBe('offline');
    expect(skipLabel('no-address')).toBe('no address');
  });
});
