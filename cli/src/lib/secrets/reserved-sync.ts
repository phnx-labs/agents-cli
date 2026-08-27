/**
 * Fleet sync of the reserved file-backed `auth` bundle (PHNX-2371).
 *
 * Setup-tokens drift per box when sync is manual. This module plans + executes
 * a push of the local file-backed `auth` bundle to registered devices that do
 * not yet have it, always with `--remote-backend file` and never forwarding
 * AGENTS_SECRETS_PASSPHRASE. Each destination auto-provisions its own
 * machine-local key and the push read-back-verifies decryptability.
 *
 * Double-fire: each device's daemon only writes that device's own store (the
 * destination). Two boxes that both have `auth` skip each other (already
 * present). A box without `auth` is a pull target for a provisioned peer.
 *
 * The planner is pure so tests cover every skip/push branch with no SSH.
 */
import { AUTH_BUNDLE_NAME, inspectReservedAuthBundle } from './bundles.js';
import { pushBundleToHost, type PushBundleResult } from './push.js';
import { loadDevicesSync, type DeviceProfile } from '../devices/registry.js';
import { sshTargetFor } from '../devices/connect.js';
import { isHostPinned, managedKnownHostsPath } from '../devices/known-hosts.js';
import { machineId, normalizeHost } from '../session/sync/config.js';

export interface AuthSyncDevice {
  name: string;
  reachable: boolean;
  pinned: boolean;
  remoteHasAuth: boolean;
}

export type AuthSyncPlanItem =
  | { action: 'push'; device: string }
  | { action: 'skip'; device: string; reason: string };

export function planAuthBundlePush(
  localAuthOk: boolean,
  devices: AuthSyncDevice[],
): AuthSyncPlanItem[] {
  if (!localAuthOk) {
    return devices.map((d) => ({
      action: 'skip',
      device: d.name,
      reason: 'no local file-backed auth bundle',
    }));
  }
  return devices.map((d) => {
    if (!d.reachable) return { action: 'skip', device: d.name, reason: 'unreachable' };
    if (!d.pinned) {
      return {
        action: 'skip',
        device: d.name,
        reason: `host key not pinned; run \`agents ssh ${d.name}\` once`,
      };
    }
    if (d.remoteHasAuth) return { action: 'skip', device: d.name, reason: 'already present' };
    return { action: 'push', device: d.name };
  });
}

export interface AuthSyncResult {
  pushed: string[];
  skipped: Array<{ device: string; reason: string }>;
  errors: Array<{ device: string; message: string }>;
}

export interface AuthSyncDeps {
  inspectLocal?: () => { exists: boolean; ok: boolean };
  listDevices?: () => DeviceProfile[];
  localName?: string;
  isPinned?: (name: string) => boolean;
  remoteHasAuth?: (device: string) => boolean;
  push?: (bundle: string, host: string) => PushBundleResult;
  sshTarget?: (device: DeviceProfile) => string;
}

function defaultDevices(): DeviceProfile[] {
  return Object.values(loadDevicesSync());
}

/**
 * Push the local file-backed `auth` bundle to every pinned registered device
 * that does not already have it. No-op when the local bundle is missing or on
 * the wrong backend (doctor flags that separately).
 */
export function syncReservedAuthBundle(deps: AuthSyncDeps = {}): AuthSyncResult {
  const inspect = deps.inspectLocal ?? inspectReservedAuthBundle;
  const local = inspect();
  const localOk = local.exists && local.ok;
  const localName = normalizeHost(deps.localName ?? machineId());
  const devices = (deps.listDevices ?? defaultDevices)().filter(
    (d) => normalizeHost(d.name) !== localName,
  );
  const pinned = deps.isPinned ?? ((name: string) => isHostPinned(name, managedKnownHostsPath()));
  const hasAuth = deps.remoteHasAuth ?? (() => false);
  const plan = planAuthBundlePush(
    localOk,
    devices.map((d) => ({
      name: d.name,
      reachable: true,
      pinned: pinned(d.name),
      remoteHasAuth: hasAuth(d.name),
    })),
  );

  const pushed: string[] = [];
  const skipped: Array<{ device: string; reason: string }> = [];
  const errors: Array<{ device: string; message: string }> = [];
  const push = deps.push ?? ((bundle: string, host: string) => pushBundleToHost(bundle, host, {
    remoteBackend: 'file',
    operation: 'auth-sync',
  }));
  const targetOf = deps.sshTarget ?? sshTargetFor;

  for (const item of plan) {
    if (item.action === 'skip') {
      skipped.push({ device: item.device, reason: item.reason });
      continue;
    }
    const profile = devices.find((d) => d.name === item.device);
    if (!profile) {
      skipped.push({ device: item.device, reason: 'not in registry' });
      continue;
    }
    try {
      const host = targetOf(profile);
      const out = push(AUTH_BUNDLE_NAME, host);
      if (out.ok) pushed.push(item.device);
      else errors.push({ device: item.device, message: out.message });
    } catch (err) {
      errors.push({ device: item.device, message: (err as Error).message });
    }
  }
  return { pushed, skipped, errors };
}
