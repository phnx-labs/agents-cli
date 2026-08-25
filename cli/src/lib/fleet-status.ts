/**
 * Per-host fleet-status rows: this machine's resource stats PLUS its live agent
 * workload (running-agent count + per-context / per-agent breakdown), published
 * to a shared local mirror.
 *
 * ## Why this exists (RUSH-2061)
 *
 * The daemon's fleet-cache warm used to `loadFleetStats({ forceRefresh: true })`
 * every 3 minutes — an SSH resource probe of EVERY device. With N daemons each
 * probing N devices that is N² SSH round trips across the fleet every 3 minutes,
 * each a remote `uptime;vm_stat;nproc` compute with a timeout that (pre-RUSH-2114)
 * could orphan the remote child. This module replaces that with a
 * **publish-own / read-union** model:
 *
 *  - Each daemon probes ONLY ITSELF (`probeLocalFleetStatus`, no SSH) and writes
 *    its own row into the mirror. Zero cross-host SSH from the daemon → the N²
 *    probe is gone.
 *  - A READER (the `agents fleet status` command) unions the fleet's rows on
 *    demand — a bounded, kill-on-timeout SSH read of each peer's already-computed
 *    `--local` row (a cheap `cat`-equivalent, not a fresh remote probe) — and
 *    writes them into the same mirror. `readFleetStatus` then serves the union
 *    synchronously with no network at all.
 *
 * The mirror file matches the `stats-cache` / `auth-health` convention exactly:
 * `{ version: 1, entries: Record<host, FleetStatusRow> }` under `getCacheDir()`,
 * keyed by `machineId()`, best-effort read/write that never throws.
 */
import * as fs from 'fs';
import * as path from 'path';

import { getCacheDir } from './state.js';
import { probeLocalStats, type DeviceStats } from './devices/health.js';
import { getActiveSessions } from './session/active.js';
import { atomicWriteFileSync, ensureLockTarget, withFileLock } from './fs-atomic.js';

/** Live agent workload on a host. */
export interface FleetAgentCounts {
  /** Sessions actively working (status === 'running'). */
  running: number;
  /** Total live sessions regardless of status (running/idle/input-required/…). */
  live: number;
  /** Running count broken down by context: terminal / teams / cloud / headless. */
  byContext: Record<string, number>;
  /** Running count broken down by agent CLI: claude / codex / cursor / … */
  byAgent: Record<string, number>;
}

/** One host's published status row. */
export interface FleetStatusRow {
  host: string;
  agents: FleetAgentCounts;
  /** Resource stats from the local probe; null when the probe produced nothing. */
  stats: DeviceStats | null;
  /** Epoch ms this row was computed. */
  capturedAt: number;
}

/** Minimal shape needed to count workload — a subset of ActiveSession. */
type CountableSession = { status?: string; context?: string; kind?: string; pidAlive?: boolean };

/**
 * Tally running-agent workload from a host's live sessions. "running" is the
 * actively-working set (`status === 'running'`); `live` is every session the
 * host is tracking. Pure so the tally is unit-tested without a live scan.
 */
export function computeAgentCounts(sessions: ReadonlyArray<CountableSession>): FleetAgentCounts {
  const byContext: Record<string, number> = {};
  const byAgent: Record<string, number> = {};
  let running = 0;
  let live = 0;
  for (const s of sessions) {
    live += 1;
    if (s.status !== 'running') continue;
    running += 1;
    const ctx = s.context ?? 'unknown';
    const agent = s.kind ?? 'unknown';
    byContext[ctx] = (byContext[ctx] ?? 0) + 1;
    byAgent[agent] = (byAgent[agent] ?? 0) + 1;
  }
  return { running, live, byContext, byAgent };
}

/**
 * Probe THIS host's status — resource stats locally (no SSH) and agent workload
 * from the local live-session set (`getActiveSessions({ localOnly: true })`,
 * which never dials a remote host). Never throws: a failed sub-probe degrades to
 * null stats / zero counts.
 */
export async function probeLocalFleetStatus(host: string, now: number = Date.now()): Promise<FleetStatusRow> {
  const [stats, sessions] = await Promise.all([
    probeLocalStats(host).catch(() => null),
    getActiveSessions({ localOnly: true }).catch(() => [] as CountableSession[]),
  ]);
  return {
    host,
    agents: computeAgentCounts(sessions),
    stats: stats ?? null,
    capturedAt: now,
  };
}

interface FleetStatusCacheFile {
  version: 1;
  entries: Record<string, FleetStatusRow>;
}

/** Test seam for the mirror path (see usage.ts `setClaudeUsageCachePathForTest`). */
let mirrorPathOverride: string | null = null;
export function setFleetStatusMirrorPathForTest(mirrorPath: string | null): string | null {
  const prev = mirrorPathOverride;
  mirrorPathOverride = mirrorPath;
  return prev;
}
function mirrorPath(): string {
  return mirrorPathOverride ?? path.join(getCacheDir(), '.fleet-status.json');
}

/** Read the whole fleet-status mirror (best-effort; missing/corrupt → empty). */
export function readFleetStatus(): Record<string, FleetStatusRow> {
  try {
    const parsed = JSON.parse(fs.readFileSync(mirrorPath(), 'utf-8')) as FleetStatusCacheFile;
    if (parsed && parsed.entries && typeof parsed.entries === 'object') return parsed.entries;
  } catch {
    // missing or corrupt — treat as empty
  }
  return {};
}

/** Merge rows into the mirror (best-effort; preserves other hosts' rows). */
export function writeFleetStatusRows(entries: Record<string, FleetStatusRow>): void {
  try {
    const target = mirrorPath();
    ensureLockTarget(target, JSON.stringify({ version: 1, entries: {} }));
    withFileLock(target, () => {
      const merged: FleetStatusCacheFile = {
        version: 1,
        entries: { ...readFleetStatus(), ...entries },
      };
      atomicWriteFileSync(target, JSON.stringify(merged, null, 2));
    });
  } catch {
    // best-effort; a failed write just means the reader sees an older union
  }
}

/**
 * Publish THIS host's row into the mirror (probe self, no SSH). The daemon calls
 * this on its warm tick; it is the whole of the daemon's fleet-status duty now
 * that cross-host probing is gone.
 */
export async function publishLocalFleetStatus(host: string): Promise<FleetStatusRow> {
  const row = await probeLocalFleetStatus(host);
  writeFleetStatusRows({ [host]: row });
  return row;
}
