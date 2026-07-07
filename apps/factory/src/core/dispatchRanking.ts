// Consolidated Dispatch panel — pure ranking + mapping (no VS Code / no IO).
//
// Turns the data the extension host already has (agent inventories + the
// cross-host active-session list) into the three arrays the Dispatch panel
// consumes: InstalledAgent[], DispatchHost[], DispatchTarget[].
//
// The shapes here MIRROR the webview contract in
//   ui/settings/components/mission-control/dispatch.types.ts
// by hand: the src/ and ui/ TypeScript build roots are isolated (src tsconfig
// rootDir="src"), so a cross-root import is impossible — the same pattern the
// rest of this package uses (see remoteSessions.ts mirroring FloorPhase). If a
// contract field changes, update it in both places.

import { RemoteSession, HostInfo, HostLoad } from './remoteSessions';
import { AgentInventory } from './agentInventory';

// ---- mirrored contract types (dispatch.types.ts) ---------------------------

export type HostKind = 'local' | 'remote' | 'cloud';

export interface InstalledAgent {
  id: string;
  name: string;
  color: string;
  signedIn: boolean;
  version: string;
  isDefault: boolean;
}

export interface DispatchHost {
  id: string;
  label: string;
  kind: HostKind;
  online: boolean;
  agents: number;
  load: HostLoad;
  uses: number;
  costHint?: string;
}

export interface DispatchTarget {
  id: string;
  label: string;
  path?: string;
  uses: number;
}

// ---- installed agents ------------------------------------------------------

/** Brand display name + pill-dot color per agent id. Mirrors the prototype's
 *  AGENTS[] table (dispatch.html:191-198). Agents not listed fall back to their
 *  id + a neutral grey. */
const AGENT_META: Record<string, { name: string; color: string }> = {
  claude: { name: 'Claude', color: '#d97757' },
  codex: { name: 'Codex', color: '#cfcfcf' },
  gemini: { name: 'Gemini', color: '#4285f4' },
  kimi: { name: 'Kimi', color: '#7c5cff' },
  opencode: { name: 'OpenCode', color: '#f0b429' },
  cursor: { name: 'Cursor', color: '#6e6e6e' },
  antigravity: { name: 'Antigravity', color: '#5b8def' },
  grok: { name: 'Grok', color: '#9aa0a6' },
  droid: { name: 'Droid', color: '#22c55e' },
};

/**
 * Map `agents view --json` inventories to the panel's InstalledAgent[]. Only
 * agents with at least one installed version appear (an empty-version inventory
 * means "not installed"). `signedIn` gates whether the agent can actually run.
 * `defaultAgentId` marks the user's default agent (from globalState).
 */
export function mapInventoriesToInstalledAgents(
  inventories: Record<string, AgentInventory>,
  defaultAgentId: string,
): InstalledAgent[] {
  const out: InstalledAgent[] = [];
  for (const [id, inv] of Object.entries(inventories)) {
    if (!inv || !Array.isArray(inv.versions) || inv.versions.length === 0) continue;
    const meta = AGENT_META[id] ?? { name: id, color: '#9aa0a6' };
    out.push({
      id,
      name: meta.name,
      color: meta.color,
      signedIn: inv.signedInCount > 0,
      version: inv.defaultVersion ?? inv.versions[0].version,
      isDefault: id === defaultAgentId,
    });
  }
  return out;
}

// ---- host load -------------------------------------------------------------

/**
 * Derive the load bucket from the number of active agents on a host and its
 * normalized CPU load (1-min loadavg / core count). Offline hosts are 'off'
 * (handled by the caller). Thresholds mirror the prototype's states:
 *   idle  no agents and quiet CPU
 *   free  ~one agent / light CPU — safe to add work
 *   busy  several agents / loaded CPU — will feel it
 *   hot   CPU saturated (>= ~1.0 per core) — avoid piling on
 * `cpuRatio` is null when unknown (remote probe failed) — then load is derived
 * from agent count alone.
 */
export function deriveHostLoad(agents: number, cpuRatio: number | null): HostLoad {
  const ratio = cpuRatio == null ? -1 : cpuRatio;
  if (ratio >= 1.0 || agents >= 4) return 'hot';
  if (agents >= 2 || ratio >= 0.6) return 'busy';
  if (agents >= 1 || ratio >= 0.25) return 'free';
  return 'idle';
}

