import { describe, it, expect } from 'vitest';
import {
  planAuthBundlePush,
  syncReservedAuthBundle,
  authPresenceFromProbe,
  type AuthSyncDevice,
} from './reserved-sync.js';
import { parseRemoteBundles } from '../fleet/apply.js';
import type { DeviceProfile } from '../devices/registry.js';
import type { DeviceProbe } from '../fleet/types.js';

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
      probe: () => ({ reachable: true, remoteHasAuth: false }),
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
      probe: () => ({ reachable: true, remoteHasAuth: false }),
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
      probe: () => {
        throw new Error('must not probe remotes when local auth is missing');
      },
      push: (_b, host) => {
        pushed.push(host);
        return { ok: true, host, bundle: 'auth', keyCount: 0, message: 'ok' };
      },
    });
    expect(pushed).toEqual([]);
    expect(result.skipped[0]?.reason).toContain('no local file-backed auth bundle');
  });

  it('does not re-push when the remote already has auth', () => {
    // Same presence probe fleet apply uses: parseRemoteBundles → own-property
    // check on `auth`. A device whose listing already includes the bundle is
    // skipped; only a listing that lacks it is pushed.
    const hosts: string[] = [];
    const probed: string[] = [];
    const result = syncReservedAuthBundle({
      inspectLocal: () => ({ exists: true, ok: true }),
      listDevices: () => [profile('has-it'), profile('needs-it')],
      localName: 'me',
      isPinned: () => true,
      probe: (d) => {
        probed.push(d.name);
        const listing = d.name === 'has-it'
          ? parseRemoteBundles('[{"name":"auth","updatedAt":"2026-08-01T00:00:00Z"}]')
          : parseRemoteBundles('[]');
        return authPresenceFromProbe({
          device: d.name,
          reachable: true,
          installedAgents: [],
          remoteBundles: listing,
        });
      },
      sshTarget: (d) => `${d.name}.example`,
      push: (_bundle, host) => {
        hosts.push(host);
        return { ok: true, host, bundle: 'auth', keyCount: 1, message: 'Imported 1 key(s).' };
      },
    });
    expect(probed).toEqual(['has-it', 'needs-it']);
    expect(hosts).toEqual(['needs-it.example']);
    expect(result.pushed).toEqual(['needs-it']);
    expect(result.skipped).toContainEqual({ device: 'has-it', reason: 'already present' });
    expect(result.errors).toEqual([]);
  });

  it('skips an unreachable pinned box without pushing', () => {
    const hosts: string[] = [];
    const result = syncReservedAuthBundle({
      inspectLocal: () => ({ exists: true, ok: true }),
      listDevices: () => [profile('down')],
      localName: 'me',
      isPinned: () => true,
      probe: () => ({ reachable: false, remoteHasAuth: false }),
      sshTarget: (d) => `${d.name}.example`,
      push: (_b, host) => {
        hosts.push(host);
        return { ok: true, host, bundle: 'auth', keyCount: 0, message: 'ok' };
      },
    });
    expect(hosts).toEqual([]);
    expect(result.pushed).toEqual([]);
    expect(result.skipped).toEqual([{ device: 'down', reason: 'unreachable' }]);
  });
});

function probeOf(over: Partial<DeviceProbe> & { device: string }): DeviceProbe {
  return { reachable: true, installedAgents: [], ...over };
}

describe('authPresenceFromProbe — reuses fleet apply remoteBundles', () => {
  it('treats a listing that includes auth as already present', () => {
    const listing = parseRemoteBundles('[{"name":"auth","updatedAt":"2026-08-01T00:00:00Z"}]');
    expect(authPresenceFromProbe(probeOf({ device: 'm1', remoteBundles: listing })))
      .toEqual({ reachable: true, remoteHasAuth: true });
  });

  it('treats a listing without auth as missing — so we push', () => {
    const listing = parseRemoteBundles('[{"name":"attio","updatedAt":"t"}]');
    expect(authPresenceFromProbe(probeOf({ device: 'm1', remoteBundles: listing })))
      .toEqual({ reachable: true, remoteHasAuth: false });
  });

  it('an empty listing is missing, including prototype names', () => {
    const empty = parseRemoteBundles('[]');
    expect(authPresenceFromProbe(probeOf({ device: 'm1', remoteBundles: empty })))
      .toEqual({ reachable: true, remoteHasAuth: false });
    expect(authPresenceFromProbe(probeOf({ device: 'm1', remoteBundles: {} })))
      .toEqual({ reachable: true, remoteHasAuth: false });
  });

  it('unknown listing (probe failed to fetch bundles) means push, never skip', () => {
    expect(authPresenceFromProbe(probeOf({ device: 'm1' })))
      .toEqual({ reachable: true, remoteHasAuth: false });
  });

  it('unreachable stays unreachable and is not treated as present', () => {
    expect(authPresenceFromProbe(probeOf({ device: 'm1', reachable: false })))
      .toEqual({ reachable: false, remoteHasAuth: false });
  });
});
