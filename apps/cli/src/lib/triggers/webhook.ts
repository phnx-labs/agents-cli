/**
 * Public webhook trigger receiver for routines.
 *
 * A routine may declare a `trigger` block instead of (or alongside) a cron
 * `schedule` (see `JobConfig.trigger` in `../routines.ts`). This module turns
 * incoming GitHub or Linear webhooks into the set of routines they should fire,
 * and dispatches those routines through the exact same path a cron fire uses
 * (`executeJobDetached`).
 *
 * The matching logic is pure, so it can be unit-tested without a daemon or HTTP
 * server. The listener adds the public-ingress requirements: raw-body HMAC
 * verification, idempotency, source allow-listing, and rate limiting.
 */

import * as crypto from 'crypto';
import * as http from 'http';
import type { IncomingHttpHeaders } from 'http';
import type {
  GithubJobTrigger,
  JobConfig,
  LinearJobTrigger,
  RunMeta,
} from '../routines.js';
import { jobRunsOnThisDevice, listJobs } from '../routines.js';
import { executeJobDetached } from '../runner.js';

export type WebhookSource = 'github' | 'linear';

export interface IncomingWebhook {
  /** Delivery source, derived from `/hooks/<source>` or one-shot command flags. */
  source: WebhookSource;
  /** Source event name: GitHub header event or Linear payload `type`. */
  event: string;
  /** Decoded JSON request body. */
  payload: Record<string, unknown>;
}

export type GithubWebhook = IncomingWebhook & { source: 'github' };
export type LinearWebhook = IncomingWebhook & { source: 'linear' };

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

function linearAction(payload: Record<string, unknown>): string | null {
  return typeof payload.action === 'string' ? payload.action : null;
}

function linearTeamKey(payload: Record<string, unknown>): string | null {
  const data = payload.data as Record<string, unknown> | undefined;
  const identifier = data?.identifier;
  if (typeof identifier === 'string') {
    const match = /^([A-Z][A-Z0-9]*)-\d+$/.exec(identifier);
    if (match) return match[1];
  }
  const team = data?.team as { key?: unknown } | undefined;
  return typeof team?.key === 'string' ? team.key : null;
}

