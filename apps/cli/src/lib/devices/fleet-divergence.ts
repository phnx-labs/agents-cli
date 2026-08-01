/**
 * Cross-device harness divergence for `agents doctor` (RUSH-2027).
 *
 * `agents fleet status` already fans out `agents doctor --json` per device and
 * builds a {@link FleetHealthReport} of coarse device health (reachable, CLIs
 * installed, agents-cli version skew, local sync drift). It deliberately does
 * NOT compare fine-grained *resource presence* across devices — so a plugin like
 * `swarm` installed on one box but missing on another is silent until a user
 * types `/swarm:run` on the wrong machine and gets `Unknown command`.
 *
 * This module is the missing comparison. Each device self-reports its installed
 * inventory (resource kinds, per-agent version sets, `.agents`/`.system` repo
 * state) in its `doctor --json` payload; {@link compareFleetInventories} takes
 * the collected per-device inventories and, treating the local machine as the
 * baseline, flags:
 *
 *   1. Resource presence gaps  — a resource present on one device, missing on
 *      another (either direction relative to the local baseline).
 *   2. Agent version gaps      — an agent version installed on one device but
 *      not another (e.g. `yosemite-s0 missing claude@2.1.220`).
 *   3. `.agents`/`.system` repo drift — a device whose config-repo HEAD, branch,
 *      or dirty state diverges from the local baseline.
 *
 * Pure and SSH-free: the SSH fan-out lives in the doctor command; this module
 * only consumes the already-collected payloads, so the divergence logic is
 * unit-tested against fixture inventories with no live fleet.
 */

/** Resource kinds compared across devices. Mirrors {@link DoctorKind} plus the
 *  top-level `workflows`/`memory` inventory that `getAvailableResources` emits;
 *  `promptcuts` is a single present/absent bit surfaced as one named resource. */
export type FleetResourceKind =
  | 'commands'
  | 'skills'
  | 'hooks'
  | 'rules'
  | 'mcp'
  | 'permissions'
  | 'subagents'
  | 'plugins'
  | 'promptcuts'
  | 'workflows';

export const FLEET_RESOURCE_KINDS: FleetResourceKind[] = [
  'commands',
  'skills',
  'hooks',
  'rules',
  'mcp',
  'permissions',
  'subagents',
  'plugins',
  'promptcuts',
  'workflows',
];

/** Per-repo state for the `.agents` (user) or `.system` config repo, as a device
 *  self-reports it. `null` fields mean "not a git repo / unreadable" on that box. */
export interface RepoState {
  /** Current branch, or null when detached / unreadable. */
  branch: string | null;
  /** Short HEAD commit (8 chars), or null when unreadable. */
  head: string | null;
  /** True when the working tree has uncommitted changes. */
  dirty: boolean;
}

/**
 * The self-reported harness inventory a single device emits in `doctor --json`.
 * Comparable device-to-device with no further probing.
 */
export interface FleetInventory {
  /** Installed resource names per kind. `rules` here are the top-level rules
   *  files (memory presets), not per-agent compiled AGENTS.md. */
  resources: Record<FleetResourceKind, string[]>;
  /** Installed version ids per agent id (e.g. `{ claude: ['2.1.170','2.1.220'] }`). */
  agentVersions: Record<string, string[]>;
  /** State of the user (`~/.agents`) and system (`~/.agents/.system`) config repos. */
  repos: {
    agents: RepoState | null;
    system: RepoState | null;
  };
}

/** A device's inventory paired with its name (and reachability). A device that
 *  was unreachable / failed to report carries `inventory: null` and is skipped
 *  by the comparison (its absence is a `fleet status` concern, not divergence). */
export interface DeviceInventory {
  name: string;
  inventory: FleetInventory | null;
}

export type FleetDivergenceKind =
  | 'resource-missing-remote'
  | 'resource-missing-local'
  | 'agent-version-missing-remote'
  | 'agent-version-missing-local'
  | 'repo-drift';

/** One cross-device divergence finding, baseline = the local machine. */
export interface FleetDivergence {
  kind: FleetDivergenceKind;
  /** The device the finding is about (the remote box, or the local box for a
   *  `*-missing-local` finding where a remote has something local lacks). */
  device: string;
  /** Resource kind for a resource finding; agent id for a version finding;
   *  `agents`/`system` for a repo finding. */
  category: string;
  /** The specific resource name / version id / repo label that diverges. */
  name: string;
  /** Human-readable one-liner, ready for the warnings list. */
  message: string;
}

export interface FleetDivergenceReport {
  /** Name of the device used as the comparison baseline (the local machine). */
  baseline: string;
  divergences: FleetDivergence[];
  /** Devices that reported an inventory and were compared. */
  comparedDevices: string[];
  /** Devices that could not be compared (offline / no inventory in payload). */
  skippedDevices: string[];
  hasDivergence: boolean;
}

function sortedUnique(list: string[]): string[] {
  return Array.from(new Set(list)).sort();
}

function repoLabel(repo: 'agents' | 'system'): string {
  return repo === 'agents' ? '.agents' : '.system';
}

/** Describe how a remote repo state diverges from the local baseline, or null
 *  when they match. Compares HEAD first (the load-bearing difference), then
 *  branch, then a dirty tree on either side (naming which side is dirty). */
