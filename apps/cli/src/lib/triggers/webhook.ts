/**
 * GitHub webhook trigger receiver for routines.
 *
 * A routine may declare a `trigger` block instead of (or alongside) a cron
 * `schedule` (see `JobConfig.trigger` in `../routines.ts`). This module turns
 * an incoming GitHub webhook into the set of routines it should fire, and
 * dispatches those routines through the exact same path a cron fire uses
 * (`executeJobDetached`).
 *
 * The matching logic (`matchJobsToWebhook`) is a pure, side-effect-free
 * function so it can be unit-tested without a running daemon or http server.
 * The optional http listener (`startWebhookServer`) is a thin adapter over it.
 */

import * as http from 'http';
import type { JobConfig, RunMeta } from '../routines.js';
import { listJobs, jobRunsOnThisDevice } from '../routines.js';
import { executeJobDetached } from '../runner.js';

/**
 * A parsed GitHub webhook: the event name (from the `X-GitHub-Event` HTTP
 * header) plus the decoded JSON body. Kept deliberately loose (`payload` is an
 * arbitrary object) because callers may hand us any of GitHub's event shapes.
 */
export interface GithubWebhook {
  /** The GitHub event name, e.g. `pull_request`, `push`, `issue_comment`. */
  event: string;
  /** The decoded JSON request body. */
  payload: Record<string, unknown>;
}

/** Read `repository.full_name` (`owner/name`) from a webhook payload, if present. */
export function webhookRepo(payload: Record<string, unknown>): string | null {
  const repo = payload?.repository as { full_name?: unknown } | undefined;
  const fullName = repo?.full_name;
  return typeof fullName === 'string' && fullName.length > 0 ? fullName : null;
}

/** Strip a `refs/heads/` (or `refs/tags/`) prefix to the short branch/tag name. */
function shortRef(ref: string): string {
  return ref.replace(/^refs\/(heads|tags)\//, '');
}

/**
 * Extract every candidate branch a webhook payload references, per event type.
 * A trigger's `branch` matches if it equals any of these. Different events
 * carry the branch in different places:
 *   - push:          `ref` (refs/heads/<b>)
 *   - pull_request:  base + head refs of the PR
 *   - workflow_run:  `workflow_run.head_branch`
 *   - issue_comment: no branch (comments aren't branch-scoped)
 */
export function webhookBranches(event: string, payload: Record<string, unknown>): string[] {
  const branches = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.length > 0) branches.add(shortRef(v));
  };

  switch (event) {
    case 'push':
      add(payload.ref);
      break;
    case 'pull_request': {
      const pr = payload.pull_request as { base?: { ref?: unknown }; head?: { ref?: unknown } } | undefined;
      add(pr?.base?.ref);
      add(pr?.head?.ref);
      break;
    }
    case 'workflow_run': {
      const run = payload.workflow_run as { head_branch?: unknown } | undefined;
      add(run?.head_branch);
      break;
    }
    default:
      break;
  }
  return [...branches];
}

/** True when a single job's trigger matches the given webhook. Pure. */
export function jobMatchesWebhook(job: JobConfig, webhook: GithubWebhook): boolean {
  const trigger = job.trigger;
  if (!trigger || trigger.type !== 'github_event') return false;
  if (trigger.event !== webhook.event) return false;

  if (trigger.repo) {
    const repo = webhookRepo(webhook.payload);
    if (!repo || repo.toLowerCase() !== trigger.repo.toLowerCase()) return false;
  }

  if (trigger.branch) {
    const branches = webhookBranches(webhook.event, webhook.payload);
    if (!branches.some((b) => b === trigger.branch)) return false;
  }

  return true;
}

/**
 * Pure matcher: given a set of jobs and an incoming webhook, return the jobs
 * whose `trigger` matches (event + optional repo + optional branch). Jobs
 * without a trigger (schedule-only routines) are never selected — proving
 * time-based jobs are unaffected by webhook delivery.
 */
export function matchJobsToWebhook(jobs: JobConfig[], webhook: GithubWebhook): JobConfig[] {
  return jobs.filter(
    (job) => job.enabled !== false && jobRunsOnThisDevice(job) && jobMatchesWebhook(job, webhook)
  );
}

/** Options for firing webhook-matched jobs (dispatch is injectable for tests). */
export interface FireWebhookOptions {
  /** Job source. Defaults to all persisted routines (`listJobs()`). */
  jobs?: JobConfig[];
  /**
   * How to dispatch a matched job. Defaults to `executeJobDetached` — the SAME
   * path a cron fire uses (see `daemon.ts`). Injectable so tests can assert
   * matching without spawning real agent processes.
   */
  dispatch?: (config: JobConfig) => Promise<RunMeta>;
}

/** Result of firing one matched job. */
export interface FiredJob {
  jobName: string;
  runId: string;
}

/**
 * Match an incoming webhook against the persisted routines and fire each match
 * through the cron dispatch path. Returns one entry per fired job.
 */
export async function fireWebhookJobs(
  webhook: GithubWebhook,
  options: FireWebhookOptions = {},
): Promise<FiredJob[]> {
  const jobs = options.jobs ?? listJobs();
  const dispatch = options.dispatch ?? executeJobDetached;
  const matched = matchJobsToWebhook(jobs, webhook);

  const fired: FiredJob[] = [];
  for (const job of matched) {
    const meta = await dispatch(job);
    fired.push({ jobName: job.name, runId: meta.runId });
  }
  return fired;
}

/** Options for the local webhook http listener. */
export interface WebhookServerOptions {
  port?: number;
  host?: string;
  /** Override the fire options (mainly for tests). */
  fire?: FireWebhookOptions;
  /** Called after each delivery is handled (mainly for tests/observability). */
  onDelivery?: (event: string, fired: FiredJob[]) => void;
}

/**
 * Start a minimal local webhook receiver. POSTs are read as JSON, the GitHub
 * event is taken from the `X-GitHub-Event` header, and matching routines are
 * fired via {@link fireWebhookJobs}. Returns the underlying server so callers
 * can `close()` it. The heavy lifting is the pure matcher above; this is only
 * the transport.
 */
export function startWebhookServer(options: WebhookServerOptions = {}): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('method not allowed');
      return;
    }

    const event = (req.headers['x-github-event'] as string | undefined) ?? '';
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      void (async () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf-8');
          const payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          const fired = await fireWebhookJobs({ event, payload }, options.fire);
          options.onDelivery?.(event, fired);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, fired: fired.map((f) => f.jobName) }));
        } catch (err) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
        }
      })();
    });
  });

  server.listen(options.port ?? 0, options.host ?? '127.0.0.1');
  return server;
}
