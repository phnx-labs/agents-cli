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
 * the throttle. Measured 75 minutes apart, the box never got out: `retry-after`
 * 2678s at 08:42Z, still 429 at 09:57Z on a freshly-issued 1208s penalty. Its
 * usage cache froze — exactly the permanently-stale state the routing freshness
 * rule (`rotate.ts`, `USAGE_DECISION_MAX_AGE_MS`) was written to defend against.
 *
 * So a 429 is recorded here with its deadline, and every usage read and health
 * probe for that provider short-circuits until the deadline passes — no request,
 * no renewed penalty. State is on disk rather than in memory because the
 * offenders are separate processes: the long-lived daemon, and every one-shot
 * `agents view` / `agents run` invocation.
 *
 * ## The deadline lives in the FILENAME, and that is the whole design
 *
 * The obvious shape — one JSON document holding `{agent: deadline}` — is
 * read-modify-write, and without a lock two processes recording the same
 * provider can both read the old value and let the SHORTER deadline write last,
 * silently undoing the longer penalty. That is not a theoretical race here: the
 * triggering condition is a batch of concurrent same-provider 429s, which is
 * precisely what the daemon issues, and it can recur on every batch. Reading
 * back and retrying does not fix it either — that only detects a clobber which
 * already landed, and a stale writer can still write after the check.
 *
 * So no shared document. Each penalty is its own file named `<agent>.<deadline>`
 * with empty contents, and a read takes the MAXIMUM deadline across that
 * provider's files. Two concurrent writers create two different files and
 * neither can erase the other, so a shorter deadline cannot displace a longer
 * one — monotonicity is structural rather than argued, and there is no lock to
 * go stale on a path every usage read touches. Elapsed files are swept on read.
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

/**
 * Test seam, mirroring `setKeychainBackendForTest`. The cache dir is resolved
 * from a module-level constant at import time, so overriding `HOME` in a test
 * does NOT redirect this state — it silently writes into the developer's real
 * `~/.agents/.cache/` and parks their own usage reads behind a 45-minute
 * penalty. (It did exactly that once while this was being written.) Returns the
 * previous value so a test can restore it.
 */
let backoffDirOverride: string | null = null;
export function setUsageBackoffDirForTest(dir: string | null): string | null {
  const prev = backoffDirOverride;
  backoffDirOverride = dir;
  return prev;
}

function backoffDir(): string {
  return backoffDirOverride ?? path.join(getCacheDir(), 'usage-backoff');
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

/** Every recorded deadline for `agent`, newest-first. Never throws. */
function deadlinesFor(agent: AgentId): number[] {
  let names: string[];
  try {
    names = fs.readdirSync(backoffDir());
  } catch {
    // No directory yet: nothing is throttled.
    return [];
  }
  const prefix = `${agent}.`;
  const out: number[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const at = Number(name.slice(prefix.length));
    if (Number.isFinite(at)) out.push(at);
  }
  return out;
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
  const deadline = now + Math.min(ms, MAX_BACKOFF_MS);
  try {
    fs.mkdirSync(backoffDir(), { recursive: true });
    // Empty file: the name carries the whole value, so there is no content a
    // concurrent reader could catch half-written, and no document to merge.
    fs.writeFileSync(path.join(backoffDir(), `${agent}.${deadline}`), '');
  } catch {
    // Best-effort. An unwritable cache dir costs the cross-process backoff, not
    // the correctness of this read.
  }
}

/**
 * Epoch ms until which `agent`'s usage endpoint should not be called, or null
 * when it is free — the furthest recorded deadline still in the future, so a
 * concurrently-written shorter one can never pull it in.
 *
 * Sweeps elapsed files while it is here: they can only accumulate at the rate
 * penalties are issued, and this is the one place that already lists them.
 */
export function usageRateLimitedUntil(agent: AgentId, now: number = Date.now()): number | null {
  let latest: number | null = null;
  for (const at of deadlinesFor(agent)) {
    if (at > now) {
      if (latest === null || at > latest) latest = at;
    } else {
      try {
        fs.rmSync(path.join(backoffDir(), `${agent}.${at}`), { force: true });
      } catch {
        /* another process may have swept it already */
      }
    }
  }
  return latest;
}

/** Human-readable remaining backoff, for the error a skipped read returns. */
export function formatBackoffRemaining(untilMs: number, now: number = Date.now()): string {
  const mins = Math.ceil((untilMs - now) / 60_000);
  if (mins <= 1) return 'under a minute';
  if (mins < 60) return `${mins} minutes`;
  const hours = Math.round(mins / 60);
  return hours === 1 ? 'about an hour' : `about ${hours} hours`;
}
