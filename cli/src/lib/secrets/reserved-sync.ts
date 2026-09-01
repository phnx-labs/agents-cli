/**
 * Fleet sync of the reserved file-backed `auth` bundle (PHNX-2371/PHNX-3609).
 *
 * Every daemon publishes only a safe auth readiness verdict into its owned
 * fleet-shared state file. A deterministic ready publisher reads those verdicts
 * and transfers the actual bundle only to a peer reporting `missing`. Secret
 * values never enter Git; the exceptional provisioning transfer remains SSH,
 * now async and kill-bounded instead of blocking the daemon event loop.
 */
import { AUTH_BUNDLE_NAME, inspectReservedAuthBundle } from './bundles.js';
import { pushBundleToHostAsync, type PushBundleResult } from './push.js';
import { isDialableDevice, loadDevicesSync, type DeviceProfile } from '../devices/registry.js';
import { sshTargetFor } from '../devices/connect.js';
import { isHostPinned, isDevicePinned, managedKnownHostsPath } from '../devices/known-hosts.js';
import { machineId, normalizeHost } from '../session/sync/config.js';
import {
  readFleetSharedDeviceStates,
  updateFleetSharedDeviceStateAsync,
  type SharedAuthStatus,
} from '../fleet-shared-state.js';
import { getUserAgentsDir } from '../state.js';

/** Each import/read-back SSH operation gets this deadline plus the SSH hard-kill grace. */
export const AUTH_SYNC_PUSH_DEADLINE_MS = 20_000;

export interface AuthSyncDevice {
  name: string;
  reachable: boolean;
  pinned: boolean;
  remoteAuth: SharedAuthStatus | 'unknown';
}

export type AuthSyncPlanItem =
  | { action: 'push'; device: string }
  | { action: 'skip'; device: string; reason: string };

export function planAuthBundlePush(
  localAuthOk: boolean,
  localIsPublisher: boolean,
  devices: AuthSyncDevice[],
): AuthSyncPlanItem[] {
  if (!localAuthOk) {
    return devices.map((device) => ({ action: 'skip', device: device.name, reason: 'no local file-backed auth bundle' }));
  }
  if (!localIsPublisher) {
    return devices.map((device) => ({ action: 'skip', device: device.name, reason: 'another ready device is the elected auth publisher' }));
  }
  return devices.map((device) => {
    if (!device.reachable) return { action: 'skip', device: device.name, reason: 'unreachable' };
    if (!device.pinned) {
      return { action: 'skip', device: device.name, reason: `host key not pinned; run \`agents ssh ${device.name}\` once` };
    }
    if (device.remoteAuth === 'ready') return { action: 'skip', device: device.name, reason: 'already present' };
    if (device.remoteAuth === 'invalid') return { action: 'skip', device: device.name, reason: 'remote auth bundle uses the wrong backend' };
    if (device.remoteAuth === 'unknown') {
      return { action: 'skip', device: device.name, reason: 'no shared auth verdict has arrived from this peer' };
    }
    return { action: 'push', device: device.name };
  });
}

export interface AuthSyncResult {
  publisher: string | null;
  stateChanged: boolean;
  pushed: string[];
  skipped: Array<{ device: string; reason: string }>;
  errors: Array<{ device: string; message: string }>;
}

export interface AuthSyncDeps {
  inspectLocal?: () => { exists: boolean; ok: boolean };
  listDevices?: () => DeviceProfile[];
  localName?: string;
  userAgentsDir?: string;
  isPinned?: (name: string) => boolean;
  push?: (bundle: string, host: string) => Promise<PushBundleResult>;
  sshTarget?: (device: DeviceProfile) => string;
}

export interface PublishAuthVerdictOptions {
  inspectLocal?: () => { exists: boolean; ok: boolean };
  localName?: string;
  userAgentsDir?: string;
}

export interface PublishAuthVerdictResult {
  device: string;
  status: SharedAuthStatus;
  changed: boolean;
  error: string | null;
}

function defaultDevices(): DeviceProfile[] {
  return Object.values(loadDevicesSync());
}

function authStatus(local: { exists: boolean; ok: boolean }): SharedAuthStatus {
  if (!local.exists) return 'missing';
  return local.ok ? 'ready' : 'invalid';
}

