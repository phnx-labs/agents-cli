/**
 * Reaper for orphaned / wedged keychain-helper processes.
 *
 * macOS keychain-helper calls are synchronous spawnSync invocations. When
 * coreauthd / LocalAuthentication hangs, the helper process (and sometimes its
 * parent `agents` process) can pile up forever. This module detects two classes
 * of stale process and kills them.
 *
 * The design splits cleanly into:
 *   - a pure planner ({@link planKeychainReap}) that is unit-testable without a
 *     real `ps` shell, and
 *   - an impure driver ({@link reapOrphanedKeychainProcesses}) that shells `ps`
 *     once per tick and executes kills through {@link killTree}.
 */

import { execFileSync } from 'child_process';
import { killTree, captureProcessStartTime } from '../platform/process.js';
import { getKeychainHelperPath } from './install-helper.js';

/** Elapsed grace before a helper whose parent exited is considered an orphan. */
export const ORPHAN_GRACE_SEC = 30;
/** Elapsed grace before a helper with a live parent is considered stuck. */
export const STUCK_GRACE_SEC = 90;

/** Snapshot of one process row from `ps`, fed into the pure planner. */
export interface KeychainProcessSnapshot {
  pid: number;
  ppid: number;
  /** Elapsed seconds since the process started. */
  elapsedSec: number;
  /**
   * Stable start-time fingerprint from {@link captureProcessStartTime}.
   * `null` means "could not capture" — the planner must fail closed.
   */
  startTime: string | null;
  /** True when this process's executable path matches the installed helper. */
  isHelper: boolean;
}

/**
 * Tracked state for a stuck `agents` parent that has a live helper child.
 * Keyed by parent PID. The two-sweep debounce avoids acting on a racy `ps`
 * snapshot; the `stage` field drives child-first kill then parent escalation.
 */
export interface StuckParentCandidate {
  pid: number;
  startTime: string | null;
  helperPid: number;
  helperStartTime: string | null;
  firstSeenAt: number;
  stage: 'watch' | 'escalate';
}

/** Result of one planning pass. */
export interface ReapPlan {
  /** PIDs that should be killed this tick. */
  kill: number[];
  /** Candidates to carry forward to the next sweep. */
  nextCandidates: Map<number, StuckParentCandidate>;
}

/**
 * Pure predicate: decide which processes to kill given a `ps`-like snapshot.
 *
 * Mirrors the shape of {@link isExpiredPoolStray} in `lib/crabbox/lease.ts`:
 * a side-effect-free classifier that the impure driver shells `ps` for. Two
 * conservative reap classes:
 *
 *   1. Orphaned helper: PPID == 1, path-matches the helper, alive longer than
 *      {@link ORPHAN_GRACE_SEC}.
 *   2. Stuck `agents` parent: helper child alive longer than
 *      {@link STUCK_GRACE_SEC}. Recorded on first sight, child killed on the
 *      second consecutive sweep with the same PID + startTime, parent killed on
 *      the third sweep if the helper child is still present.
 *
 * Never reaps a process whose start time could not be captured, whose path does
 * not match the helper, or whose parent is no longer in the snapshot.
 */
export function planKeychainReap(
  snapshots: KeychainProcessSnapshot[],
  now: number,
  prevCandidates: ReadonlyMap<number, StuckParentCandidate>,
): ReapPlan {
  const pidMap = new Map<number, KeychainProcessSnapshot>(snapshots.map((s) => [s.pid, s]));
  const kill: number[] = [];
  const nextCandidates = new Map<number, StuckParentCandidate>();

  for (const s of snapshots) {
    if (!s.isHelper) continue;

    if (s.ppid === 1) {
      // Orphaned helper: parent is init/launchd. Fail closed if we can't prove
      // the process identity with a start-time fingerprint.
      if (s.elapsedSec <= ORPHAN_GRACE_SEC) continue;
      if (s.startTime == null) continue;
      kill.push(s.pid);
      continue;
    }

    // Stuck agents: a helper with a live parent that has been wedged for longer
    // than the interactive timeout. The parent must still exist in the snapshot.
    if (s.elapsedSec <= STUCK_GRACE_SEC) continue;
    const parent = pidMap.get(s.ppid);
    if (!parent) continue;
    if (s.startTime == null || parent.startTime == null) continue;

    const prev = prevCandidates.get(parent.pid);
    if (
      prev &&
      prev.helperPid === s.pid &&
      prev.helperStartTime === s.startTime &&
      prev.startTime === parent.startTime
    ) {
      if (prev.stage === 'watch') {
        // Second sweep: kill the child first so the parent's spawnSync returns.
        // Keep the parent candidate at stage 'escalate' for the next sweep.
        kill.push(s.pid);
        nextCandidates.set(parent.pid, { ...prev, stage: 'escalate' });
        continue;
      }
      // Third sweep: child did not free the parent, so the parent itself is wedged.
      kill.push(parent.pid);
      continue;
    }

    // First sight of this (parent, helper) pair — record it and wait.
    nextCandidates.set(parent.pid, {
      pid: parent.pid,
      startTime: parent.startTime,
      helperPid: s.pid,
      helperStartTime: s.startTime,
      firstSeenAt: now,
      stage: 'watch',
    });
  }

  return { kill, nextCandidates };
}

