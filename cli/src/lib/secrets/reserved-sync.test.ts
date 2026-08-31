import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { updateFleetSharedDeviceState } from '../fleet-shared-state.js';
import type { DeviceProfile } from '../devices/registry.js';
import { planAuthBundlePush, syncReservedAuthBundle, type AuthSyncDevice } from './reserved-sync.js';

const dirs: string[] = [];
function tempStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-auth-store-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function target(name: string, remoteAuth: AuthSyncDevice['remoteAuth']): AuthSyncDevice {
  return { name, reachable: true, pinned: true, remoteAuth };
}

function profile(name: string, online = true): DeviceProfile {
  return {
    name,
    platform: 'linux',
    shell: 'posix',
    address: { via: 'manual', dnsName: `${name}.example` },
    auth: { method: 'key' },
    tailscale: { online, direct: true },
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
  };
}

describe('planAuthBundlePush', () => {
  it('pushes only a known-missing, reachable, pinned peer from the elected source', () => {
    const plan = planAuthBundlePush(true, true, [
      target('missing', 'missing'),
      target('ready', 'ready'),
      target('invalid', 'invalid'),
      target('unknown', 'unknown'),
      { ...target('offline', 'missing'), reachable: false },
      { ...target('unpinned', 'missing'), pinned: false },
    ]);
    expect(plan).toEqual([
      { action: 'push', device: 'missing' },
      { action: 'skip', device: 'ready', reason: 'already present' },
      { action: 'skip', device: 'invalid', reason: 'remote auth bundle uses the wrong backend' },
      { action: 'skip', device: 'unknown', reason: 'no shared auth verdict has arrived from this peer' },
      { action: 'skip', device: 'offline', reason: 'unreachable' },
      { action: 'skip', device: 'unpinned', reason: expect.stringContaining('host key not pinned') },
    ]);
  });

  it('lets only the deterministic elected ready device push', () => {
    expect(planAuthBundlePush(true, false, [target('worker', 'missing')]))
      .toEqual([{ action: 'skip', device: 'worker', reason: 'another ready device is the elected auth publisher' }]);
    expect(planAuthBundlePush(false, false, [target('worker', 'missing')]))
      .toEqual([{ action: 'skip', device: 'worker', reason: 'no local file-backed auth bundle' }]);
  });
});

describe('auth sync through real fleet-shared files', () => {
  it('publishes readiness and does not probe or push a peer with an unknown verdict', async () => {
    const root = tempStore();
    const result = await syncReservedAuthBundle({
      userAgentsDir: root,
      localName: 'source',
      inspectLocal: () => ({ exists: true, ok: true }),
      listDevices: () => [profile('worker')],
      isPinned: () => true,
    });
    expect(result).toMatchObject({ publisher: 'source', stateChanged: true, pushed: [], errors: [] });
    expect(result.skipped).toEqual([{ device: 'worker', reason: expect.stringContaining('no shared auth verdict') }]);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'devices', 'source', 'daemon-state.json'), 'utf-8')))
      .toMatchObject({ version: 1, device: 'source', auth: { status: 'ready' } });
  });

  it('elects the same ready publisher from shared state and skips on non-owner devices', async () => {
    const root = tempStore();
    updateFleetSharedDeviceState('alpha', { auth: { status: 'ready' } }, root);
    updateFleetSharedDeviceState('worker', { auth: { status: 'missing' } }, root);
    const result = await syncReservedAuthBundle({
      userAgentsDir: root,
      localName: 'zulu',
      inspectLocal: () => ({ exists: true, ok: true }),
      listDevices: () => [profile('alpha'), profile('worker')],
      isPinned: () => true,
    });
    expect(result.publisher).toBe('alpha');
    expect(result.pushed).toEqual([]);
    expect(result.skipped.every((item) => item.reason.includes('elected auth publisher'))).toBe(true);
  });

  it('does not let a removed or known-offline stale ready file suppress the live source', async () => {
    for (const staleProfile of [undefined, profile('alpha', false)]) {
      const root = tempStore();
      updateFleetSharedDeviceState('alpha', { auth: { status: 'ready' } }, root);
      updateFleetSharedDeviceState('worker', { auth: { status: 'invalid' } }, root);
      const result = await syncReservedAuthBundle({
        userAgentsDir: root,
        localName: 'zulu',
        inspectLocal: () => ({ exists: true, ok: true }),
        listDevices: () => [...(staleProfile ? [staleProfile] : []), profile('worker')],
        isPinned: () => true,
      });
      expect(result.publisher).toBe('zulu');
      expect(result.skipped).toContainEqual({ device: 'worker', reason: 'remote auth bundle uses the wrong backend' });
    }
  });

  it('publishes missing/invalid verdicts without putting any credential material in the store', async () => {
    for (const [device, local, expected] of [
      ['missing-box', { exists: false, ok: true }, 'missing'],
      ['invalid-box', { exists: true, ok: false }, 'invalid'],
    ] as const) {
      const root = tempStore();
      await syncReservedAuthBundle({ userAgentsDir: root, localName: device, inspectLocal: () => local, listDevices: () => [] });
      const raw = fs.readFileSync(path.join(root, 'devices', device, 'daemon-state.json'), 'utf-8');
      expect(JSON.parse(raw)).toEqual({ version: 1, device, auth: { status: expected } });
      expect(raw).not.toMatch(/token|secret|credential/i);
    }
  });
});
