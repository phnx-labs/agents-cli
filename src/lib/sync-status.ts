/**
 * Unified sync-status engine — the SINGLE source of truth for "is this resource
 * synced to this agent version?" consumed by `agents doctor`, `agents view`, the
 * menu-bar app, and any Agency surface.
 *
 * Why this exists: before this module there were four different notions of
 * "synced" living in four files:
 *   - doctor:  isStale() vs .sync-manifest.json  — catches SOURCE drift only.
 *   - view:    git working-tree state of ~/.agents/ — a resource can show green
 *              while its installed copy is stale/deleted/corrupted (false positive).
 *   - lists:   file-exists-in-home — never reports content drift at all.
 *   - menubar: read doctor --json (so it inherited doctor's source-only blind spot).
 *
 * The reliable signal is diffVersionResources() (src/lib/doctor-diff.ts): it reads
 * the ACTUAL version home and compares it to the resolved sources, so it catches
 * every drift class — source-side changes AND home-side rot (deleted / corrupted /
 * hand-edited installed copies) AND orphans. This module wraps it once, maps its
 * per-resource DiffStatus onto one stable enum, folds in `.system` repo freshness,
 * and lets every surface render the same warnings instead of re-deriving them.
 */

import simpleGit from 'simple-git';
import { AgentId } from './types.js';
import { ALL_AGENT_IDS } from './agents.js';
import {
  diffVersionResources,
  type VersionResourceReport,
  type ResourceDiff,
  type DoctorKind,
  type DiffStatus,
} from './doctor-diff.js';
import { listInstalledVersions, getGlobalDefault } from './versions.js';
import { loadManifest } from './staleness/index.js';
import { getSystemAgentsDir } from './state.js';
import { isGitRepo } from './git.js';

/**
 * One stable status per resource, unified across every surface.
 *  - `synced`  — installed copy matches the resolved source (DiffStatus 'ok').
 *  - `drifted` — installed copy exists but differs from source (DiffStatus 'diff').
 *  - `missing` — source exists, nothing installed in the version home ('missing').
 *  - `orphan`  — installed in the home with no source ('extra'); prune's job, not sync's.
 */
export type ResourceSyncStatus = 'synced' | 'drifted' | 'missing' | 'orphan';

export interface ResourceStatusRow {
  agent: AgentId;
  version: string;
  kind: DoctorKind;
  name: string;
  status: ResourceSyncStatus;
  /** Human-readable specifics for a drifted row (e.g. plugin version delta). */
  detail?: string;
}

export interface AgentVersionStatus {
  agent: AgentId;
  version: string;
  isDefault: boolean;
  /** False = no .sync-manifest.json: this version was never synced (cold). */
  everSynced: boolean;
  counts: { synced: number; drifted: number; missing: number; orphan: number };
  /** drifted + missing > 0 — a real reconcile is owed. Orphans do NOT set this
   * (heal never deletes; orphan removal is `agents prune cleanup`). */
  needsSync: boolean;
  resources: ResourceStatusRow[];
}

export interface SystemRepoStatus {
  dir: string;
  /** Commits the local `.system` checkout is behind its tracking branch, as of
   * the last background fetch (no network is performed here). 0 = up to date. */
  behind: number;
  ahead: number;
  branch: string | null;
  /** True when the dir isn't a git repo or has no upstream — behind is unknown. */
  unknown: boolean;
}

export interface UnifiedSyncStatus {
  system: SystemRepoStatus;
  agents: AgentVersionStatus[];
  totals: {
    drifted: number;
    missing: number;
    orphan: number;
    /** Versions with a manifest that are behind on content. */
    versionsNeedingSync: number;
    /** Versions that were never synced at all. */
    versionsNeverSynced: number;
    /** Distinct agent ids that own at least one version needing sync. */
    agentsNeedingSync: number;
  };
}

