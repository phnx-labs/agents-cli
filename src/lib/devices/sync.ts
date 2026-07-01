/**
 * Reusable device discovery.
 *
 * `agents devices sync` was the only thing that ever populated the registry,
 * and it was purely user-invoked — so the registry sat empty until someone
 * remembered to run it. This module extracts the ingest so it can be triggered
 * automatically (from `agents sync` and `agents setup`) without duplicating the
 * tailscale-parse-and-upsert loop, and exposes the pure pending-device diff the
 * curation picker and the menu-bar probe both need.
 *
 * Two failure modes, one function:
 *   - hard (default): the CLI `agents devices sync` action wants a clear error
 *     and a non-zero exit when tailscale is missing.
 *   - soft (`soft: true`): auto-callers must never abort setup/sync because a
 *     machine has no tailscale — they get a result with `ok: false` instead.
 */
import {
  loadDevices,
  loadIgnored,
  upsertDevice,
} from './registry.js';
import {
  nodeToDeviceInput,
  parseTailscaleStatus,
  tailscaleStatusJson,
  type TailscaleNode,
} from './tailscale.js';

export interface DeviceSyncResult {
  /** False when discovery could not run (e.g. tailscale absent) in soft mode. */
  ok: boolean;
  /** Number of tailscale nodes upserted into the registry. */
  synced: number;
  /** Node names discovered but neither registered-before nor ignored. */
  pending: string[];
  /** Populated when ok is false: why discovery was skipped. */
  reason?: string;
}

/**
 * Node names present on the tailnet but neither already in the registry nor on
 * the ignore-list — i.e. genuinely new devices worth surfacing. Pure so the
 * flag matrix is unit-testable without a live tailnet.
 */
export function computePendingDevices(
  nodes: TailscaleNode[],
  registered: Iterable<string>,
  ignored: Iterable<string>,
): string[] {
  const known = new Set<string>(registered);
  const skip = new Set<string>(ignored);
  return nodes
    .map((n) => n.name)
    .filter((name) => !known.has(name) && !skip.has(name));
}

/**
 * Ingest `tailscale status --json` into the registry. In soft mode a missing
 * tailscale binary / unreachable daemon resolves to `{ ok: false }` instead of
 * throwing, so callers wiring this into setup/sync never abort the whole run.
 * The `pending` list is computed against the registry state BEFORE this sync so
 * "new" means "not previously registered and not ignored".
 */
export async function runDeviceSync(opts: { soft?: boolean } = {}): Promise<DeviceSyncResult> {
  // Soft mode must be non-fatal for ANY failure, not just a missing tailscale:
  // a corrupted registry/ignore file (both throw by design), a disk error, or
  // registry lock contention (plausible when many agents SessionStart-autosync
  // the same host at once) would otherwise abort the whole `agents sync`. The
  // whole body is inside the guard so the "never a sync failure" promise holds.
  try {
    const nodes = parseTailscaleStatus(tailscaleStatusJson());
    const [registeredBefore, ignored] = await Promise.all([loadDevices(), loadIgnored()]);
    const pending = computePendingDevices(nodes, Object.keys(registeredBefore), ignored);

    // Register/refresh every node the user has NOT dismissed. Skipping ignored
    // nodes is what makes the "register all" default safe: a phone or someone
    // else's laptop the user once dismissed never silently comes back.
    let synced = 0;
    for (const node of nodes) {
      if (ignored.has(node.name)) continue;
      await upsertDevice(node.name, nodeToDeviceInput(node));
      synced++;
    }

    return { ok: true, synced, pending };
  } catch (err: any) {
    if (opts.soft) {
      return { ok: false, synced: 0, pending: [], reason: err?.message ?? String(err) };
    }
    throw err;
  }
}

/**
 * The register/remove/ignore decision for the interactive curation picker.
 * Pure so the highest-risk reconcile logic is unit-testable without a tailnet
 * or a live prompt. `keep` is the set the user left checked; everything else is
 * dismissed. Checked => register (and un-ignore if it was ignored). Unchecked
 * => remove from the registry if it was there, and ignore it so auto-sync never
 * re-adds it.
 */
export interface DeviceReconciliation {
  toRegister: string[];
  toUnignore: string[];
  toRemove: string[];
  toIgnore: string[];
}

export function planDeviceReconciliation(
  allNames: Iterable<string>,
  keep: Iterable<string>,
  registered: Iterable<string>,
  ignored: Iterable<string>,
): DeviceReconciliation {
  const keepSet = new Set(keep);
  const regSet = new Set(registered);
  const ignSet = new Set(ignored);
  const out: DeviceReconciliation = { toRegister: [], toUnignore: [], toRemove: [], toIgnore: [] };
  for (const name of allNames) {
    if (keepSet.has(name)) {
      out.toRegister.push(name);
      if (ignSet.has(name)) out.toUnignore.push(name);
    } else {
      if (regSet.has(name)) out.toRemove.push(name);
      out.toIgnore.push(name);
    }
  }
  return out;
}
