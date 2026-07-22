// Pure host-selection logic for the fleet-aware Launch Matrix (no VS Code deps).
//
// A Quick Launch slot (and the per-agent "(Auto Host)" commands) can target a
// pool of devices and let the launcher pick the least-busy one at fire time.
// `agents run` has no cross-host balancer of its own, so the extension resolves
// the target here and passes it as `--host <device>`. This mirrors the CLI
// teams scheduler's pickLeastLoaded (apps/cli/src/lib/teams/scheduler.ts).

export interface DeviceLoad {
  name: string;
  online: boolean;
  running: number; // running agent count on the device; higher = busier
}

// Pick the least-busy online device — fewest running agents, ties broken by
// input order (first declared wins), offline devices skipped. Returns null when
// no candidate is online, so the caller can fall back to the local machine.
export function pickLeastBusyDevice(candidates: DeviceLoad[]): string | null {
  const online = candidates.filter((c) => c.online);
  if (online.length === 0) return null;
  let best = online[0];
  for (const c of online) {
    if (c.running < best.running) best = c;
  }
  return best.name;
}

// Narrow a device fleet to the eligible candidate pool for a balanced launch:
// online devices, excluding the local machine, optionally restricted to an
// explicit pool. An explicit pool entry that is not in the fleet is dropped.
export function resolveBalancePool(
  fleet: DeviceLoad[],
  opts: { localName?: string; pool?: string[] } = {},
): DeviceLoad[] {
  const local = opts.localName ? normalize(opts.localName) : undefined;
  const allow = opts.pool && opts.pool.length > 0
    ? new Set(opts.pool.map(normalize))
    : undefined;
  return fleet.filter((d) => {
    if (local && normalize(d.name) === local) return false;
    if (allow && !allow.has(normalize(d.name))) return false;
    return true;
  });
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}
