/** Synced device approval/ignore policy and local registry reconciliation. */
import { readMeta, updateMeta } from '../state.js';
import {
  addIgnored,
  assertValidDeviceName,
  loadDevices,
  removeDevice,
  removeIgnored,
  upsertDevice,
} from './registry.js';
import { localLoginUser, withDefaultUser } from './sync.js';
import { nodeToDeviceInput, parseTailscaleStatus, tailscaleStatusJson } from './tailscale.js';

export type DeviceDiscoveryStatus = 'approved' | 'ignored';

export interface DeviceDiscoveryReconcileResult {
  approved: string[];
  ignored: string[];
  registered: string[];
  unresolved: string[];
}

/** Read one portable decision. Absence means pending. */
export function getDeviceDiscoveryStatus(name: string): DeviceDiscoveryStatus | undefined {
  assertValidDeviceName(name);
  return loadDeviceDiscoveryPolicies().get(name);
}

/** Persist one portable decision in the central fleet manifest. */
export function setDeviceDiscoveryStatus(name: string, status: DeviceDiscoveryStatus | undefined): void {
  assertValidDeviceName(name);
  updateMeta((meta) => {
    const discovery = { ...meta.fleet?.discovery };
    if (status) discovery[name] = status;
    else delete discovery[name];
    const fleet = {
      ...meta.fleet,
      devices: meta.fleet?.devices ?? {},
      // Keep an empty map as the synced tombstone: it distinguishes "policy is
      // authoritative and every device is pending" from an older config that
      // has never opted into portable discovery decisions.
      discovery,
    };
    return { ...meta, fleet };
  });
}

/** Load every explicit decision from the synced central fleet manifest. */
export function loadDeviceDiscoveryPolicies(): Map<string, DeviceDiscoveryStatus> {
  const policies = new Map<string, DeviceDiscoveryStatus>();
  for (const [name, status] of Object.entries(readMeta().fleet?.discovery ?? {})) {
    assertValidDeviceName(name);
    if (status !== 'approved' && status !== 'ignored') {
      throw new Error(`Device discovery policy for '${name}' must be approved or ignored.`);
    }
    policies.set(name, status);
  }
  return policies;
}

/**
 * Apply synced intent to this machine's local registry. Approval resolves live
 * Tailscale metadata; ignore never needs the network. Missing approved peers are
 * reported as unresolved rather than written with invented connection details.
 *
 * Only devices with an EXPLICIT entry in the synced policy are touched. A
 * device absent from the map is left alone, whether or not the map itself is
 * defined — the map is not treated as authoritative-by-omission, because not
 * every local registration path writes a policy entry (daemon/umbrella
 * auto-refresh, and any device registered before this feature shipped).
 * Wiping those on the next `agents repo pull user` would be
 * silent, fleet-wide data loss for a decision (e.g. "ignore this one iPad")
 * that never meant to touch them.
 */
export async function reconcileDeviceDiscoveryPolicies(): Promise<DeviceDiscoveryReconcileResult> {
  const configured = readMeta().fleet?.discovery;
  if (configured === undefined) {
    return { approved: [], ignored: [], registered: [], unresolved: [] };
  }
  const policies = loadDeviceDiscoveryPolicies();
  const approved = [...policies].filter(([, s]) => s === 'approved').map(([n]) => n).sort();
  const ignored = [...policies].filter(([, s]) => s === 'ignored').map(([n]) => n).sort();

  for (const name of ignored) {
    await removeDevice(name);
    await addIgnored(name);
  }
  for (const name of approved) await removeIgnored(name);

  const currentRegistry = await loadDevices();
  const missing = approved.filter((name) => !currentRegistry[name]);
  if (missing.length === 0) return { approved, ignored, registered: [], unresolved: [] };

  let json: string;
  try {
    json = tailscaleStatusJson();
  } catch {
    return { approved, ignored, registered: [], unresolved: missing };
  }
  return registerApprovedDevicesFromTailscale(json, approved, ignored, missing);
}

/** Complete reconciliation from real `tailscale status --json` output. */
export async function registerApprovedDevicesFromTailscale(
  json: string,
  approved: string[],
  ignored: string[],
  missing: string[],
): Promise<DeviceDiscoveryReconcileResult> {
  const nodes = parseTailscaleStatus(json);
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const registered: string[] = [];
  const unresolved: string[] = [];
  const user = localLoginUser();
  for (const name of missing) {
    const node = byName.get(name);
    if (!node) {
      unresolved.push(name);
      continue;
    }
    await upsertDevice(name, withDefaultUser(nodeToDeviceInput(node), undefined, user));
    registered.push(name);
  }
  return { approved, ignored, registered, unresolved };
}
