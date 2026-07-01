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
  let nodes: TailscaleNode[];
  try {
    nodes = parseTailscaleStatus(tailscaleStatusJson());
  } catch (err: any) {
    if (opts.soft) {
      return { ok: false, synced: 0, pending: [], reason: err?.message ?? String(err) };
    }
    throw err;
  }

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
}
