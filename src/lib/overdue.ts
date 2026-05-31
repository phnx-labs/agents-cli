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

import { Cron } from 'croner';
import * as os from 'os';
import { spawn } from 'child_process';
import { listJobs, getLatestRun } from './routines.js';

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
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Compute the most recent fire of `pattern` at or before `now`. Croner's
 *  `previousRun()` returns the cron instance's own last fire, which is null
 *  on a freshly-constructed instance — so we walk `nextRun(cursor)` forward
 *  from a week ago and keep the last fire still ≤ now. */
function previousExpectedFire(cron: Cron, now: Date): Date | null {
  let cursor: Date = new Date(now.getTime() - ONE_WEEK_MS);
  let last: Date | null = null;
  // Cap iterations: even an every-minute schedule yields ≤ 10080 steps over a
  // week; we cap at 20k as a paranoia bound against pathological patterns.
  for (let i = 0; i < 20000; i++) {
    const next = cron.nextRun(cursor);
    if (!next || next.getTime() > now.getTime()) break;
    last = next;
    cursor = next;
  }
  return last;
}

/** Return every enabled, recurring job whose most recent expected fire was
 *  missed. One-shot jobs are excluded — they fire at most once. */
export function detectOverdueJobs(now: Date = new Date()): OverdueJob[] {
  const overdue: OverdueJob[] = [];

  for (const job of listJobs()) {
    if (!job.enabled || job.runOnce) continue;

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

/** Fire a native desktop notification listing the overdue jobs. Best-effort —
 *  failures (missing `osascript`/`notify-send`, no display) are swallowed. */
export function notifyOverdue(jobs: OverdueJob[]): void {
  if (jobs.length === 0) return;

  const title =
    jobs.length === 1
      ? `Routine overdue: ${jobs[0].name}`
      : `${jobs.length} routines overdue`;
  const body =
    jobs.length === 1
      ? `Missed ${jobs[0].expectedAt.toLocaleString()}. Run: agents routines catchup`
      : `${jobs.map((j) => j.name).join(', ')} — agents routines catchup`;

  const platform = os.platform();
  try {
    if (platform === 'darwin') {
      const safeTitle = title.replace(/"/g, '\\"');
      const safeBody = body.replace(/"/g, '\\"');
      const child = spawn(
        'osascript',
        ['-e', `display notification "${safeBody}" with title "${safeTitle}"`],
        { detached: true, stdio: 'ignore' }
      );
      child.unref();
    } else if (platform === 'linux') {
      const child = spawn('notify-send', [title, body], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    }
  } catch {
    // Notification is best-effort; nothing to do.
  }
}
