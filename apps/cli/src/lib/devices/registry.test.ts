/**
 * Round-trip, concurrency, and corruption guarantees for the device registry.
 *
 * registry.json is the source of truth for how to reach every host. The real
 * bugs this guards against:
 *   1. A profile written by upsertDevice() must survive a reload byte-for-byte.
 *   2. Concurrent upserts must all land (lock + atomic rename serializes the
 *      read-modify-write window) — a stomp would silently drop a host.
 *   3. A malformed file must throw, not silently return {} that the next write
 *      would clobber (the data-loss path).
 *   4. `shell` is always re-derived from `platform` so the two can never drift.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// Set HOME before state.ts loads so its module-level root picks up the
// override. Top-level statements run before the dynamic `await import` below.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-devices-registry-test-'));
process.env.HOME = TEST_HOME;

const { upsertDevice, loadDevices, getDevice, removeDevice } = await import('./registry.js');

function registryPath(): string {
  return path.join(TEST_HOME, '.agents', '.history', 'devices', 'registry.json');
}

beforeAll(async () => {
  await fsp.mkdir(path.dirname(registryPath()), { recursive: true });
});

beforeEach(async () => {
  await fsp.rm(registryPath(), { force: true });
  await fsp.rm(`${registryPath()}.lock`, { recursive: true, force: true });
});

afterAll(async () => {
  await fsp.rm(TEST_HOME, { recursive: true, force: true });
});

describe('device registry round-trip', () => {
  it('persists a profile and reads it back identically', async () => {
    const created = await upsertDevice('win-mini', {
      platform: 'windows',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: 'win-mini.tail1a85a1.ts.net', ip: '100.68.123.39' },
      auth: { method: 'password', bundle: 'muqsit', bundleKey: 'password' },
      tailscale: { online: true, direct: true, relay: 'sfo', lastSeen: '2026-06-30T00:00:00Z' },
    });

    // shell is derived, never supplied — windows must yield powershell.
    expect(created.shell).toBe('powershell');

    const back = await getDevice('win-mini');
    expect(back).toEqual(created);
    expect(back!.address.ip).toBe('100.68.123.39');
    expect(back!.auth).toEqual({ method: 'password', bundle: 'muqsit', bundleKey: 'password' });
  });

  it('merges fields on update and re-derives shell when platform flips', async () => {
    await upsertDevice('box', { platform: 'windows', user: 'admin' });
    const updated = await upsertDevice('box', { platform: 'linux' });
    expect(updated.platform).toBe('linux');
    expect(updated.shell).toBe('posix'); // must follow the new platform, not stay 'powershell'
    expect(updated.user).toBe('admin'); // untouched field preserved
  });

  it('removes a device and reports absence', async () => {
    await upsertDevice('temp', { platform: 'linux' });
    expect(await removeDevice('temp')).toBe(true);
    expect(await getDevice('temp')).toBeNull();
    expect(await removeDevice('temp')).toBe(false);
  });

  it('rejects a name that is not a valid ssh alias (would break ssh_config render)', async () => {
    await expect(upsertDevice("Bisma's MacBook Pro", { platform: 'macos' })).rejects.toThrow(/Invalid device name/);
    expect(await getDevice("Bisma's MacBook Pro")).toBeNull();
  });
});

describe('device registry concurrency', () => {
  it('serializes concurrent upserts so all land', async () => {
    const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
    const results = await Promise.allSettled(
      names.map((n) => upsertDevice(n, { platform: 'linux', user: n })),
    );
    for (const r of results) expect(r.status).toBe('fulfilled');
    const reg = await loadDevices();
    expect(Object.keys(reg).sort()).toEqual([...names].sort());
  });
});

describe('device registry corruption surfacing', () => {
  it('throws on an unparseable registry instead of returning {}', async () => {
    fs.writeFileSync(registryPath(), '{ not json');
    await expect(loadDevices()).rejects.toThrow(/Device registry corrupted/);
  });

  it('returns {} only when the file truly does not exist', async () => {
    expect(fs.existsSync(registryPath())).toBe(false);
    expect(await loadDevices()).toEqual({});
  });
});
