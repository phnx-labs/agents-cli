/**
 * Fleet sync of the identity-keyed Claude usage snapshot (PHNX-3392 follow-up).
 *
 * A rate limit is metered per ACCOUNT, so an account's 5h/weekly usage is the
 * same number on every box. But only a HEADED device (`personal`/`desktop`) can
 * read it: the interactive OAuth login it holds carries the `user:profile` scope
 * `/api/oauth/usage` requires, and its interactive Claude runs feed the native
 * windows through the status-line writer. A headless `worker` has only the
 * `user:inference` setup-token, which the usage endpoint 403s (RUSH-2392), so its
 * local `claude-usage.json` stays blank and `agents view` shows no S:/W: bars.
 *
 * This closes that gap the same way {@link ../secrets/reserved-sync.ts} closes
 * the auth-token gap: each headed daemon PUSHES its identity-keyed usage rows to
 * the worker peers that cannot read them, which merge NEWEST-WINS
 * ({@link ingestPeerClaudeUsageRows}). Publish direction is role-driven —
 * personal/desktop publish, worker/unmarked consume — so it composes with the
 * device-role taxonomy rather than adding a second notion of "which box is real".
 *
 * Double-fire safety: each daemon only writes the DESTINATION's own cache, and
 * the merge is idempotent + timestamp-guarded, so two headed publishers pushing
 * the same account to one worker converge on the freshest snapshot regardless of
 * order. The input a publisher reads is its OWN cache (device-local state), so an
 * unrestricted per-device fire is correct — no shared queue.
 *
 * The planner is pure so tests cover every skip/push branch with no SSH.
 */
import { sshExec } from '../ssh-exec.js';
import { buildRemoteAgentsInvocation } from '../hosts/remote-cmd.js';
import { resolveRemoteOsSync } from '../hosts/remote-os.js';
import { loadDevicesSync, type DeviceProfile } from '../devices/registry.js';
import { sshTargetFor } from '../devices/connect.js';
import { isHostPinned } from '../devices/known-hosts.js';
import { machineId, normalizeHost } from '../session/sync/config.js';
import {
  isHeadedDeviceRole,
  listConfiguredDeviceRoles,
  selfConfiguredDeviceRole,
  type ConfiguredDeviceRole,
} from '../device-config.js';
import { exportClaudeUsageCacheRows, type CachedUsageSnapshot } from './usage.js';

/** How long a single peer push may take before it is abandoned for this tick. */
export const USAGE_PUSH_DEADLINE_MS = 20_000;

/** The stdin envelope the `__usage-ingest` verb reads. `v` guards the shape. */
export interface UsageSyncPayload {
  v: 1;
  rows: Record<string, CachedUsageSnapshot>;
}

/** One peer the local publisher is considering, reduced to the plan inputs. */
export interface UsagePushTarget {
  name: string;
  /** The peer's configured role — headed peers are skipped (own reader). */
  role: ConfiguredDeviceRole | undefined;
  /** Live-ish reachability from the tailscale snapshot; offline peers are skipped. */
  online: boolean;
  /** Managed known-hosts pin — an unpinned host is skipped, never TOFU-accepted. */
  pinned: boolean;
}

export type UsageSyncPlanItem =
  | { action: 'push'; device: string }
  | { action: 'skip'; device: string; reason: string };

/**
 * Decide, per peer, whether to push the local usage snapshot. Pure.
 *
 * - `selfIsPublisher` is false on a `worker`/unmarked box: it has no authoritative
 *   usage to publish, so every peer is skipped.
 * - `hasLocalRows` false means the local cache is empty (nothing to teach yet).
 * - A HEADED peer is skipped — it reads its own usage; pushing risks nothing
 *   (the merge is newest-wins) but is wasted work, and keeping the fan-out to
 *   consumers only makes the intent legible.
 */