/** Publish only safe readiness metadata; useful immediately before a repo push. */
export async function publishReservedAuthVerdict(
  options: PublishAuthVerdictOptions = {},
): Promise<PublishAuthVerdictResult> {
  const local = (options.inspectLocal ?? inspectReservedAuthBundle)();
  const status = authStatus(local);
  const device = options.localName ?? machineId();
  try {
    const write = await updateFleetSharedDeviceStateAsync(
      device,
      { auth: { status } },
      options.userAgentsDir ?? getUserAgentsDir(),
    );
    return { device, status, changed: write.changed, error: null };
  } catch (err) {
    return { device, status, changed: false, error: (err as Error).message };
  }
}

/**
 * Publish local readiness, elect one ready source, then asynchronously provision
 * only peers whose shared verdict says the bundle is missing.
 */
export async function syncReservedAuthBundle(deps: AuthSyncDeps = {}): Promise<AuthSyncResult> {
  const result: AuthSyncResult = {
    publisher: null,
    stateChanged: false,
    pushed: [],
    skipped: [],
    errors: [],
  };
  const published = await publishReservedAuthVerdict(deps);
  const localStatus = published.status;
  const localName = published.device;
  const localNorm = normalizeHost(localName);
  const root = deps.userAgentsDir ?? getUserAgentsDir();
  const devices = (deps.listDevices ?? defaultDevices)().filter((device) => normalizeHost(device.name) !== localNorm);
  result.stateChanged = published.changed;
  if (published.error) result.errors.push({ device: localName, message: `could not publish auth verdict: ${published.error}` });

  const read = readFleetSharedDeviceStates(root);
  result.errors.push(...read.errors);
  const stateByDevice = new Map(read.states.map((state) => [normalizeHost(state.device), state]));
  const registered = new Map(devices.map((device) => [normalizeHost(device.name), device]));
  const readyPublishers = read.states
    .filter((state) => {
      if (state.auth?.status !== 'ready') return false;
      if (normalizeHost(state.device) === localNorm) return localStatus === 'ready';
      const device = registered.get(normalizeHost(state.device));
      // Removed and known-offline device files are stale observations, not live
      // executors. Letting one win election would suppress provisioning forever.
      return !!device && isDialableDevice(device);
    })
    .map((state) => state.device);
  if (localStatus === 'ready' && !readyPublishers.some((name) => normalizeHost(name) === localNorm)) {
    readyPublishers.push(localName);
  }
  readyPublishers.sort((a, b) => normalizeHost(a).localeCompare(normalizeHost(b)));
  result.publisher = readyPublishers[0] ?? null;
  const localIsPublisher = result.publisher !== null && normalizeHost(result.publisher) === localNorm;

  const pinned = deps.isPinned ?? ((name: string) => isHostPinned(name, managedKnownHostsPath()));
  const plan = planAuthBundlePush(
    localStatus === 'ready',
    localIsPublisher,
    devices.map((device) => ({
      name: device.name,
      reachable: isDialableDevice(device),
      pinned: isDevicePinned(device, pinned),
      remoteAuth: stateByDevice.get(normalizeHost(device.name))?.auth?.status ?? 'unknown',
    })),
  );
  const byName = new Map(devices.map((device) => [device.name, device]));
  const push = deps.push ?? ((bundle: string, host: string) => pushBundleToHostAsync(bundle, host, {
    remoteBackend: 'file',
    operation: 'auth-sync',
    agentOnly: true,
    timeoutMs: AUTH_SYNC_PUSH_DEADLINE_MS,
  }));
  const targetOf = deps.sshTarget ?? sshTargetFor;

  const outcomes = await Promise.all(plan.map(async (item) => {
    if (item.action === 'skip') return { kind: 'skip' as const, device: item.device, message: item.reason };
    const profile = byName.get(item.device);
    if (!profile) return { kind: 'skip' as const, device: item.device, message: 'not in registry' };
    try {
      const out = await push(AUTH_BUNDLE_NAME, targetOf(profile));
      return out.ok
        ? { kind: 'pushed' as const, device: item.device, message: out.message }
        : { kind: 'error' as const, device: item.device, message: out.message };
    } catch (err) {
      return { kind: 'error' as const, device: item.device, message: (err as Error).message };
    }
  }));
  for (const outcome of outcomes) {
    if (outcome.kind === 'pushed') result.pushed.push(outcome.device);
    else if (outcome.kind === 'skip') result.skipped.push({ device: outcome.device, reason: outcome.message });
    else result.errors.push({ device: outcome.device, message: outcome.message });
  }
  return result;
}
