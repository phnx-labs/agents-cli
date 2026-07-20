import { describe, it, expect } from 'vitest';

import { fleetDialTarget } from './ssh.js';
import type { DeviceProfile } from '../lib/devices/registry.js';

function device(overrides: Partial<DeviceProfile>): DeviceProfile {
  return {
    name: 'yosemite-m1',
    platform: 'linux',
    shell: 'posix',
    user: 'muqsit',
    address: { via: 'tailscale', dnsName: 'yosemite-m1.tail1a85a1.ts.net' },
    auth: { method: 'key' },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('fleetDialTarget', () => {
  it('prefers the registry Tailscale dnsName over the bare name (drift-proof)', () => {
    // The whole point: dialing the bare "yosemite-m1" lets a stale ~/.ssh/config
    // block win; dialing the dnsName sidesteps it entirely.
    expect(fleetDialTarget(device({}))).toBe('muqsit@yosemite-m1.tail1a85a1.ts.net');
  });

  it('uses the IP when there is no dnsName', () => {
    expect(fleetDialTarget(device({ address: { via: 'manual', ip: '100.74.242.106' } })))
      .toBe('muqsit@100.74.242.106');
  });

  it('omits the user when the device has none', () => {
    expect(fleetDialTarget(device({ user: undefined }))).toBe('yosemite-m1.tail1a85a1.ts.net');
  });

  it('falls back to the bare name when the device has no address at all', () => {
    // A manually-added device with no dnsName/ip still dials by name, as before —
    // never worse than the old behaviour.
    expect(fleetDialTarget(device({ address: { via: 'manual' } }))).toBe('muqsit@yosemite-m1');
    expect(fleetDialTarget(device({ address: { via: 'manual' }, user: undefined }))).toBe('yosemite-m1');
  });
});
