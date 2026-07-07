/**
 * Shared drift-detection internals for `agents doctor` (overview mode) and
 * `agents check` (the scriptable, CI-friendly gate).
 *
 * This is the single source of truth for "is the install out of sync?": the
 * per-version sync status (fresh / stale / never-synced) and the orphan census.
 * `agents doctor` renders it as a human report; `agents check` reduces it to an
 * exit code. Neither reimplements the diagnostic — both call `computeDrift`.
 */
import type { AgentId } from './types.js';
import { ALL_AGENT_IDS } from './agents.js';
import { getGlobalDefault, listInstalledVersions } from './versions.js';
import { loadManifest, isStale } from './staleness/index.js';
import { diffVersionResources, type VersionResourceReport } from './doctor-diff.js';
import { diffVersionCommands, iterCommandsCapableVersions } from './commands.js';
import { diffVersionSkills, iterSkillsCapableVersions } from './skills.js';
import { iterHooksCapableVersions, listUnmanagedHooksInVersionHome } from './hooks.js';

export interface SyncStatusRow {
  agent: AgentId;
  version: string;
  status: 'fresh' | 'stale' | 'never-synced';
  isDefault: boolean;
  /** For stale rows: prioritized lines naming exactly what diverged (plugins first). */
  divergence?: string[];
}

export interface OrphanRow {
  agent: AgentId;
  version: string;
  commands: number;
  skills: number;
  hooks: number;
}

// Lines naming exactly what's out of sync for a version, plugins prioritized:
// each divergent plugin gets its own line with specifics (stale mirror version,
// invalid manifest, or the bundled skills/commands missing from the mirror —
// the system-repo plugin content that matters most). Other kinds collapse to
// compact counts so the readout stays scannable.
export function divergenceLines(report: VersionResourceReport): string[] {
  const lines: string[] = [];
  for (const p of report.kinds.plugins) {
    if (p.status === 'missing') lines.push(`plugin ${p.name} — not installed`);
    else if (p.status === 'diff') lines.push(`plugin ${p.name} — ${p.detail ?? 'mirror drifted'}`);
  }
  for (const kind of ['commands', 'skills', 'hooks', 'rules', 'mcp', 'permissions', 'subagents'] as const) {
    const rows = report.kinds[kind];
    const miss = rows.filter((r) => r.status === 'missing').length;
    const dif = rows.filter((r) => r.status === 'diff').length;
    const bits: string[] = [];
    if (miss) bits.push(`${miss} missing`);
    if (dif) bits.push(`${dif} drifted`);
    if (bits.length) lines.push(`${kind.padEnd(11)} ${bits.join(' · ')}`);
  }
  return lines;
}

export function checkSyncStatus(cwd: string): SyncStatusRow[] {
  const rows: SyncStatusRow[] = [];
  // Every installed version, not just the default — a stale NON-default version
  // (e.g. one you launched from yesterday) is exactly the rot that silently
  // serves outdated/invalid resources and that `--fix` now heals. Hiding it here
  // is why that class of bug went unnoticed.
  for (const agent of ALL_AGENT_IDS) {
    const def = getGlobalDefault(agent);
    for (const version of listInstalledVersions(agent)) {
      const manifest = loadManifest(agent, version);
      const status: SyncStatusRow['status'] = !manifest
        ? 'never-synced'
        : isStale(manifest, agent, version, cwd) ? 'stale' : 'fresh';
      const row: SyncStatusRow = { agent, version, status, isDefault: version === def };
      if (status === 'stale') {
        // Resolve the specifics against non-project layers (the global home is
        // never reconciled against per-cwd project resources).
        const report = diffVersionResources(agent, version, { cwd, excludeProject: true });
        const lines = divergenceLines(report);
        if (lines.length) row.divergence = lines;
      }
      rows.push(row);
    }
  }
  return rows;
}

export function countOrphans(): OrphanRow[] {
  const byKey = new Map<string, OrphanRow>();

  const ensure = (agent: AgentId, version: string): OrphanRow => {
    const key = `${agent}@${version}`;
    let row = byKey.get(key);
    if (!row) {
      row = { agent, version, commands: 0, skills: 0, hooks: 0 };
      byKey.set(key, row);
    }
    return row;
  };

  for (const { agent, version } of iterCommandsCapableVersions()) {
    const diff = diffVersionCommands(agent, version);
    if (diff.orphans.length > 0) ensure(agent, version).commands = diff.orphans.length;
  }
  for (const { agent, version } of iterSkillsCapableVersions()) {
    const diff = diffVersionSkills(agent, version);
    if (diff.orphans.length > 0) ensure(agent, version).skills = diff.orphans.length;
  }
  // Orphan hooks are scripts in the version home that no agents.yaml/hooks.yaml
  // entry registers — so the registrar never wires them to an event and they
  // never fire. (Distinct from the source-diff `diffVersionHooks().orphans`,
  // which false-flags valid system-sourced registered hooks.)
  for (const { agent, version } of iterHooksCapableVersions()) {
    const dead = listUnmanagedHooksInVersionHome(agent, version);
    if (dead.length > 0) ensure(agent, version).hooks = dead.length;
  }

  return Array.from(byKey.values()).filter((r) => r.commands + r.skills + r.hooks > 0);
}

export interface DriftSummary {
  syncRows: SyncStatusRow[];
  orphanRows: OrphanRow[];
  /** Versions whose sources changed since last sync. */
  staleCount: number;
  /** Versions installed but never synced. */
  neverSyncedCount: number;
  /** Versions carrying orphan resources (informational — not a drift signal). */
  orphanVersionCount: number;
  /**
   * True when any installed version is stale or never-synced — the exact signal
   * `agents doctor` surfaces as "run `agents status` to review what has drifted".
   * Orphans are a `prune` concern, not sync drift, so they do NOT set this flag
   * (mirrors the sync-status engine: an orphan alone never flags needsSync).
   */
  hasDrift: boolean;
}

/**
 * Compute the same drift/divergence diagnostic `agents doctor` prints, reduced
 * to a summary with a single `hasDrift` boolean. The gate `agents check` maps
 * to an exit code; the readout `agents doctor` renders in full.
 */
export function computeDrift(cwd: string): DriftSummary {
  const syncRows = checkSyncStatus(cwd);
  const orphanRows = countOrphans();
  const staleCount = syncRows.filter((r) => r.status === 'stale').length;
  const neverSyncedCount = syncRows.filter((r) => r.status === 'never-synced').length;
  return {
    syncRows,
    orphanRows,
    staleCount,
    neverSyncedCount,
    orphanVersionCount: orphanRows.length,
    hasDrift: syncRows.some((r) => r.status !== 'fresh'),
  };
}