export function planUsagePush(
  selfIsPublisher: boolean,
  hasLocalRows: boolean,
  targets: UsagePushTarget[],
): UsageSyncPlanItem[] {
  if (!selfIsPublisher) {
    return targets.map((d) => ({
      action: 'skip',
      device: d.name,
      reason: 'this device is not a usage publisher (mark it personal or desktop)',
    }));
  }
  if (!hasLocalRows) {
    return targets.map((d) => ({ action: 'skip', device: d.name, reason: 'no local usage snapshot to publish' }));
  }
  return targets.map((d) => {
    if (isHeadedDeviceRole(d.role)) return { action: 'skip', device: d.name, reason: 'headed peer reads its own usage' };
    if (!d.online) return { action: 'skip', device: d.name, reason: 'offline' };
    if (!d.pinned) {
      return { action: 'skip', device: d.name, reason: `host key not pinned; run \`agents ssh ${d.name}\` once` };
    }
    return { action: 'push', device: d.name };
  });
}

export interface UsageSyncResult {
  pushed: string[];
  skipped: Array<{ device: string; reason: string }>;
  errors: Array<{ device: string; message: string }>;
}

export interface UsageSyncDeps {
  selfRole?: () => ConfiguredDeviceRole | undefined;
  listDevices?: () => DeviceProfile[];
  /** Configured roles by device name; default reads the fleet config. */
  listRoles?: () => Record<string, ConfiguredDeviceRole>;
  localName?: () => string;
  isPinned?: (name: string) => boolean;
  exportRows?: () => Record<string, CachedUsageSnapshot>;
  /** Deliver the serialized payload to one peer. Default: ssh `__usage-ingest`. */
  push?: (device: DeviceProfile, payload: string) => { ok: boolean; message?: string };
}

/** Production push: pipe the payload to the peer's `agents __usage-ingest` over ssh. */
function defaultUsagePush(device: DeviceProfile, payload: string): { ok: boolean; message?: string } {
  const target = sshTargetFor(device);
  const os = resolveRemoteOsSync(device.name);
  const remoteCmd = buildRemoteAgentsInvocation(['__usage-ingest'], undefined, os);
  const res = sshExec(target, remoteCmd, { input: payload, timeoutMs: USAGE_PUSH_DEADLINE_MS });
  if (res.timedOut) return { ok: false, message: 'timed out' };
  if (res.code !== 0) return { ok: false, message: res.stderr.trim() || `remote exit ${res.code}` };
  return { ok: true };
}

/**
 * Push the local identity-keyed usage snapshot to every reachable, pinned,
 * non-headed peer. A no-op on a non-headed box or when the local cache is empty.
 */
export function syncFleetUsageSnapshots(deps: UsageSyncDeps = {}): UsageSyncResult {
  const result: UsageSyncResult = { pushed: [], skipped: [], errors: [] };

  const selfRole = (deps.selfRole ?? selfConfiguredDeviceRole)();
  const devices = deps.listDevices?.() ?? Object.values(loadDevicesSync());
  const self = deps.localName?.() ?? machineId();
  const selfNorm = normalizeHost(self);
  const roles = deps.listRoles?.() ?? (deps.listDevices ? listConfiguredDeviceRoles(devices.map((d) => d.name)) : listConfiguredDeviceRoles());
  const isPinned = deps.isPinned ?? isHostPinned;

  const byName = new Map(devices.map((d) => [d.name, d]));
  const targets: UsagePushTarget[] = devices
    .filter((d) => normalizeHost(d.name) !== selfNorm)
    .map((d) => ({
      name: d.name,
      role: roles[d.name],
      online: d.tailscale?.online !== false,
      pinned: isPinned(d.name),
    }));

  const rows = (deps.exportRows ?? exportClaudeUsageCacheRows)();
  const plan = planUsagePush(isHeadedDeviceRole(selfRole), Object.keys(rows).length > 0, targets);

  const payload = JSON.stringify({ v: 1, rows } satisfies UsageSyncPayload);
  const push = deps.push ?? defaultUsagePush;

  for (const item of plan) {
    if (item.action === 'skip') {
      result.skipped.push({ device: item.device, reason: item.reason });
      continue;
    }
    const device = byName.get(item.device);
    if (!device) {
      result.errors.push({ device: item.device, message: 'device left the registry mid-sync' });
      continue;
    }
    const outcome = push(device, payload);
    if (outcome.ok) result.pushed.push(item.device);
    else result.errors.push({ device: item.device, message: outcome.message ?? 'push failed' });
  }

  return result;
}
