/**
 * Overdue routine detection.
 *
 * When the daemon was not running (laptop off, reboot, daemon crash) at the
 * time a job was supposed to fire, the missed schedule is lost — croner only
 * schedules forward from "now." This module compares each enabled job's
 * most-recent expected fire time (from its cron expression) with the start
 * time of its most-recent recorded run; jobs whose latest run is older than
 * their most-recent expected fire are flagged as overdue.
 *
 * Surfaced two ways: a desktop notification on daemon startup, and a
 * `agents routines catchup` command that runs them on demand.
 */

import * as fs from 'fs';
import { Cron } from 'croner';
import { listJobs, getLatestRun, resolveJobFilePath, isPastEndAt, isOneShotRoutine, jobRunsOnThisDevice, type JobConfig } from './routines.js';
import { notifyDesktop } from './menubar/notify-desktop.js';

export interface OverdueJob {
  name: string;
  /** Most recent expected fire time per the cron expression. */
  expectedAt: Date;
  /** Start time of the most recent recorded run, or null if never run. */
  lastRanAt: Date | null;
}

// Tolerance between "expected fire" and "recorded run start" — accounts for
// the small gap between the cron tick and when the runner writes meta.json.
const GRACE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Lookback windows, narrowest first. A fixed one-week window silently blinded
 * detection to any cron whose gap exceeds it: `0 9 1,13,25 * *` has 12-day gaps,
 * so `nextRun(now - 7d)` jumped past `now`, the walk returned null, and the
 * routine was never flagged overdue on any device — no missed record, no
 * catch-up, permanently. Monthly, quarterly and annual routines were all in that
 * class.
 *
 * A wider window is only tried when the narrower one found nothing, so a dense
 * schedule (every minute, hourly, daily) never walks more than a week of
 * occurrences. A sparse schedule has few occurrences to walk by definition.
 */
const LOOKBACK_WINDOWS_MS = [7 * DAY_MS, 32 * DAY_MS, 93 * DAY_MS, 400 * DAY_MS];

/** Compute the most recent fire of `pattern` at or before `now`. Croner's
 *  `previousRun()` returns the cron instance's own last fire, which is null
 *  on a freshly-constructed instance — so we walk `nextRun(cursor)` forward
 *  from a week ago and keep the last fire still ≤ now. */
function previousExpectedFire(cron: Cron, now: Date): Date | null {
  for (const window of LOOKBACK_WINDOWS_MS) {
    let cursor: Date = new Date(now.getTime() - window);
    let last: Date | null = null;
    // Cap iterations: an every-minute schedule yields ≤ 10080 steps over a week;
    // 20k is a paranoia bound against pathological patterns. Only a schedule
    // that found nothing in the narrower window reaches a wider one, and such a
    // schedule is sparse, so the cap is never the binding constraint.
    for (let i = 0; i < 20000; i++) {
      const next = cron.nextRun(cursor);
      if (!next || next.getTime() > now.getTime()) break;
      last = next;
      cursor = next;
    }
    if (last) return last;
  }
  return null;
}

/**
 * When a routine started existing, and therefore the earliest fire it can
 * sensibly be judged against.
 *
 * `createdAt` is stamped by `writeJob`. Routines written before that field
 * existed have none, so the file's own mtime stands in — it is the closest
 * honest answer available on disk, and it only ever moves the floor later,
 * never earlier, so it cannot manufacture a false "overdue".
 *
 * Returns null when neither is available, which leaves the routine unfloored
 * (previous behaviour) rather than silently skipping it.
 */
export function routineEffectiveStart(job: JobConfig, now: Date = new Date()): Date | null {
  if (job.createdAt) {
    const stamped = new Date(job.createdAt);
    // Clamp a future stamp (clock skew, a hand-edited year) to now. Left
    // unclamped it sits after every possible expected fire, so the routine can
    // never be flagged overdue until wall-clock time catches up.
    if (!isNaN(stamped.getTime())) {
      return stamped.getTime() > now.getTime() ? now : stamped;
    }
  }
  const path = resolveJobFilePath(job.name);
  if (!path) return null;
  try {
    return new Date(fs.statSync(path).mtimeMs);
  } catch {
    return null;
  }
}

/** Return every enabled, recurring job whose most recent expected fire was
 *  missed. One-shot jobs are excluded — they fire at most once. */
export function detectOverdueJobs(now: Date = new Date()): OverdueJob[] {
  const overdue: OverdueJob[] = [];

  for (const job of listJobs()) {
    if (!job.enabled) continue;
    // One-shot: fires at most once, so a missed slot is not a backlog to replay.
    // Use the same predicate the scheduler does — the raw `runOnce` flag alone
    // missed a one-shot-LIKE schedule (a fixed minute/hour/day/month) that never
    // carried the flag.
    if (isOneShotRoutine(job)) continue;
    // Past its configured end: catch-up must not resurrect a routine the author
    // already retired. The scheduler only auto-disables lazily, inside a live
    // cron tick, so a routine whose endAt elapsed while the daemon was down is
    // still enabled on disk when the catch-up pass runs.
    if (isPastEndAt(job, now)) continue;
    // Trigger-only jobs (no cron schedule) never have an expected fire time.
    if (!job.schedule) continue;
    // A job pinned to another device is that device's to run, notify, and
    // catch up — flagging it here would make every machine in the fleet nag
    // (and `catchup` fire) for a job that must not run locally.
    if (!jobRunsOnThisDevice(job)) continue;

    let expected: Date | null = null;
    try {
      const cronOptions: Record<string, unknown> = { paused: true };
      if (job.timezone) cronOptions.timezone = job.timezone;
      const cron = new Cron(job.schedule, cronOptions);
      expected = previousExpectedFire(cron, now);
      cron.stop();
    } catch {
      // Invalid cron expression — skip rather than crash the daemon.
      continue;
    }

    if (!expected) continue;

    // A fire that predates the routine never could have happened, so it is not
    // a miss. Without this, any newly created routine on a daily/weekly cron is
    // instantly "overdue" for the previous occurrence — and with auto-catchup
    // that means `agents routines add` runs the routine once, immediately.
    const start = routineEffectiveStart(job, now);
    if (start && expected.getTime() < start.getTime()) continue;

    const latest = getLatestRun(job.name);
    const lastRanAt = latest ? new Date(latest.startedAt) : null;

    const isOverdue =
      !lastRanAt || lastRanAt.getTime() < expected.getTime() - GRACE_MS;

    if (isOverdue) {
      overdue.push({ name: job.name, expectedAt: expected, lastRanAt });
    }
  }

  return overdue;
}

/**
 * Fire a branded desktop notification listing the overdue jobs. Routed through
 * the MenubarHelper companion (notify-desktop.ts) so it carries the agents-cli
 * mark; clicking opens the runs folder (~/.agents/.history/runs). Best-effort —
 * a missing notifier or absent display is swallowed and never crashes the daemon.
 */
export function notifyOverdue(jobs: OverdueJob[]): void {
  if (jobs.length === 0) return;

  const title =
    jobs.length === 1 ? 'Routine overdue' : `${jobs.length} routines overdue`;
  const subtitle = jobs.length === 1 ? jobs[0].name : undefined;
  const body =
    jobs.length === 1
      ? `Missed ${jobs[0].expectedAt.toLocaleString()}. Run: agents routines catchup`
      : `${jobs.map((j) => j.name).join(', ')} — agents routines catchup`;

  notifyDesktop({ title, subtitle, body, action: 'routines:list' });
}
