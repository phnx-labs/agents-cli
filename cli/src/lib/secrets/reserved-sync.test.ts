import { describe, it, expect } from 'vitest';
import { planAuthBundlePush, syncReservedAuthBundle, type AuthSyncDevice } from './reserved-sync.js';
import type { DeviceProfile } from '../devices/registry.js';

function device(over: Partial<AuthSyncDevice> & { name: string }): AuthSyncDevice {
  return {
    reachable: true,
    pinned: true,
    remoteHasAuth: false,
    ...over,
  };
}

describe('planAuthBundlePush', () => {
  it('skips every device when local auth is missing or not file-backed', () => {
    const plan = planAuthBundlePush(false, [device({ name: 'm1' })]);
    expect(plan).toEqual([{ action: 'skip', device: 'm1', reason: 'no local file-backed auth bundle' }]);
  });

  it('pushes to a pinned reachable box that lacks auth', () => {
    const plan = planAuthBundlePush(true, [device({ name: 'm1' })]);
    expect(plan).toEqual([{ action: 'push', device: 'm1' }]);
  });

  it('skips unreachable, unpinned, and already-present boxes', () => {
    const plan = planAuthBundlePush(true, [
      device({ name: 'down', reachable: false }),
      device({ name: 'new', pinned: false }),
      device({ name: 'has-it', remoteHasAuth: true }),
      device({ name: 'ready' }),
    ]);
    expect(plan.map((p) => p.action)).toEqual(['skip', 'skip', 'skip', 'push']);
    expect(plan[1]).toMatchObject({ device: 'new', reason: expect.stringContaining('host key not pinned') });
    expect(plan[2]).toMatchObject({ device: 'has-it', reason: 'already present' });
  });
});

describe('syncReservedAuthBundle', () => {
  const profile = (name: string): DeviceProfile => ({
    name,
    address: `${name}.example`,
    platform: 'linux',
    user: 'agent',
  } as DeviceProfile);

  it('pushes auth over the file backend and never asks the pusher for a passphrase', () => {
    const hosts: string[] = [];
    const result = syncReservedAuthBundle({
      inspectLocal: () => ({ exists: true, ok: true }),
      listDevices: () => [profile('m1'), profile('me')],
      localName: 'me',
      isPinned: () => true,
      remoteHasAuth: () => false,
      sshTarget: (d) => d.address ?? d.name,
      push: (bundle, host) => {
        expect(bundle).toBe('auth');
        hosts.push(host);
        return { ok: true, host, bundle, keyCount: 2, message: 'Imported 2 key(s).' };
      },
    });
    expect(hosts).toEqual(['m1.example']);
    expect(result.pushed).toEqual(['m1']);
    expect(result.errors).toEqual([]);
  });

  it('records a failed remote decrypt as an error, not success', () => {
    const result = syncReservedAuthBundle({
      inspectLocal: () => ({ exists: true, ok: true }),
      listDevices: () => [profile('m1')],
      localName: 'other',
      isPinned: () => true,
      remoteHasAuth: () => false,
      sshTarget: (d) => d.address ?? d.name,
      push: () => ({
        ok: false,
        host: 'm1.example',
        bundle: 'auth',
        keyCount: 2,
        message: 'remote could not decrypt',
      }),
    });
    expect(result.pushed).toEqual([]);
    expect(result.errors).toEqual([{ device: 'm1', message: 'remote could not decrypt' }]);
  });

  it('no-ops when local auth is absent', () => {
    const pushed: string[] = [];
    const result = syncReservedAuthBundle({
      inspectLocal: () => ({ exists: false, ok: true }),
      listDevices: () => [profile('m1')],
      localName: 'other',
      isPinned: () => true,
      push: (_b, host) => {
        pushed.push(host);
        return { ok: true, host, bundle: 'auth', keyCount: 0, message: 'ok' };
      },
    });
    expect(pushed).toEqual([]);
    expect(result.skipped[0]?.reason).toContain('no local file-backed auth bundle');
  });
});