function linearLabels(payload: Record<string, unknown>): string[] {
  const data = payload.data as Record<string, unknown> | undefined;
  const labels = data?.labels as { nodes?: unknown } | undefined;
  const nodes = Array.isArray(labels?.nodes) ? labels.nodes : [];
  return nodes
    .map((n) => (n as { name?: unknown }).name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
}

function githubTriggerMatches(trigger: GithubJobTrigger, webhook: IncomingWebhook): boolean {
  if (webhook.source !== 'github') return false;
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

function linearTriggerMatches(trigger: LinearJobTrigger, webhook: IncomingWebhook): boolean {
  if (webhook.source !== 'linear') return false;
  if (trigger.event !== webhook.event) return false;
  if (trigger.action && linearAction(webhook.payload) !== trigger.action) return false;
  if (trigger.teamKey && linearTeamKey(webhook.payload) !== trigger.teamKey) return false;
  if (trigger.label) {
    const expected = trigger.label.toLowerCase();
    if (!linearLabels(webhook.payload).some((name) => name.toLowerCase() === expected)) return false;
  }
  return true;
}

/** True when a single job's trigger matches the given webhook. Pure. */
export function jobMatchesWebhook(job: JobConfig, webhook: IncomingWebhook): boolean {
  const trigger = job.trigger;
  if (!trigger) return false;
  if (trigger.type === 'github_event') return githubTriggerMatches(trigger, webhook);
  if (trigger.type === 'linear_event') return linearTriggerMatches(trigger, webhook);
  return false;
}

/**
 * Pure matcher: given a set of jobs and an incoming webhook, return the jobs
 * whose `trigger` matches. Jobs without a trigger (schedule-only routines) are
 * never selected — proving time-based jobs are unaffected by webhook delivery.
 */
export function matchJobsToWebhook(jobs: JobConfig[], webhook: IncomingWebhook): JobConfig[] {
  return jobs.filter((job) => job.enabled !== false && jobRunsOnThisDevice(job) && jobMatchesWebhook(job, webhook));
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

export class WebhookDispatchError extends Error {
  constructor(
    message: string,
    readonly fired: FiredJob[],
    readonly failures: { jobName: string; error: Error }[],
  ) {
    super(message);
    this.name = 'WebhookDispatchError';
  }
}

/**
 * Match an incoming webhook against the persisted routines and fire each match
 * through the cron dispatch path. Returns one entry per fired job.
 */
export async function fireWebhookJobs(
  webhook: IncomingWebhook,
  options: FireWebhookOptions = {},
): Promise<FiredJob[]> {
  const jobs = options.jobs ?? listJobs();
  const dispatch = options.dispatch ?? executeJobDetached;
  const matched = matchJobsToWebhook(jobs, webhook);

  const fired: FiredJob[] = [];
  const failures: { jobName: string; error: Error }[] = [];
  for (const job of matched) {
    try {
      const meta = await dispatch(job);
      fired.push({ jobName: job.name, runId: meta.runId });
    } catch (err) {
      failures.push({ jobName: job.name, error: err as Error });
    }
  }
  if (failures.length > 0) {
    throw new WebhookDispatchError(
      `failed to dispatch ${failures.length} webhook routine(s): ${failures.map((f) => f.jobName).join(', ')}`,
      fired,
      failures,
    );
  }
  return fired;
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function timingSafeHexEqual(received: string | undefined, expected: string): boolean {
  if (!received || !/^[a-f0-9]+$/i.test(received)) return false;
  const a = Buffer.from(received, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hmacHex(secret: string, rawBody: Buffer): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function verifyGithubSignature(headers: IncomingHttpHeaders, rawBody: Buffer, secret: string): boolean {
  const received = header(headers, 'x-hub-signature-256');
  const signature = received?.startsWith('sha256=') ? received.slice('sha256='.length) : undefined;
  return timingSafeHexEqual(signature, hmacHex(secret, rawBody));
}

export function verifyLinearSignature(headers: IncomingHttpHeaders, rawBody: Buffer, secret: string): boolean {
  return timingSafeHexEqual(header(headers, 'linear-signature'), hmacHex(secret, rawBody));
}

export function verifyLinearTimestamp(payload: Record<string, unknown>, now = Date.now(), toleranceMs = 60_000): boolean {
  const ts = payload.webhookTimestamp;
  return typeof ts === 'number' && Math.abs(now - ts) <= toleranceMs;
}

export interface WebhookSecrets {
  github?: string;
  linear?: string;
}

export interface DeliveryStore {
  seen(id: string): boolean;
  mark(id: string): void;
}

export function createMemoryDeliveryStore(maxEntries = 1000): DeliveryStore {
  const seen = new Map<string, number>();
  return {
    seen: (id) => seen.has(id),
    mark: (id) => {
      seen.set(id, Date.now());
      while (seen.size > maxEntries) {
        const oldest = seen.keys().next().value as string | undefined;
        if (!oldest) break;
        seen.delete(oldest);
      }
    },
  };
}

export interface RateLimiter {
  take(key: string): boolean;
}

export function createMemoryRateLimiter(limit: number, windowMs: number): RateLimiter {
  const buckets = new Map<string, { resetAt: number; count: number }>();
  return {
    take: (key) => {
      const now = Date.now();
      const current = buckets.get(key);
      if (!current || now >= current.resetAt) {
        buckets.set(key, { resetAt: now + windowMs, count: 1 });
        return true;
      }
      if (current.count >= limit) return false;
      current.count += 1;
      return true;
    },
  };
}

function deliveryId(source: WebhookSource, headers: IncomingHttpHeaders, rawBody: Buffer): string {
  const named = source === 'github'
    ? header(headers, 'x-github-delivery')
    : header(headers, 'linear-delivery');
  return `${source}:${named ?? crypto.createHash('sha256').update(rawBody).digest('hex')}`;
}

function sourceFromPath(pathname: string | undefined): WebhookSource | null {
  const match = /^\/hooks\/(github|linear)\/?$/.exec(pathname ?? '');
  return match ? match[1] as WebhookSource : null;
}

async function readRawBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new Error(`payload exceeds ${maxBytes} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Options for the local webhook http listener. */
export interface WebhookServerOptions {
  port?: number;
  host?: string;
  /** HMAC signing secrets keyed by source. */
  secrets: WebhookSecrets;
  /** Override the fire options (mainly for tests). */
  fire?: FireWebhookOptions;
  /** Called after each delivery is handled (mainly for tests/observability). */
  onDelivery?: (webhook: IncomingWebhook, fired: FiredJob[]) => void;
  deliveryStore?: DeliveryStore;
  rateLimiter?: RateLimiter;
  rateLimitPerMinute?: number;
  maxBodyBytes?: number;
}

/**
 * Start a localhost-bound receiver. It accepts only:
 *   POST /hooks/github  with X-Hub-Signature-256
 *   POST /hooks/linear  with Linear-Signature + fresh webhookTimestamp
 *
 * Returns the underlying server so callers can `close()` it.
 */
export function startWebhookServer(options: WebhookServerOptions): http.Server {
  const deliveryStore = options.deliveryStore ?? createMemoryDeliveryStore();
  const rateLimiter = options.rateLimiter ?? createMemoryRateLimiter(options.rateLimitPerMinute ?? 60, 60_000);
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;

  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain' });
        res.end('method not allowed');
        return;
      }

      const source = sourceFromPath(req.url?.split('?')[0]);
      if (!source) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }

      const secret = options.secrets[source];
      if (!secret) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `missing ${source} webhook secret` }));
        return;
      }

      try {
        const rawBody = await readRawBody(req, maxBodyBytes);
        const valid = source === 'github'
          ? verifyGithubSignature(req.headers, rawBody, secret)
          : verifyLinearSignature(req.headers, rawBody, secret);
        if (!valid) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid signature' }));
          return;
        }

        const id = deliveryId(source, req.headers, rawBody);
        if (deliveryStore.seen(id)) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, duplicate: true, fired: [] }));
          return;
        }

        const payload = rawBody.length > 0 ? JSON.parse(rawBody.toString('utf-8')) as Record<string, unknown> : {};
        if (source === 'linear' && !verifyLinearTimestamp(payload)) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'stale linear webhook timestamp' }));
          return;
        }

        if (!rateLimiter.take(source)) {
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'rate limit exceeded' }));
          return;
        }

        const webhook: IncomingWebhook = {
          source,
          event: source === 'github' ? (header(req.headers, 'x-github-event') ?? '') : String(payload.type ?? ''),
          payload,
        };
        const fired = await fireWebhookJobs(webhook, options.fire);
        deliveryStore.mark(id);
        options.onDelivery?.(webhook, fired);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, fired: fired.map((f) => f.jobName), runs: fired }));
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
    })();
  });

  server.listen(options.port ?? 0, options.host ?? '127.0.0.1');
  return server;
}
