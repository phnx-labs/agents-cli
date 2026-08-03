/**
 * Respect a usage endpoint's `Retry-After` instead of hammering through it.
 *
 * The failure this exists to stop, measured on `yosemite-s1` (2026-08-03): every
 * Claude account there returned `429 rate_limit_error` with `retry-after: 2678`
 * — about 45 minutes — while the credentials themselves read healthy
 * (`probeClaudeStatus` → `status=429 token=present`). The daemon warms
 * auth-health every 3 minutes (`daemon.ts`, `setInterval(..., 3 * 60_000)`) and
 * `probeLocalFleetAuth` fans out over every installed version home in one
 * `Promise.all`, so five Claude homes meant five concurrent requests to one
 * endpoint every three minutes — ~100/hour from a single machine. Nothing read
 * `Retry-After`, so each tick fired deep inside the penalty window and re-armed
 * the throttle. The box never recovered, every usage read failed, and its cache
 * froze: exactly the permanently-stale state the routing freshness rule
 * (`rotate.ts`, `USAGE_DECISION_MAX_AGE_MS`) was written to defend against.
 *
 * So a 429 is recorded here with its deadline, and every usage read and health
 * probe for that provider short-circuits until the deadline passes — no request,
 * no renewed penalty. State is on disk rather than in memory because the
 * offenders are separate processes: the long-lived daemon, and every one-shot
 * `agents view` / `agents run` invocation.
 *
 * Deliberately per-provider, not per-account: the endpoint throttles the caller,
 * and the observed 429 hit all five accounts on the box at once. Backing off one
 * account while the others keep firing would not clear the penalty.
 */
import * as fs from 'fs';
import * as path from 'path';

import { getCacheDir } from './state.js';
import type { AgentId } from './types.js';

/** Cap a server-supplied delay so a bad header cannot park a provider forever. */
const MAX_BACKOFF_MS = 60 * 60 * 1000;

interface BackoffFile {
  /** agent id -> epoch ms after which requests may resume. */
  until: Record<string, number>;
}

/**
 * Test seam, mirroring `setKeychainBackendForTest`. The cache dir is resolved
 * from a module-level constant at import time, so overriding `HOME` in a test
 * does NOT redirect this file — it silently writes into the developer's real
 * `~/.agents/.cache/` and parks their own usage reads behind a 45-minute
 * penalty. (It did exactly that once while this was being written.) Returns the
 * previous value so a test can restore it.
 */
let backoffPathOverride: string | null = null;
export function setUsageBackoffPathForTest(p: string | null): string | null {
  const prev = backoffPathOverride;
  backoffPathOverride = p;
  return prev;
}

function backoffPath(): string {
  return backoffPathOverride ?? path.join(getCacheDir(), '.usage-backoff.json');
}

function readBackoff(): BackoffFile {
  try {
    const raw = JSON.parse(fs.readFileSync(backoffPath(), 'utf-8')) as BackoffFile;
    return raw && typeof raw.until === 'object' && raw.until !== null ? raw : { until: {} };
  } catch {
    // Missing or unreadable: no backoff recorded. Never throws — a broken cache
    // file must not take down a usage read.
    return { until: {} };
  }
}

/**
 * Parse a `Retry-After` header. HTTP allows either delta-seconds or an HTTP
 * date; both appear in the wild, so handle both and ignore anything else.
 * Returns milliseconds from `now`, or null when there is nothing usable.
 */
export function parseRetryAfterMs(header: string | null | undefined, now: number = Date.now()): number | null {
  const raw = (header ?? '').trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const ms = Number(raw) * 1000;
    return ms > 0 ? Math.min(ms, MAX_BACKOFF_MS) : null;
  }

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  const ms = at - now;
  return ms > 0 ? Math.min(ms, MAX_BACKOFF_MS) : null;
}

/**
 * Record that `agent`'s usage endpoint threw a 429. `retryAfter` is the raw
 * header; when it is absent or unparseable we still back off for `fallbackMs`,
 * because continuing to poll an endpoint that just said no is what created the
 * loop in the first place.
 */
export function noteUsageRateLimited(
  agent: AgentId,
  retryAfter: string | null | undefined,
  opts?: { now?: number; fallbackMs?: number },
): void {
  const now = opts?.now ?? Date.now();
  const fallbackMs = opts?.fallbackMs ?? 15 * 60 * 1000;
  const ms = parseRetryAfterMs(retryAfter, now) ?? fallbackMs;
  recordDeadline(agent, now + Math.min(ms, MAX_BACKOFF_MS));
}

/**
 * Raise `agent`'s deadline to at least `deadline`, and make that hold across
 * processes.
 *
 * A plain read-modify-write cannot: two processes recording the same provider
 * both read the old value, and the one with the SHORTER deadline can rename
 * last, silently undoing the longer penalty. That is not theoretical here — the
 * triggering condition is a batch of concurrent same-provider requests, which is
 * exactly what the daemon issues. So the write is verified by reading back, and
 * retried when a concurrent writer has lowered it.
 *
 * The value only ever moves forward, so this converges: a loser re-applies, and
 * whoever holds the longest deadline wins. Bounded at three attempts because an
 * unbounded loop on a hot path is a worse failure than a marginally short
 * backoff — after which the residual is one shortened window, self-correcting on
 * the next 429.
 */
function recordDeadline(agent: AgentId, deadline: number): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = readBackoff();
    if ((state.until[agent] ?? 0) >= deadline) return; // already at least this long
    state.until[agent] = deadline;
    writeBackoff(state);
    if ((readBackoff().until[agent] ?? 0) >= deadline) return; // survived
  }
}

/**
 * Write via a temp file + rename so a concurrent reader never sees a truncated
 * JSON document.
 *
 * This is read-modify-write with no lock. For the provider being written that is
 * made safe by `recordDeadline`, which reads back and retries — the deadline
 * only moves forward, so concurrent writers converge on the longest one.
 *
 * What remains unlocked is a *different* provider's entry: two processes
 * recording, say, Claude and Kimi in the same instant can lose one of the two.
 * That is accepted rather than locked — the loser makes one more request on its
 * next tick and records again, a single extra call, while a lock file on a path
 * every usage read touches is a new way to wedge the CLI. What must not happen
 * is a *torn* file, which would make every provider read as free; the rename
 * prevents that.
 */
function writeBackoff(state: BackoffFile): void {
  const target = backoffPath();
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, target);
  } catch {
    // Best-effort. An unwritable cache dir costs us the cross-process backoff,
    // not correctness of this read.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nothing further to do */
    }
  }
}

/**
 * Epoch ms until which `agent`'s usage endpoint should not be called, or null
 * when it is free. An elapsed entry reads as free (and is not rewritten — the
 * next successful read simply stops consulting it).
 */
export function usageRateLimitedUntil(agent: AgentId, now: number = Date.now()): number | null {
  const until = readBackoff().until[agent];
  return typeof until === 'number' && until > now ? until : null;
}

/** Human-readable remaining backoff, for the error a skipped read returns. */
export function formatBackoffRemaining(untilMs: number, now: number = Date.now()): string {
  const mins = Math.ceil((untilMs - now) / 60_000);
  if (mins <= 1) return 'under a minute';
  if (mins < 60) return `${mins} minutes`;
  const hours = Math.round(mins / 60);
  return hours === 1 ? 'about an hour' : `about ${hours} hours`;
}
