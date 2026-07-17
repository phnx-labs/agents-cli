/**
 * Devices host provider — the Tailscale fleet in the host pool.
 *
 * The real bugs this guards against:
 *   1. A device registered only via `agents devices sync` must appear in
 *      `listAllHosts()` (so `hosts list`, cap routing, and target pickers see
 *      it) — the gap this provider exists to close.
 *   2. A password-auth device must be LISTED (`dispatchable: false`) but never
 *      resolved for dispatch (typed error) and never picked by cap routing —
 *      a BatchMode=yes ssh run against it would hang forever.
 *   3. An enrolled host must shadow a same-name device (provider order), so
 *      enrolling a device to tag it doesn't create a duplicate row.
 *   4. The `Meta.hosts` overlay (caps) must merge onto device entries so a
 *      device participates in `--host <cap>` routing.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Set HOME before state.ts loads so its module-level root picks up the override.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-devices-provider-test-'));
process.env.HOME = TEST_HOME;

const { DevicesHostProvider } = await import('./devices.js');
const { listAllHosts, resolveHostByCap, resolveHost } = await import('../registry.js');
const { DeviceOffloadUnsupportedError } = await import('../types.js');
const { upsertDevice } = await import('../../devices/registry.js');
const { updateMeta } = await import('../../state.js');

function registryPath(): string {
  return path.join(TEST_HOME, '.agents', '.history', 'devices', 'registry.json');
}

beforeEach(async () => {
  fs.rmSync(registryPath(), { force: true });
  fs.rmSync(`${registryPath()}.lock`, { recursive: true, force: true });
  updateMeta((meta) => {
    const { hosts: _omit, ...rest } = meta;
    return rest;
  });
});

afterAll(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('DevicesHostProvider.list', () => {
  it('lists key-auth devices as dispatchable hosts with presence', async () => {
    await upsertDevice('gpu-box', {
      platform: 'linux',
      user: 'taylor',
      address: { via: 'tailscale', dnsName: 'gpu-box.tail1a85a1.ts.net', ip: '100.68.1.2' },
      auth: { method: 'key' },
      tailscale: { id: 'n1', hostName: 'gpu-box', online: true },
    });

    const provider = new DevicesHostProvider();
    const hosts = await provider.list();
    expect(hosts).toHaveLength(1);
    expect(hosts[0].name).toBe('gpu-box');
    expect(hosts[0].provider).toBe('devices');
    expect(hosts[0].address).toBe('gpu-box.tail1a85a1.ts.net');
    expect(hosts[0].status).toBe('online');
    expect(hosts[0].dispatchable).toBe(true);
  });

  it('lists password-auth devices marked non-dispatchable', async () => {
    await upsertDevice('win-mini', {
      platform: 'windows',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: 'win-mini.tail1a85a1.ts.net' },
      auth: { method: 'password', bundle: 'muqsit', bundleKey: 'password' },
    });

    const provider = new DevicesHostProvider();
    const hosts = await provider.list();
    expect(hosts).toHaveLength(1);
    expect(hosts[0].dispatchable).toBe(false);
  });

  it('skips address-less device profiles (nothing to dispatch to)', async () => {
    await upsertDevice('ghost', {
      platform: 'linux',
      address: { via: 'manual' },
      auth: { method: 'key' },
    });
    const provider = new DevicesHostProvider();
    expect(await provider.list()).toHaveLength(0);
  });
});

describe('devices in the unified pool', () => {
  it('listAllHosts includes devices; a same-name enrolled host shadows the device', async () => {
    await upsertDevice('shared-name', {
      platform: 'linux',
      user: 'device-user',
      address: { via: 'tailscale', dnsName: 'shared.tail.ts.net' },
      auth: { method: 'key' },
    });
    updateMeta((meta) => ({
      ...meta,
      hosts: { 'shared-name': { source: 'inline', address: '10.0.0.9', user: 'host-user', addedAt: new Date().toISOString() } },
    }));

    const all = await listAllHosts();
    const rows = all.filter((h) => h.name === 'shared-name');
    expect(rows).toHaveLength(1);
    // local registers before devices — the enrolled entry wins.
    expect(rows[0].provider).toBe('local');
    expect(rows[0].address).toBe('10.0.0.9');
  });

  it('cap routing reaches a device enrolled with a tag (the hosts-add-from-device path)', async () => {
    await upsertDevice('gpu-dev', {
      platform: 'linux',
      user: 'taylor',
      address: { via: 'tailscale', dnsName: 'gpu-dev.tail.ts.net' },
      auth: { method: 'key' },
    });
    // `agents hosts add gpu-dev --cap gpu` enrolls inline, sourcing the target
    // from the device profile — emulate the entry it writes.
    updateMeta((meta) => ({
      ...meta,
      hosts: {
        'gpu-dev': { source: 'inline', address: 'gpu-dev.tail.ts.net', user: 'taylor', caps: ['gpu'], addedAt: new Date().toISOString() },
      },
    }));

    const host = await resolveHostByCap('gpu');
    expect(host.name).toBe('gpu-dev');
    expect(host.address).toBe('gpu-dev.tail.ts.net');
  });

  it('resolveHost still throws the typed error for password-auth devices', async () => {
    await upsertDevice('win-mini', {
      platform: 'windows',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: 'win-mini.tail1a85a1.ts.net' },
      auth: { method: 'password', bundle: 'muqsit', bundleKey: 'password' },
    });
    const err = await resolveHost('win-mini').catch((e) => e as Error);
    expect(err).toBeInstanceOf(DeviceOffloadUnsupportedError);
    expect((err as Error).name).toBe('DeviceOffloadUnsupportedError');
  });
});

describe('DevicesHostProvider — control devices are never dispatch targets', () => {
  it('excludes a control device from the host pool even when online with a real platform', async () => {
    await upsertDevice('worker', {
      platform: 'linux',
      address: { via: 'tailscale', dnsName: 'worker.ts.net' },
      auth: { method: 'key' },
      tailscale: { id: 'w', hostName: 'worker', online: true },
    });
    await upsertDevice('my-iphone', {
      platform: 'linux', // a real platform — role must still exclude it
      role: 'control',
      address: { via: 'tailscale', dnsName: 'my-iphone.ts.net' },
      auth: { method: 'key' },
      tailscale: { id: 'p', hostName: 'my-iphone', online: true },
    });

    const hosts = await new DevicesHostProvider().list();
    expect(hosts.map((h) => h.name)).toEqual(['worker']); // phone absent from the pool
  });

  it('refuses to resolve a control device for dispatch with a clear error', async () => {
    await upsertDevice('my-ipad', {
      platform: 'unknown', // the platform a freshly-synced iPad reports
      role: 'control',
      address: { via: 'tailscale', dnsName: 'my-ipad.ts.net' },
      auth: { method: 'key' },
      tailscale: { id: 'i', hostName: 'my-ipad', online: true },
    });
    const err = await resolveHost('my-ipad').catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/control device/i);
  });
});
