/**
 * A `--host`/`--device` token must resolve to the SAME ssh target the
 * auto-discovery sweep uses — through the device registry — so an explicit host
 * and the fleet sweep never dial two different routes for one box. These tests
 * pin that: a bare alias dials the device's registry address (not the literal
 * alias), while a raw `user@host` stays literal.
 */
import { describe, it, expect } from 'vitest';
import { resolveSshTarget, resolveDeviceTarget } from '../resolve-target.js';
import type { DeviceRegistry, DeviceProfile } from '../registry.js';

function device(overrides: Partial<DeviceProfile>): DeviceProfile {
  return {
    name: 'yosemite-s0',
    platform: 'linux',
    shell: 'posix',
    user: 'muqsit',
    address: { via: 'tailscale', dnsName: 'yosemite-s0.tail1a85a1.ts.net' },
    auth: { method: 'key' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as DeviceProfile;
}

const reg: DeviceRegistry = { 'yosemite-s0': device({}) };

describe('resolveSshTarget', () => {
  it('resolves a bare alias to the registry address, not the literal alias', () => {
    const r = resolveSshTarget('yosemite-s0', reg);
    // The bug: without this, target would be the bare `yosemite-s0` (a different
    // route than the sweep's registry address, breaking socket reuse).
    expect(r).toEqual({
      target: 'muqsit@yosemite-s0.tail1a85a1.ts.net',
      machine: 'yosemite-s0',
      name: 'yosemite-s0',
      os: 'linux',
    });
  });

  it('matches case/domain-insensitively via normalizeHost', () => {
    expect(resolveSshTarget('YOSEMITE-S0.local', reg)?.target).toBe('muqsit@yosemite-s0.tail1a85a1.ts.net');
  });

  it('resolves user@device through the registry, overriding only the login user', () => {
    // The fix: a `user@device` is the same box as `device` — it must dial the
    // registry (Tailscale) route, NOT a bare `ssh root@yosemite-s0` (LAN DNS).
    const r = resolveSshTarget('root@yosemite-s0', reg);
    expect(r?.target).toBe('root@yosemite-s0.tail1a85a1.ts.net');
    expect(r?.machine).toBe('yosemite-s0');
  });

  it('keeps a user@host literal when the host matches no device', () => {
    const r = resolveSshTarget('root@some-box', {});
    expect(r?.target).toBe('root@some-box');
    expect(r?.machine).toBe('some-box');
  });

  it('falls back to a literal target for an unregistered host', () => {
    const r = resolveSshTarget('some-box', {});
    expect(r?.target).toBe('some-box');
    expect(r?.machine).toBe('some-box');
  });

  it('falls back to the literal token when the matched device has no address', () => {
    const addressless: DeviceRegistry = { 'no-addr': device({ name: 'no-addr', address: { via: 'manual' } }) };
    const r = resolveSshTarget('no-addr', addressless);
    // sshTargetFor throws with no dnsName/ip — resolver degrades to the literal.
    expect(r?.target).toBe('no-addr');
    expect(r?.machine).toBe('no-addr');
  });

  it('returns undefined for a token that fails the ssh-target injection guard', () => {
    expect(resolveSshTarget('bad;rm -rf', reg)).toBeUndefined();
  });
});

describe('resolveDeviceTarget', () => {
  it('returns the full profile for a bare device name', () => {
    const r = resolveDeviceTarget('yosemite-s0', reg);
    expect(r?.name).toBe('yosemite-s0');
    expect(r?.user).toBe('muqsit');
    expect(r?.address.dnsName).toBe('yosemite-s0.tail1a85a1.ts.net');
  });

  it('overrides only the login user for user@device (same profile + Tailscale route)', () => {
    const r = resolveDeviceTarget('root@yosemite-s0', reg);
    expect(r?.name).toBe('yosemite-s0');
    expect(r?.user).toBe('root'); // overridden
    expect(r?.address.dnsName).toBe('yosemite-s0.tail1a85a1.ts.net'); // still the registry address
    expect(r?.auth.method).toBe('key');
  });

  it('synthesizes an ad-hoc profile for a user@host literal (unregistered)', () => {
    const r = resolveDeviceTarget('ubuntu@203.0.113.9', {});
    expect(r?.user).toBe('ubuntu');
    expect(r?.address.ip).toBe('203.0.113.9');
    expect(r?.address.dnsName).toBeUndefined();
    expect(r?.auth.method).toBe('key');
  });

  it('synthesizes an ad-hoc profile for a dotted hostname literal', () => {
    const r = resolveDeviceTarget('box.example.com', {});
    expect(r?.address.dnsName).toBe('box.example.com');
    expect(r?.user).toBeUndefined();
  });

  it('returns undefined for a bare unregistered alias (so the caller says "Unknown device")', () => {
    // A bare word with no @/dot is a typo, not an ad-hoc host — must NOT be dialed
    // as a literal `foo`, preserving the strict "Unknown device" behaviour.
    expect(resolveDeviceTarget('not-a-device', reg)).toBeUndefined();
  });

  it('returns undefined for an injection-unsafe token', () => {
    expect(resolveDeviceTarget('bad;rm -rf', reg)).toBeUndefined();
  });
});