/**
 * Parse the CPU load ratio (1-min loadavg / core count) out of the combined
 * output of `uptime; getconf _NPROCESSORS_ONLN` run on a remote host. Handles
 * both Linux ("load average:") and macOS ("load averages:") uptime formats.
 * Returns null when either the load line or the core count is missing, so the
 * caller falls back to agent-count-only load derivation rather than a
 * half-normalized number.
 */
export function parseRemoteCpuRatio(output: string): number | null {
  const loadMatch = output.match(/load averages?:\s*([\d.]+)/i);
  if (!loadMatch) return null;
  const load = parseFloat(loadMatch[1]);
  if (!Number.isFinite(load)) return null;
  let cores = 0;
  for (const line of output.split(/\r?\n/)) {
    const t = line.trim();
    if (/^\d+$/.test(t)) cores = parseInt(t, 10); // last standalone integer wins
  }
  if (cores <= 0) return null;
  return load / cores;
}

/** Static cloud dispatch targets — always available, no live load. Mirrors the
 *  prototype's cloud HOSTS (dispatch.html:207-208). */
const CLOUD_HOSTS: DispatchHost[] = [
  { id: 'rush', label: 'Rush Cloud', kind: 'cloud', online: true, agents: 0, load: 'idle', uses: 0, costHint: '~$0.40/run' },
  { id: 'codex', label: 'Codex Cloud', kind: 'cloud', online: true, agents: 0, load: 'idle', uses: 0, costHint: '~$0.20/run' },
];

/**
 * Build the unified DispatchHost[] for the panel dropdown: this machine + every
 * reachable remote (from the widened HostInfo roster, which already carries live
 * agents/load/uses) followed by the static cloud targets. `localLabel` is the
 * canonical name for this machine (LOCAL_LABEL, e.g. 'this-mac').
 */
export function buildDispatchHosts(hosts: HostInfo[], localLabel: string): DispatchHost[] {
  const machines: DispatchHost[] = hosts.map((h) => ({
    id: h.name,
    label: h.name,
    kind: h.name === localLabel ? 'local' : 'remote',
    online: h.online,
    agents: h.agents ?? 0,
    load: h.load ?? (h.online ? 'idle' : 'off'),
    uses: h.uses ?? 0,
  }));
  // Local first, then remotes by descending usage, then cloud.
  machines.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'local' ? -1 : 1;
    return b.uses - a.uses;
  });
  return [...machines, ...CLOUD_HOSTS];
}

// ---- project targets -------------------------------------------------------

/** A cwd that lives inside a worktree checkout — folded to the repo for display
 *  but a poor choice for the canonical project path. */
function isWorktreeCwd(cwd: string): boolean {
  return cwd.includes('/.agents/worktrees/');
}

/**
 * Rank local projects by how often they appear across the active-session list
 * (the session index we already have in hand). Each distinct `project` becomes a
 * DispatchTarget; `uses` is its occurrence count; `path` is a representative cwd
 * (preferring a non-worktree checkout so local dispatch lands in the repo root,
 * not a throwaway worktree). Sessions with no project/cwd are skipped. Sorted by
 * descending usage, ties broken alphabetically for stable output.
 */
export function rankTargets(sessions: RemoteSession[]): DispatchTarget[] {
  const byProject = new Map<string, { uses: number; path: string }>();
  for (const s of sessions) {
    const project = s.project;
    const cwd = s.cwd;
    if (!project || !cwd) continue;
    const existing = byProject.get(project);
    if (!existing) {
      byProject.set(project, { uses: 1, path: cwd });
      continue;
    }
    existing.uses += 1;
    // Prefer a non-worktree cwd as the canonical path once we have a choice.
    if (isWorktreeCwd(existing.path) && !isWorktreeCwd(cwd)) existing.path = cwd;
  }
  const targets: DispatchTarget[] = [];
  for (const [project, { uses, path }] of byProject) {
    targets.push({ id: project, label: project, path, uses });
  }
  targets.sort((a, b) => (b.uses - a.uses) || a.label.localeCompare(b.label));
  return targets;
}

/**
 * Count active sessions per host — the usage weight the host roster carries as
 * `uses`. Keyed by the host name each session was queried under.
 */
export function rankHostUses(sessions: RemoteSession[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of sessions) {
    if (!s.host) continue;
    counts[s.host] = (counts[s.host] ?? 0) + 1;
  }
  return counts;
}
