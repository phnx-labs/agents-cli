/**
 * Reaper for orphaned / wedged keychain-helper processes.
 *
 * coreauthd / LocalAuthentication hangs can leave helper (and parent `agents`)
 * processes pile up. The pure planner ({@link planKeychainReap}) is unit-testable
 * without a real `ps`; the driver ({@link reapOrphanedKeychainProcesses}) shells
 * `ps` once per tick and kills through {@link killTree}.
 */

import { killTree, captureProcessStartTime } from '../platform/process.js';
import { execFileBounded } from '../exec-bounded.js';

/** Deadline for the whole-process-table `ps` on the keychain-reap tick. */
const KEYCHAIN_PS_TIMEOUT_MS = 5_000;
import { getKeychainHelperPath } from './install-helper.js';

/** Grace before a helper whose parent exited is considered an orphan. */
export const ORPHAN_GRACE_SEC = 30;
/** Grace before a helper with a live parent is considered stuck. */
export const STUCK_GRACE_SEC = 90;

/** Snapshot of one process row from `ps`, fed into the pure planner. */
export interface KeychainProcessSnapshot {
  pid: number;
  ppid: number;
  /** Elapsed seconds since the process started. */
  elapsedSec: number;
  /** Stable start-time fingerprint from {@link captureProcessStartTime}; null fails closed. */
  startTime: string | null;
  /** True for a reap-eligible helper invocation (short-lived keychain verb). */
  isHelper: boolean;
  /**
   * True for the deliberately long-lived `watch-lock` watcher
   * (auto-lock-on-sleep). Mutually exclusive with {@link isHelper}; killing it
   * silently disables auto-lock-on-sleep, so it is reaped only once the owning
   * daemon is provably dead (RUSH-2419).
   */
  isWatchLock?: boolean;
}

/** Tracked state for a stuck parent across two-sweep debounce. */
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
  /** PIDs to kill this tick. */
  kill: number[];
  /** Candidates to carry forward to the next sweep. */
  nextCandidates: Map<number, StuckParentCandidate>;
}

/**
 * Pure predicate: decide which processes to kill given a `ps`-like snapshot.
 *
 * Three conservative classes:
 *   1. Orphaned helper: PPID == 1, helper path, alive longer than grace.
 *   2. Stuck `agents` parent: helper child alive longer than stuck grace,
 *      recorded on first sight, child killed on second sweep, parent on third.
 *   3. Orphaned `watch-lock`: long-lived watcher whose owning daemon is gone.
 *
 * Fails closed when start time can't be captured.
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
      // Orphaned helper: fail closed without a start-time fingerprint.
      if (s.elapsedSec <= ORPHAN_GRACE_SEC) continue;
      if (s.startTime == null) continue;
      kill.push(s.pid);
      continue;
    }

    // Stuck agents: helper with a live parent wedged longer than the timeout.
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
        // Second sweep: kill the child first so spawnSync returns; escalate next.
        kill.push(s.pid);
        nextCandidates.set(parent.pid, { ...prev, stage: 'escalate' });
        continue;
      }
      // Third sweep: child did not free the parent, so the parent is wedged.
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

  // Separate path for orphaned watch-lock watchers: only reap when the owning
  // daemon is provably absent from the process table.
  for (const s of snapshots) {
    if (!s.isWatchLock) continue;
    if (s.startTime == null) continue;
    if (s.elapsedSec <= ORPHAN_GRACE_SEC) continue;

    if (s.ppid !== 1) {
      const parent = pidMap.get(s.ppid);
      if (parent) continue;
      // Parent missing means the owner is dead (or reparenting race); safe to reap.
    }
    kill.push(s.pid);
  }

  return { kill, nextCandidates };
}

/**
 * Parse macOS `ps -o etime=` elapsed time into whole seconds.
 *
 * BSD `etime` renders as `[[dd-]hh:]mm:ss`. `etimes` (raw seconds) is a GNU
 * extension that macOS `ps` rejects, so darwin uses `etime`.
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

/** The one helper verb that is deliberately long-lived: the auto-lock watcher. */
const HELPER_WATCH_LOCK_VERB = 'watch-lock';

/**
 * Whether a `ps` command line is a reap-eligible helper invocation: the installed
 * helper binary running a short-lived keychain verb. Returns false for the
 * long-lived `watch-lock` watcher, which must never be mistaken for a stuck read.
 */
export function isReapableHelperCommand(command: string, helperPath: string): boolean {
  if (command === helperPath) return true; // bare exec, no verb — never watch-lock
  if (!command.startsWith(`${helperPath} `)) return false; // not our helper
  const firstArg = command.slice(helperPath.length + 1).trimStart().split(/\s+/)[0];
  return firstArg !== HELPER_WATCH_LOCK_VERB;
}

/**
 * Whether a `ps` command line is the deliberately long-lived `watch-lock`
 * watcher. Inverse of {@link isReapableHelperCommand} for the watch-lock verb.
 */
export function isWatchLockHelperCommand(command: string, helperPath: string): boolean {
  if (!command.startsWith(`${helperPath} `)) return false;
  const firstArg = command.slice(helperPath.length + 1).trimStart().split(/\s+/)[0];
  return firstArg === HELPER_WATCH_LOCK_VERB;
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
 * Path-matches the full helper path so an unrelated binary named "Agents CLI" is
 * never targeted. Returns on non-darwin without shelling anything.
 */
export async function reapOrphanedKeychainProcesses(): Promise<{
  reaped: number;
  details: string[];
  plan: ReapPlan;
}> {
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
  {
    // Async, deadline-bounded: this whole-process-table `ps` runs on the daemon's
    // shared event loop every keychain-reap tick, so a synchronous `execFileSync`
    // (unbounded) would freeze it (PHNX-3695).
    const res = await execFileBounded('ps', ['-ax', '-o', 'pid=,ppid=,etime=,command='], { timeoutMs: KEYCHAIN_PS_TIMEOUT_MS });
    if (res.code !== 0) {
      return { reaped: 0, details: [`ps failed${res.timedOut ? ' (timed out)' : ''}: ${res.stderr.trim() || `exit ${res.code}`}`], plan: { kill: [], nextCandidates: new Map() } };
    }
    out = res.stdout;
  }

  // Capture start-time fingerprints only for helper processes, orphan-candidate
  // watch-locks, and (for stuck helpers) their parents.
  type PrelimRow = {
    pid: number;
    ppid: number;
    elapsedSec: number;
    isHelper: boolean;
    isWatchLock: boolean;
    startTime: string | null;
  };
  const rows: PrelimRow[] = [];
  for (const line of out.split('\n')) {
    const parsed = parsePsLine(line);
    if (!parsed) continue;
    const { pid, ppid, elapsedSec, command } = parsed;
    // Match the full argv so the long-lived `watch-lock` watcher is never
    // mistaken for a stuck read. Orphaned watch-locks are tracked separately.
    const isHelper = isReapableHelperCommand(command, helperPath);
    const isWatchLock = isWatchLockHelperCommand(command, helperPath);
    rows.push({ pid, ppid, elapsedSec, isHelper, isWatchLock, startTime: null });
  }

  const rowByPid = new Map<number, PrelimRow>(rows.map((r) => [r.pid, r]));
  for (const row of rows) {
    if (!row.isHelper && !row.isWatchLock) continue;
    row.startTime = captureProcessStartTime(row.pid);
    if (row.isHelper && row.ppid !== 1 && row.elapsedSec > STUCK_GRACE_SEC) {
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
    isWatchLock: r.isWatchLock,
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
