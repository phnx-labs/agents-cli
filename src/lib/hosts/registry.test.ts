/**
 * resolveHost fall-through: the unified `--host` / `--device` resolution.
 *
 * The real bugs this guards against:
 *   1. A machine registered ONLY via `agents devices sync` must be reachable by
 *      `--host <name>` — the whole point of unifying devices and hosts. Before
 *      this, resolveHost consulted only the hosts registry and errored.
 *   2. The device's ssh target must be `user@dnsName` (dnsName preferred over ip).
 *   3. An ad-hoc `user@host` must resolve without any registration.
 *   4. A bare unknown name must return null (NOT be misread as an ad-hoc target)
 *      so capability-tag routing (`resolveHostByCap`, e.g. `--host gpu`) stays
 *      reachable.
 *   5. A password-auth device can't offload over BatchMode ssh — it must throw a
 *      typed, actionable error rather than dispatch a run that would hang.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Set HOME before state.ts loads so its module-level root picks up the override
// (both the devices registry and the hosts providers resolve paths from it).
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-host-resolve-test-'));
process.env.HOME = TEST_HOME;

const { resolveHost, DeviceOffloadUnsupportedError } = await import('./registry.js');
const { sshTargetFor } = await import('./types.js');
const { upsertDevice } = await import('../devices/registry.js');

function registryPath(): string {
  return path.join(TEST_HOME, '.agents', '.history', 'devices', 'registry.json');
}

beforeEach(async () => {
  fs.rmSync(registryPath(), { force: true });
  fs.rmSync(`${registryPath()}.lock`, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('resolveHost — devices fall-through', () => {
  it('resolves a key-auth device by name to a user@dnsName host', async () => {
    await upsertDevice('mac-mini', {
      platform: 'macos',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: 'mac-mini.tail1a85a1.ts.net', ip: '100.68.1.2' },
      auth: { method: 'key' },
    });

    const host = await resolveHost('mac-mini');
    expect(host).not.toBeNull();
    expect(host!.name).toBe('mac-mini');
    expect(sshTargetFor(host!)).toBe('muqsit@mac-mini.tail1a85a1.ts.net');
    // platform carries through so remote-os detection picks POSIX vs PowerShell.
    expect(host!.os).toBe('macos');
  });

  it('falls back to the raw ip when a device has no dnsName', async () => {
    await upsertDevice('box', {
      platform: 'linux',
      user: 'root',
      address: { via: 'manual', ip: '100.68.9.9' },
      auth: { method: 'key' },
    });

    const host = await resolveHost('box');
    expect(sshTargetFor(host!)).toBe('root@100.68.9.9');
  });
});

describe('resolveHost — ad-hoc and unknown', () => {
  it('resolves an ad-hoc user@host with nothing registered', async () => {
    const host = await resolveHost('deploy@1.2.3.4');
    expect(host).not.toBeNull();
    expect(host!.user).toBe('deploy');
    expect(host!.address).toBe('1.2.3.4');
    expect(sshTargetFor(host!)).toBe('deploy@1.2.3.4');
  });

  it('returns null for a bare unknown name so capability routing stays reachable', async () => {
    // 'gpu' is not a host, not a device, and has no `@` — must be null, letting
    // the caller fall through to resolveHostByCap('gpu').
    expect(await resolveHost('gpu')).toBeNull();
  });
});

describe('resolveHost — password-auth device', () => {
  it('throws a typed, actionable error instead of dispatching an unusable run', async () => {
    await upsertDevice('win-mini', {
      platform: 'windows',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: 'win-mini.tail1a85a1.ts.net' },
      auth: { method: 'password', bundle: 'muqsit', bundleKey: 'password' },
    });

    await expect(resolveHost('win-mini')).rejects.toBeInstanceOf(DeviceOffloadUnsupportedError);
    await expect(resolveHost('win-mini')).rejects.toThrow(/password auth/);
  });
});