function describeRepoDrift(local: RepoState, remote: RepoState): string | null {
  if (local.head && remote.head && local.head !== remote.head) {
    return `HEAD ${remote.head} != local ${local.head}`;
  }
  if (local.branch !== remote.branch) {
    return `branch ${remote.branch ?? 'detached'} != local ${local.branch ?? 'detached'}`;
  }
  // Flag a dirty tree on EITHER side (symmetric with HEAD/branch above), and name
  // the side that has the uncommitted changes — the remote, or the local baseline.
  if (remote.dirty !== local.dirty) {
    return remote.dirty
      ? 'remote tree has uncommitted changes'
      : 'local tree has uncommitted changes';
  }
  return null;
}

/**
 * Compare a set of per-device inventories against the local baseline and emit
 * every cross-device divergence. The baseline is the device whose name equals
 * {@link baselineName} (the local machine); if that device has no inventory the
 * report is empty (nothing to compare against). Devices with no inventory are
 * recorded under `skippedDevices` and never produce false "missing" findings.
 *
 * Ordering is deterministic (device, then category, then name) so the human and
 * JSON output — and the tests — are stable.
 */
export function compareFleetInventories(
  devices: DeviceInventory[],
  baselineName: string,
): FleetDivergenceReport {
  const baseline = devices.find((d) => d.name === baselineName)?.inventory ?? null;
  const remotes = devices.filter((d) => d.name !== baselineName);
  const comparedDevices: string[] = [];
  const skippedDevices: string[] = [];
  const divergences: FleetDivergence[] = [];

  if (!baseline) {
    // No local baseline to compare against — record every remote as skipped so
    // the caller can say so, but emit no divergences (we can't know the truth).
    for (const d of remotes) skippedDevices.push(d.name);
    return {
      baseline: baselineName,
      divergences: [],
      comparedDevices: [],
      skippedDevices: skippedDevices.sort(),
      hasDivergence: false,
    };
  }

  for (const remote of remotes) {
    if (!remote.inventory) {
      skippedDevices.push(remote.name);
      continue;
    }
    comparedDevices.push(remote.name);
    const inv = remote.inventory;

    // 1) Resource presence, both directions.
    for (const kind of FLEET_RESOURCE_KINDS) {
      const localSet = new Set(baseline.resources[kind] ?? []);
      const remoteSet = new Set(inv.resources[kind] ?? []);
      for (const name of sortedUnique(baseline.resources[kind] ?? [])) {
        if (!remoteSet.has(name)) {
          divergences.push({
            kind: 'resource-missing-remote',
            device: remote.name,
            category: kind,
            name,
            message: `${remote.name} is missing ${kind.replace(/s$/, '')} '${name}' (present on ${baselineName})`,
          });
        }
      }
      for (const name of sortedUnique(inv.resources[kind] ?? [])) {
        if (!localSet.has(name)) {
          divergences.push({
            kind: 'resource-missing-local',
            device: remote.name,
            category: kind,
            name,
            message: `${baselineName} is missing ${kind.replace(/s$/, '')} '${name}' (present on ${remote.name})`,
          });
        }
      }
    }

    // 2) Agent version parity, both directions, per agent id.
    const agentIds = sortedUnique([
      ...Object.keys(baseline.agentVersions),
      ...Object.keys(inv.agentVersions),
    ]);
    for (const agent of agentIds) {
      const localVers = new Set(baseline.agentVersions[agent] ?? []);
      const remoteVers = new Set(inv.agentVersions[agent] ?? []);
      for (const v of sortedUnique(baseline.agentVersions[agent] ?? [])) {
        if (!remoteVers.has(v)) {
          divergences.push({
            kind: 'agent-version-missing-remote',
            device: remote.name,
            category: agent,
            name: v,
            message: `${remote.name} is missing ${agent}@${v} (installed on ${baselineName})`,
          });
        }
      }
      for (const v of sortedUnique(inv.agentVersions[agent] ?? [])) {
        if (!localVers.has(v)) {
          divergences.push({
            kind: 'agent-version-missing-local',
            device: remote.name,
            category: agent,
            name: v,
            message: `${baselineName} is missing ${agent}@${v} (installed on ${remote.name})`,
          });
        }
      }
    }

    // 3) `.agents` / `.system` repo drift vs the local baseline.
    for (const repo of ['agents', 'system'] as const) {
      const localRepo = baseline.repos[repo];
      const remoteRepo = inv.repos[repo];
      if (!localRepo || !remoteRepo) continue; // one side isn't a readable repo
      const drift = describeRepoDrift(localRepo, remoteRepo);
      if (drift) {
        divergences.push({
          kind: 'repo-drift',
          device: remote.name,
          category: repo,
          name: repoLabel(repo),
          message: `${remote.name} ${repoLabel(repo)} repo diverged: ${drift}`,
        });
      }
    }
  }

  divergences.sort(
    (a, b) =>
      a.device.localeCompare(b.device) ||
      a.kind.localeCompare(b.kind) ||
      a.category.localeCompare(b.category) ||
      a.name.localeCompare(b.name),
  );

  return {
    baseline: baselineName,
    divergences,
    comparedDevices: comparedDevices.sort(),
    skippedDevices: skippedDevices.sort(),
    hasDivergence: divergences.length > 0,
  };
}
