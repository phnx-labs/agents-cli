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
  // Agent-health signal for the TARGET agent (RUSH-2025): true when the device
  // has at least one signed-in, non-throttled version. undefined means "not
  // probed" (agent-unaware caller) — such a device is treated as usable so the
  // legacy least-busy behavior is unchanged.
  usableVersion?: boolean;
  // Hardware-health signals from fetchDeviceStats(): 1-minute load average and
  // memory-used percent. undefined means "not probed" and contributes 0 to the
  // score.
  loadAvg1?: number;
  memPercent?: number;
}

// One installed version's login/usage health, matching the fields of the CLI's
// `agents view <agent> --json` output (ViewJsonVersion). Kept minimal so this
// module stays free of any CLI/VS Code dependency.
export interface VersionHealth {
  signedIn: boolean;
  usageStatus?: 'available' | 'rate_limited' | 'out_of_credits' | null;
}

// A device has a USABLE version of the target agent when at least one installed
// version is signed in AND not rate-limited / out of credits. A signed-out or
// throttled version drops the user into a login/limit wall (the RUSH-2025 bug),
// so it does not count.
export function deviceHasUsableVersion(versions: VersionHealth[]): boolean {
  return versions.some(
    (v) => v.signedIn && v.usageStatus !== 'rate_limited' && v.usageStatus !== 'out_of_credits',
  );
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

// Composite host score (lower is better) combining fleet-level and hardware-level
// load (RUSH-2025 acceptance: "rank candidates by running agents, agent
// login/usage health, and hardware load/memory"). Running-agent count dominates
// (each agent ≈ 10 points) so a device stays the primary balancer axis; load and
// memory pressure are tie-breakers that deprioritize a machine that is crashing
// or thrashing (the reported 20-30h local crashes). Unprobed hardware fields
// contribute 0, so an agent-unaware or stats-less caller degrades to pure
// least-busy ranking.
export function hostScore(d: DeviceLoad): number {
  const running = d.running * 10;
  const load = d.loadAvg1 !== undefined ? Math.min(d.loadAvg1, 16) : 0;
  const mem = d.memPercent !== undefined ? d.memPercent / 20 : 0; // 100% -> 5 pts
  return running + load + mem;
}

// Pick the best online host for a launch: drop devices with no usable version of
// the target agent (when that signal was probed), then rank the rest by the
// composite hostScore (running agents + hardware load/memory). Ties break by
// input order (first declared wins). Returns null when no candidate survives, so
// the caller falls back to the local machine with a warning.
export function pickBestHost(candidates: DeviceLoad[]): string | null {
  // usableVersion === false is an explicit "no signed-in version here" — filter
  // it out. undefined (unprobed) stays eligible so agent-unaware callers keep
  // the old behavior.
  const eligible = candidates.filter((c) => c.online && c.usableVersion !== false);
  if (eligible.length === 0) return null;
  let best = eligible[0];
  let bestScore = hostScore(best);
  for (const c of eligible) {
    const s = hostScore(c);
    if (s < bestScore) {
      best = c;
      bestScore = s;
    }
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