/**
 * Parse macOS `ps -o etime=` elapsed time into whole seconds.
 *
 * BSD `etime` renders as `[[dd-]hh:]mm:ss` (e.g. `05:03`, `01:02:03`,
 * `14-04:10:52`). This is the portable keyword: `etimes` (raw seconds) is a
 * GNU/Linux procps extension that macOS `ps` rejects with a non-zero exit, so
 * the reaper — which only ever runs on darwin — must read `etime`.
 * Returns null for an unparseable value so the caller drops the row.
 */
export function parseEtimeToSeconds(raw: string): number | null {
  const m = raw.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const days = m[1] ? parseInt(m[1], 10) : 0;
  const hours = m[2] ? parseInt(m[2], 10) : 0;
  const mins = parseInt(m[3], 10);
  const secs = parseInt(m[4], 10);
  if ([days, hours, mins, secs].some(isNaN)) return null;
  return ((days * 24 + hours) * 60 + mins) * 60 + secs;
}

/**
 * Parse one `ps` output line.
 *
 * Expected format from `ps -ax -o pid=,ppid=,etime=,command=`:
 *   "<pid> <ppid> <etime> <command...>"
 * where `<etime>` is BSD elapsed time (`[[dd-]hh:]mm:ss`). The command field is
 * the remainder of the line and may contain spaces.
 */
function parsePsLine(line: string): {
  pid: number;
  ppid: number;
  elapsedSec: number;
  command: string;
} | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
  if (!m) return null;
  const pid = parseInt(m[1], 10);
  const ppid = parseInt(m[2], 10);
  const elapsedSec = parseEtimeToSeconds(m[3]);
  const command = m[4];
  if (isNaN(pid) || isNaN(ppid) || elapsedSec == null) return null;
  return { pid, ppid, elapsedSec, command };
}

/** Module-state for the two-sweep stuck-parent debounce. */
let stuckParentCandidates = new Map<number, StuckParentCandidate>();

/** Test seam: reset the persisted candidate state. */
export function resetKeychainReaperCandidatesForTest(): void {
  stuckParentCandidates = new Map<number, StuckParentCandidate>();
}

/**
 * Impure driver: snapshot all processes once with `ps`, plan the reap, then
 * execute kills through {@link killTree}.
 *
 * Path-matching uses the full helper path (proc_pidpath-style), not just the
 * executable name, so an unrelated binary named "Agents CLI" is never targeted.
 *
 * Returns on non-darwin platforms without shelling anything — the helper only
 * exists on macOS.
 */
export function reapOrphanedKeychainProcesses(): {
  reaped: number;
  details: string[];
  plan: ReapPlan;
} {
  const details: string[] = [];
  if (process.platform !== 'darwin') {
    return { reaped: 0, details, plan: { kill: [], nextCandidates: new Map() } };
  }

  let helperPath: string;
  try {
    helperPath = getKeychainHelperPath();
  } catch (err) {
    return { reaped: 0, details: [`helper path resolution failed: ${(err as Error).message}`], plan: { kill: [], nextCandidates: new Map() } };
  }

  let out: string;
  try {
    out = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,etime=,command='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    return { reaped: 0, details: [`ps failed: ${(err as Error).message}`], plan: { kill: [], nextCandidates: new Map() } };
  }

  // Parse the snapshot cheaply, then capture start-time fingerprints ONLY for
  // helper processes (and their parents when a stuck candidate is found).
  // captureProcessStartTime shells `ps` per unseen pid; doing it for every
  // process on the machine would create the very pileup the reaper exists to
  // prevent.
  type PrelimRow = {
    pid: number;
    ppid: number;
    elapsedSec: number;
    isHelper: boolean;
    startTime: string | null;
  };
  const rows: PrelimRow[] = [];
  for (const line of out.split('\n')) {
    const parsed = parsePsLine(line);
    if (!parsed) continue;
    const { pid, ppid, elapsedSec, command } = parsed;
    // Exact path-match: the helper invocation's command line begins with the
    // absolute helper path, followed by a space and its arguments (or nothing).
    const isHelper = command === helperPath || command.startsWith(`${helperPath} `);
    rows.push({ pid, ppid, elapsedSec, isHelper, startTime: null });
  }

  const rowByPid = new Map<number, PrelimRow>(rows.map((r) => [r.pid, r]));
  for (const row of rows) {
    if (!row.isHelper) continue;
    row.startTime = captureProcessStartTime(row.pid);
    if (row.ppid !== 1 && row.elapsedSec > STUCK_GRACE_SEC) {
      const parent = rowByPid.get(row.ppid);
      if (parent && parent.startTime === null) {
        parent.startTime = captureProcessStartTime(row.ppid);
      }
    }
  }

  const snapshots: KeychainProcessSnapshot[] = rows.map((r) => ({
    pid: r.pid,
    ppid: r.ppid,
    elapsedSec: r.elapsedSec,
    startTime: r.startTime,
    isHelper: r.isHelper,
  }));

  const plan = planKeychainReap(snapshots, Date.now(), stuckParentCandidates);
  stuckParentCandidates = plan.nextCandidates;

  for (const pid of plan.kill) {
    if (pid === process.pid) continue; // never self-terminate the reaper
    try {
      killTree(pid);
      details.push(`killed pid ${pid}`);
    } catch (err) {
      details.push(`failed to kill pid ${pid}: ${(err as Error).message}`);
    }
  }

  return { reaped: plan.kill.length, details, plan };
}
