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

// Redirect the device registry dir to a test-private temp so writes never touch
// the user's real ~/.agents/.history/devices (RUSH-2042). state.ts's
// getDevicesDir() reads AGENTS_DEVICES_DIR at call time, so this is immune to the
// module-cache race that made a plain HOME override leak (state.ts pins HOME at
// module load; a later HOME change is too late once any static import ran).
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-devices-registry-test-'));
process.env.AGENTS_DEVICES_DIR = path.join(TEST_HOME, 'devices');

const { upsertDevice, loadDevices, getDevice, removeDevice, deviceRole, isControlDevice, isDialableDevice } =
  await import('./registry.js');

function registryPath(): string {
  return path.join(TEST_HOME, 'devices', 'registry.json');
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

describe('device role (control vs worker)', () => {
  it('defaults to worker when unset — worker devices are dialable', async () => {
    const d = await upsertDevice('box-a', { platform: 'linux' });
    expect(d.role).toBeUndefined();
    expect(deviceRole(d)).toBe('worker');
    expect(isControlDevice(d)).toBe(false);
  });

  it('persists role=control and reads it back — control devices are skipped from dialing', async () => {
    await upsertDevice('iphone', { platform: 'unknown' });
    const marked = await upsertDevice('iphone', { role: 'control' });
    expect(marked.role).toBe('control');
    expect(isControlDevice(marked)).toBe(true);
    // Survives reload and preserves the untouched platform.
    const back = await getDevice('iphone');
    expect(back!.role).toBe('control');
    expect(back!.platform).toBe('unknown');
  });

  it('leaves role untouched when a later upsert does not mention it', async () => {
    await upsertDevice('ipad', { role: 'control' });
    const after = await upsertDevice('ipad', { user: 'muqsit' });
    expect(after.role).toBe('control'); // not clobbered by an unrelated update
    expect(after.user).toBe('muqsit');
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

/**
 * Which devices a cross-fleet sweep dials. Both directions below were live on a
 * real 17-device fleet and together made `agents sessions --resolve` unable to
 * ever answer: the manual box holding the transcript was skipped, while two
 * sleeping boxes were dialed and their timeouts read as doubt.
 */
describe('isDialableDevice', () => {
  it('dials a manually-registered device that the live probe reached', () => {
    // The real yosemite-s1: address.via 'manual', so it never gets a tailscale
    // peer entry and `tailscale.online` is permanently undefined. Gating on
    // `online === true` hid every session on that box from the fleet sweep.
    expect(isDialableDevice({
      name: 'yosemite-s1',
      platform: 'linux',
      address: { via: 'manual', dnsName: 'yosemite-s1.tail1a85a1.ts.net' },
      reachability: { reachable: true, via: 'manual', checkedAt: '2026-08-03T15:30:39.876Z' },
    } as any)).toBe(true);
  });

  it('a failed probe never removes a peer the snapshot still calls online', () => {
    // The probe runs on a short SSH budget and produces false negatives on a
    // congested tailnet — it was observed calling the LOCAL machine unreachable.
    // Excluding on it would hide sessions on healthy boxes, so a negative probe
    // must not override a snapshot that says online.
    expect(isDialableDevice({
      name: 'mac-mini',
      platform: 'macos',
      address: { via: 'tailscale', dnsName: 'mac-mini.tail1a85a1.ts.net' },
      tailscale: { online: true },
      reachability: { reachable: false, via: 'tailscale', checkedAt: '2026-08-03T15:39:43.427Z' },
    } as any)).toBe(true);
  });

  it('a positive probe rescues a device whose snapshot says offline', () => {
    expect(isDialableDevice({
      name: 'woken-box',
      platform: 'linux',
      address: { via: 'tailscale', dnsName: 'woken-box.tail1a85a1.ts.net' },
      tailscale: { online: false },
      reachability: { reachable: true, via: 'tailscale', checkedAt: '2026-08-03T15:39:43.427Z' },
    } as any)).toBe(true);
  });

  it('keeps dialing a manual device even after a probe says it is unreachable', () => {
    // The deliberate cost of "a probe may only ADD a peer": a manual device has
    // no tailscale block to say offline, so a confirmed-dead one stays in the
    // sweep until it is removed from the registry. Pinned so the tradeoff is a
    // decision on record, not an accident.
    expect(isDialableDevice({
      name: 'dead-manual',
      platform: 'linux',
      address: { via: 'manual', dnsName: 'dead-manual.ts.net' },
      reachability: { reachable: false, via: 'manual', checkedAt: '2026-08-03T15:39:43.504Z' },
    } as any)).toBe(true);
  });

  it('skips a box both signals call offline', () => {
    expect(isDialableDevice({
      name: 'gpu-box',
      platform: 'linux',
      address: { via: 'tailscale', dnsName: 'gpu-box.tail1a85a1.ts.net' },
      tailscale: { online: false },
      reachability: { reachable: false, via: 'tailscale', checkedAt: '2026-08-03T15:39:43.427Z' },
    } as any)).toBe(false);
  });

  it('falls back to the tailscale snapshot when no probe has run yet', () => {
    expect(isDialableDevice({
      name: 'never-probed',
      platform: 'linux',
      address: { via: 'tailscale', dnsName: 'never-probed.ts.net' },
      tailscale: { online: true },
    } as any)).toBe(true);
    expect(isDialableDevice({
      name: 'never-probed-offline',
      platform: 'linux',
      address: { via: 'tailscale', dnsName: 'never-probed-offline.ts.net' },
      tailscale: { online: false },
    } as any)).toBe(false);
  });

  it('treats a never-probed manual device as unknown-not-offline, so it is still dialed', () => {
    // Matches ssh.ts renderDeviceTable and the ext's isDeviceOnline: offline only
    // when a tailscale block SAYS offline. Without this, a manual device stays
    // invisible to the sweep until something happens to probe it — the same class
    // of bug as yosemite-s1 above, just before the first probe.
    expect(isDialableDevice({
      name: 'unknown-manual',
      platform: 'linux',
      address: { via: 'manual', dnsName: 'unknown-manual.ts.net' },
    } as any)).toBe(true);
  });
});