const STATUS_MAP: Record<DiffStatus, ResourceSyncStatus> = {
  ok: 'synced',
  diff: 'drifted',
  missing: 'missing',
  extra: 'orphan',
};

function rowsFromReport(
  agent: AgentId,
  version: string,
  report: VersionResourceReport,
): ResourceStatusRow[] {
  const out: ResourceStatusRow[] = [];
  for (const list of Object.values(report.kinds) as ResourceDiff[][]) {
    for (const r of list) {
      out.push({
        agent,
        version,
        kind: r.kind,
        name: r.name,
        status: STATUS_MAP[r.status],
        ...(r.detail ? { detail: r.detail } : {}),
      });
    }
  }
  return out;
}

export interface SyncStatusOptions {
  cwd?: string;
  /** Restrict to specific agent ids; undefined = every supported agent. */
  agents?: AgentId[];
  /** Restrict to specific resource kinds; undefined = all. */
  kinds?: DoctorKind[];
}

/**
 * Read `.system` repo freshness WITHOUT touching the network. `git status`
 * reports ahead/behind against the remote-tracking ref, which the detached
 * auto-pull worker keeps warm via periodic `git fetch`. This is the same number
 * the menu-bar surfaces; we read it once, here, so every surface agrees.
 */
export async function getSystemRepoStatus(): Promise<SystemRepoStatus> {
  const dir = getSystemAgentsDir();
  const base: SystemRepoStatus = { dir, behind: 0, ahead: 0, branch: null, unknown: true };
  if (!isGitRepo(dir)) return base;
  try {
    const status = await simpleGit(dir).status();
    return {
      dir,
      behind: status.behind ?? 0,
      ahead: status.ahead ?? 0,
      branch: status.tracking ?? status.current ?? null,
      // Without a tracking branch there's no upstream to compare against.
      unknown: !status.tracking,
    };
  } catch {
    return base;
  }
}

/**
 * Compute unified sync status across the fleet. Resolves against non-project
 * layers only (`excludeProject: true`) — the GLOBAL version home is never
 * reconciled against per-cwd `<cwd>/.agents/` resources, so counting them as
 * "missing" there would be a false gap (matches doctor's overview semantics).
 */
export async function computeSyncStatus(
  options: SyncStatusOptions = {},
): Promise<UnifiedSyncStatus> {
  const cwd = options.cwd ?? process.cwd();
  const agentIds = options.agents ?? ALL_AGENT_IDS;

  const agents: AgentVersionStatus[] = [];
  for (const agent of agentIds) {
    const def = getGlobalDefault(agent);
    for (const version of listInstalledVersions(agent)) {
      const report = diffVersionResources(agent, version, {
        cwd,
        excludeProject: true,
        ...(options.kinds ? { kinds: options.kinds } : {}),
      });
      const resources = rowsFromReport(agent, version, report);
      const counts = { synced: 0, drifted: 0, missing: 0, orphan: 0 };
      for (const r of resources) counts[r.status]++;
      agents.push({
        agent,
        version,
        isDefault: version === def,
        everSynced: loadManifest(agent, version) !== null,
        counts,
        needsSync: counts.drifted + counts.missing > 0,
        resources,
      });
    }
  }

  const system = await getSystemRepoStatus();

  const agentsNeedingSync = new Set<AgentId>();
  let drifted = 0, missing = 0, orphan = 0, versionsNeedingSync = 0, versionsNeverSynced = 0;
  for (const v of agents) {
    drifted += v.counts.drifted;
    missing += v.counts.missing;
    orphan += v.counts.orphan;
    if (!v.everSynced) versionsNeverSynced++;
    if (v.needsSync) {
      versionsNeedingSync++;
      agentsNeedingSync.add(v.agent);
    }
  }

  return {
    system,
    agents,
    totals: {
      drifted,
      missing,
      orphan,
      versionsNeedingSync,
      versionsNeverSynced,
      agentsNeedingSync: agentsNeedingSync.size,
    },
  };
}
