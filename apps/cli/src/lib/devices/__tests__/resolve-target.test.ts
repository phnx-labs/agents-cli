/**
 * A `--host`/`--device` token must resolve to the SAME ssh target the
 * auto-discovery sweep uses — through the device registry — so an explicit host
 * and the fleet sweep never dial two different routes for one box. These tests
 * pin that: a bare alias dials the device's registry address (not the literal
 * alias), while a raw `user@host` stays literal.
 */
import { describe, it, expect } from 'vitest';
import { resolveSshTarget } from '../resolve-target.js';
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

  it('keeps an explicit user@host literal (honours the chosen account)', () => {
    const r = resolveSshTarget('root@yosemite-s0', reg);
    expect(r?.target).toBe('root@yosemite-s0');
    expect(r?.machine).toBe('yosemite-s0');
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
