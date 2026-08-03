/**
 * Catch-up: run a routine whose scheduled fire this device missed.
 *
 * Fires are in-process croner timers, and croner only ever schedules forward
 * from "now". A daemon that is down, asleep, or wedged when a routine comes due
 * therefore loses that fire outright — `loadAll()` rebuilds every Cron looking
 * only at the future (scheduler.ts), so nothing replays it. Detection has always
 * existed (`detectOverdueJobs`), but it ran once at daemon startup and only
 * logged plus popped a notification; the routine still never ran.
 *
 * This module closes that loop. A missed fire is:
 *
 *   1. RECORDED — `recordMissedFire` writes a real run with status `missed`,
 *      stamped at the time the fire was DUE, so `agents routines runs <name>`
 *      shows the gap instead of the listing showing a weeks-old `completed` as
 *      though it were current.
 *   2. RUN — unless the routine sets `catchup: false`, it is executed late via
 *      the same `executeJobDetached` path `agents routines catchup` already used.
 *
 * The `missed` record is also what makes this idempotent, so there is no
 * separate ledger to keep in sync. `detectOverdueJobs` compares the most recent
 * expected fire against `getLatestRun(...).startedAt`; a `missed` record stamped
 * at `expectedAt` advances that comparison, so the same missed fire is never
 * processed twice — across ticks, daemon restarts, or a restart storm. (A job
 * that is overdue by definition has no run later than `expectedAt`, so the
 * back-stamped record always sorts last in `listRuns`.)
 */

import {
  readJob,
  writeRunMeta,
  type JobConfig,
  type RunMeta,
} from './routines.js';
import { detectOverdueJobs, type OverdueJob } from './overdue.js';
import { executeJobDetached } from './runner.js';

/** What happened to one overdue routine on a catch-up pass. */
export interface CatchupOutcome {
  name: string;
  /** The fire that was missed. */
  expectedAt: Date;
  /** `ran` — re-run late. `recorded` — miss logged, `catchup: false`. `error` — could not run. */
  result: 'ran' | 'recorded' | 'error';
  /** Run id of the late run, when one was started. */
  runId?: string;
  /** Why the late run could not be started. */
  error?: string;
}

/**
 * Is this routine allowed to run late? Default true — a routine you scheduled
 * is one you expect to have run, so losing a fire silently is never the helpful
 * default. `catchup: false` opts out a routine whose worth expires with its slot.
 */
export function shouldCatchUp(job: Pick<JobConfig, 'catchup'>): boolean {
  return job.catchup !== false;
}

/**
 * Persist the fact that a fire never happened, stamped at the moment it was due.
 *
 * The run id is derived from `expectedAt` (not "now") for two reasons: run ids
 * are ISO timestamps that `listRuns` sorts lexically, so the record lands in
 * history at the point the gap actually occurred; and re-deriving the same id
 * for the same missed fire makes the write idempotent.
 */
export function recordMissedFire(job: JobConfig, expectedAt: Date): RunMeta {
  const runId = expectedAt.toISOString().replace(/[:.]/g, '-');
  const at = expectedAt.toISOString();
  const meta: RunMeta = {
    jobName: job.name,
    runId,
    agent: job.agent,
    workflow: job.workflow,
    command: job.command,
    pid: null,
    status: 'missed',
    startedAt: at,
    completedAt: at,
    exitCode: null,
    errorMessage: 'scheduled fire missed — the scheduler was not running when it came due',
    actor: job.actor,
  };
  writeRunMeta(meta);
  return meta;
}

export interface CatchupOptions {
  /** Record misses but start no late runs. Powers `catchup --dry-run`. */
  dryRun?: boolean;
  /** Clock injection seam for tests. */
  now?: Date;
  /** Overdue set to act on. Defaults to detecting it. Lets a caller reuse a scan. */
  overdue?: OverdueJob[];
}

/**
 * Record — and, unless opted out, re-run — every routine this device missed.
 *
 * Device scoping is already enforced upstream: `detectOverdueJobs` skips a job
 * pinned elsewhere (overdue.ts), so a fleet of machines never all catch up the
 * same routine.
 */
export async function runCatchup(opts: CatchupOptions = {}): Promise<CatchupOutcome[]> {
  const overdue = opts.overdue ?? detectOverdueJobs(opts.now ?? new Date());
  const outcomes: CatchupOutcome[] = [];

  for (const entry of overdue) {
    const config = readJob(entry.name);
    if (!config) {
      outcomes.push({
        name: entry.name,
        expectedAt: entry.expectedAt,
        result: 'error',
        error: 'config not found',
      });
      continue;
    }

    // Record first: if the late run fails to spawn, the miss is still on record
    // and the same fire is not reconsidered on the next tick.
    recordMissedFire(config, entry.expectedAt);

    if (!shouldCatchUp(config) || opts.dryRun) {
      outcomes.push({ name: entry.name, expectedAt: entry.expectedAt, result: 'recorded' });
      continue;
    }

    try {
      const meta = await executeJobDetached(config);
      outcomes.push({
        name: entry.name,
        expectedAt: entry.expectedAt,
        result: 'ran',
        runId: meta.runId,
      });
    } catch (err) {
      outcomes.push({
        name: entry.name,
        expectedAt: entry.expectedAt,
        result: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return outcomes;
}
