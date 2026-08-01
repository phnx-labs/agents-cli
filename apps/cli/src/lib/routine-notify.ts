/**
 * Routine lifecycle desktop notifications (RUSH-2030).
 *
 * The daemon fires a branded notification when a scheduled routine starts and
 * when it finishes (success or failure), routed through the MenubarHelper
 * companion (notify-desktop.ts) so it carries the agents-cli mark.
 *
 * Anti-spam threshold (Acceptance Criteria #4 — "define a sensible threshold so
 * users are not spammed"):
 *   - Agent / workflow routines: notify on BOTH start and finish. These are the
 *     runs whose output a user actually wants surfaced.
 *   - Command routines (deterministic housekeeping — version checks, `git pull`,
 *     notify shims that can fire every minute): notify only on FAILURE. A green
 *     housekeeping run is noise; a broken one is worth a ping. No start ping.
 *   - "Notable output" is folded into the single finish notification rather than
 *     sent as a third message: on failure the error reason, on success the first
 *     line of the run's report (the user-facing result) when the routine produced
 *     one. One start + one finish per run — never a stream.
 *
 * The pure builders (`routineStartNotification` / `routineFinishNotification`)
 * return `null` when the threshold says "don't notify", and are unit-tested; the
 * `notifyRoutine*` wrappers do the filesystem read + dispatch for the daemon.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { JobConfig, RunMeta } from './routines.js';
import { getRunDir } from './routines.js';
import { notifyDesktop, type DesktopNotification } from './menubar/notify-desktop.js';

type RoutineKind = 'agent' | 'workflow' | 'command';

/** Which flavor of routine a config/meta describes — drives the notify threshold. */
export function routineKind(r: Pick<JobConfig, 'agent' | 'workflow' | 'command'>): RoutineKind {
  if (r.command) return 'command';
  if (r.workflow) return 'workflow';
  return 'agent';
}

/** Human label for the routine body ("agent claude", "workflow deploy", "command"). */
function routineLabel(r: Pick<JobConfig, 'agent' | 'workflow' | 'command'>): string {
  if (r.command) return 'command';
  if (r.workflow) return `workflow ${r.workflow}`;
  return `agent ${r.agent ?? 'unknown'}`;
}

/** "1m 20s" / "45s" / "2h 3m" from a millisecond duration, or null when unknown. */
export function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin ? `${hr}h ${remMin}m` : `${hr}h`;
}

/**
 * First non-empty line of a run report, trimmed to a notification-sized snippet.
 * This is the "notable output" surfaced on a successful finish — the routine's
 * own user-facing result. Returns null for an empty/whitespace report so the
 * caller falls back to a plain "Completed" body.
 */
export function notableSnippet(report: string | null | undefined, maxLen = 140): string | null {
  if (!report) return null;
  const firstLine = report
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return null;
  return firstLine.length > maxLen ? `${firstLine.slice(0, maxLen - 1).trimEnd()}…` : firstLine;
}

/** Encode a click action that opens a file (report/log) in the default app. */
function openAction(filePath: string | null | undefined): string | undefined {
  return filePath ? `open:${filePath}` : undefined;
}

/**
 * Notification for a routine START, or null when the threshold suppresses it
 * (command-mode housekeeping). Clicking opens the runs folder
 * (~/.agents/.history/runs).
 */
export function routineStartNotification(
  config: Pick<JobConfig, 'name' | 'agent' | 'workflow' | 'command'>,
): DesktopNotification | null {
  if (routineKind(config) === 'command') return null;
  return {
    title: 'Routine started',
    subtitle: config.name,
    body: `Running ${routineLabel(config)}`,
    action: 'routines:list',
  };
}

/**
 * Notification for a routine that failed to even START — `executeJobDetached`
 * threw before the child was spawned, so no run record and no finish will ever
 * exist. The daemon fires the START notification unconditionally, so this closes
 * the "exactly one start + one finish" invariant: the orphaned start gets its
 * matching failure banner (RUSH-2030). Unlike a green finish this is never
 * suppressed — a broken start is worth a ping for every routine kind, including
 * command housekeeping. Clicking opens the runs folder (~/.agents/.history/runs)
 * since there is no run report to open.
 */
export function routineStartFailedNotification(
  config: Pick<JobConfig, 'name' | 'agent' | 'workflow' | 'command'>,
  error: string,
): DesktopNotification {
  return {
    title: 'Routine failed',
    subtitle: config.name,
    body: `Failed to start: ${error}`,
    action: 'routines:list',
  };
}

/**
 * Notification for a routine FINISH, or null when the threshold suppresses it
 * (a successful command-mode housekeeping run). Success carries the report's
 * first line when present (the notable output); failure carries the reason.
 * Clicking opens the run report/log when one is available, else the runs folder
 * (~/.agents/.history/runs).
 */
export function routineFinishNotification(
  meta: Pick<RunMeta, 'jobName' | 'status' | 'exitCode' | 'errorMessage' | 'duration' | 'agent' | 'workflow' | 'command'>,
  opts: { report?: string | null; artifactPath?: string | null } = {},
): DesktopNotification | null {
  const kind = routineKind(meta);
  const ok = meta.status === 'completed';
  if (kind === 'command' && ok) return null; // green housekeeping is noise

  const action = openAction(opts.artifactPath) ?? 'routines:list';

  if (ok) {
    const snippet = notableSnippet(opts.report);
    const dur = formatDuration(meta.duration);
    return {
      title: 'Routine finished',
      subtitle: meta.jobName,
      body: snippet ?? (dur ? `Completed in ${dur}` : 'Completed'),
      action,
    };
  }

  // failed | timeout
  const reason =
    meta.status === 'timeout'
      ? 'Timed out'
      : meta.errorMessage
        ? meta.errorMessage
        : `Exited with code ${meta.exitCode ?? '?'}`;
  return {
    title: 'Routine failed',
    subtitle: meta.jobName,
    body: reason,
    action,
  };
}

/** Read a finished run's report text + the best artifact to open on click. */
function loadRunArtifacts(meta: Pick<RunMeta, 'jobName' | 'runId'>): {
  report: string | null;
  artifactPath: string | null;
} {
  try {
    const runDir = getRunDir(meta.jobName, meta.runId);
    const reportPath = path.join(runDir, 'report.md');
    const stdoutPath = path.join(runDir, 'stdout.log');
    let report: string | null = null;
    let artifactPath: string | null = null;
    if (fs.existsSync(reportPath)) {
      report = fs.readFileSync(reportPath, 'utf-8');
      artifactPath = reportPath;
    } else if (fs.existsSync(stdoutPath)) {
      artifactPath = stdoutPath;
    }
    return { report, artifactPath };
  } catch {
    return { report: null, artifactPath: null };
  }
}

/** Daemon glue: fire the START notification for a triggered routine. Best-effort. */
export function notifyRoutineStart(config: JobConfig): void {
  const n = routineStartNotification(config);
  if (n) notifyDesktop(n);
}

/**
 * Daemon glue: fire the "failed to start" notification when a routine trigger
 * threw before spawning a child. Pairs with the unconditional START ping so a
 * pre-spawn failure never leaves an orphaned "Routine started". Best-effort.
 */
export function notifyRoutineStartFailed(config: JobConfig, error: string): void {
  notifyDesktop(routineStartFailedNotification(config, error));
}

/** Daemon glue: fire the FINISH notification for a completed run. Best-effort. */
export function notifyRoutineFinish(meta: RunMeta): void {
  const { report, artifactPath } = loadRunArtifacts(meta);
  const n = routineFinishNotification(meta, { report, artifactPath });
  if (n) notifyDesktop(n);
}
