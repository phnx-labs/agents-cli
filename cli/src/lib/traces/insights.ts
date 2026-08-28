/**
 * Cross-session failure clustering + time-wasted attribution for the traces
 * insight engine (PHNX-3141) — the piece that turns per-tool error counts
 * into "here is your #1 systemic problem and what it cost."
 *
 * Pure and SQL-shaped: it consumes the same `SyncRow[]` + `tool_calls` rows
 * `buildIndexShard` already loads (no re-parsing of transcripts), so cost
 * stays proportional to this sync's row count, never the full corpus.
 *
 * `tool_calls` rows carry `ordinal`/`timestamp` per call within a session
 * (`db.ts`'s `idx_tool_calls_session ON tool_calls(session_id, ordinal)`), which
 * is enough to reconstruct per-session call order and inter-call gaps without a
 * full `SessionTrajectory` — that is what makes this incremental at scale.
 *
 * Scope note: `FailureSignature` does not yet carry a `phenotype`
 * (false-termination / out-of-order / …, `phenotype.ts`) — classifying that
 * needs the full derived trajectory (turns, ordered steps, gaps), which is
 * only ever materialized per-session during upload, not cached the way
 * `InsightFacets` is. Folding it in is a real, scoped follow-up (see
 * `cli/AGENTS.md`), not a silent omission.
 */

import { classifyCause, type TraceFailureCause } from './classify.js';
import { computeLatency, type LatencyInsight, type SegmentSession } from './segments.js';
import { failureDescription, type SyncRow, type ToolCallRow, type TracesIndexShard } from './sync.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FailureSignature {
  tool: string;
  cause: TraceFailureCause;
  /** Normalized error text — volatile tokens (ids, counts, countdowns) stripped so instances fold together. */
  key: string;
}

export interface FailurePattern {
  /** Stable hash of the signature — deep-linkable, unaffected by row order. */
  id: string;
  label: string;
  signature: FailureSignature;
  /** Distinct sessions this pattern occurred in. */
  sessions: number;
  /** Total failing calls matching this signature. */
  occurrences: number;
  /** Estimated ms of retry/stall time attributable to this pattern (see attribution rule below). */
  wastedMs: number;
  /** Bounded example session ids for drill-down. */
  exampleSessionIds: string[];
  /** Movement vs the same pattern id in the previous shard. */
  drift: 'up' | 'flat' | 'down';
}

export interface ComputedInsights {
  /** Top-K patterns ranked by wastedMs (impact) — a rare 1-occurrence/8h loop still surfaces. */
  failurePatterns: FailurePattern[];
  /** Sum of wastedMs across every cluster found this sync, not just the top-K rows above. */
  wastedMsTotal: number;
  latency: LatencyInsight;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Bounded shard size — patterns, not sessions, so 738 or 738k render identically. */
const TOP_K_PATTERNS = 25;
const MAX_EXAMPLE_SESSIONS = 5;
/** A gap this long right after a failure reads as an idle stall, not think-time (matches sync.ts's own "stalled Xm" threshold). */
const STALL_MS = 60_000;
/**
 * Upper bound on how much of a LONE post-failure stall (the next call is not a
 * retry of the same failure) is attributable to that failure. Beyond a recovery
 * window, the idle is not failure-loop waste — it is a human away from a chat
 * thread, an abandoned session, or an outage. Real single-tool stalls (a hung
 * typecheck, a slow build) are minutes; async chat gaps and idle sessions are
 * hours. Without a per-call end timestamp we cannot measure the call's own
 * blocking time, so we bound the lone stall instead. Retry LOOPS
 * (nextIsSameFailure) stay uncapped — an active back-off loop is exactly the
 * systemic waste this engine exists to surface. (Fuller fix: persist per-call
 * end timestamps and attribute a call's own duration — PHNX-3423 follow-up.)
 */
const MAX_LONE_STALL_MS = 30 * 60_000;

// ---------------------------------------------------------------------------
// Signature normalization — fold volatile per-instance text together
// ---------------------------------------------------------------------------

const VOLATILE_TOKEN_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bfor user [\w.-]+/gi, replacement: 'for user _' },
  { pattern: /\btry again in [\w.]+s?\b/gi, replacement: 'try again in _s' },
  { pattern: /\b[0-9a-f]{7,40}\b/gi, replacement: '_sha_' },
  { pattern: /\b[\w.-]+@[\w.-]+\.\w+\b/gi, replacement: '_email_' },
  { pattern: /\b\d+\b/g, replacement: '_n_' },
];

/** Strip volatile tokens from a failure's evidence text so repeat instances hash identically. */
export function normalizeErrorKey(desc: string, raw: string | null): string {
  let text = (raw && raw.trim().length > 0 ? raw : desc).toLowerCase();
  for (const { pattern, replacement } of VOLATILE_TOKEN_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function hashSignature(tool: string, cause: string, key: string): string {
  const input = `${tool} ${cause} ${key}`;
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Label rules — a table, not an if/else-by-name chain (matches segments.ts's TASK_TYPE_RULES)
// ---------------------------------------------------------------------------

const LABEL_RULES: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /rate limit/i, label: 'rate limit back-off loop' },
  { pattern: /permission denied/i, label: 'permission denied' },
  { pattern: /not found|no such file/i, label: 'missing resource' },
  { pattern: /timed? ?out/i, label: 'timeout' },
  { pattern: /econnrefused|connection refused|network/i, label: 'network error' },
  { pattern: /conflict|diverged/i, label: 'git conflict' },
];

function labelFor(tool: string, cause: TraceFailureCause, key: string): string {
  if (cause === 'guard') return `${tool}: git guard denial`;
  if (cause === 'hook') return `${tool}: hook denial`;
  const rule = LABEL_RULES.find((row) => row.pattern.test(key));
  return `${tool}: ${rule ? rule.label : key.slice(0, 48)}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Cluster failed tool calls into ranked patterns and estimate the wasted time
 * behind each, plus device-wide time-to-first-tool latency.
 *
 * wastedMs attribution: the gap between a failed call and the NEXT call in the
 * same session counts as wasted when either (a) the next call repeats the same
 * signature (a retry loop) — counted in full, or (b) the gap is a stall (≥60s)
 * before an unrelated next call — counted up to MAX_LONE_STALL_MS. The bound on
 * (b) stops a single failure from absorbing hours of human-away idle in an async
 * channel session (a Slack thread the user replies to hours later), which the raw
 * ≥60s rule mis-booked as failure-loop waste. An idle gap unrelated to a nearby
 * failure is never counted. This is an estimate, not ground truth; it is not
 * inflated by folding in ordinary processing time between unrelated calls.
 */
export function computeInsights(
  rows: readonly SyncRow[],
  calls: readonly ToolCallRow[],
  prevShard?: TracesIndexShard | null,
): ComputedInsights {
  const bySession = new Map<string, ToolCallRow[]>();
  for (const call of calls) {
    const list = bySession.get(call.session_id);
    if (list) list.push(call);
    else bySession.set(call.session_id, [call]);
  }

  interface Accum {
    tool: string;
    cause: TraceFailureCause;
    key: string;
    sessions: Set<string>;
    occurrences: number;
    wastedMs: number;
    examples: string[];
  }
  const groups = new Map<string, Accum>();

  for (const [sessionId, sessionCalls] of bySession) {
    const ordered = [...sessionCalls].sort((a, b) => a.ordinal - b.ordinal);
    for (let i = 0; i < ordered.length; i++) {
      const call = ordered[i];
      if (call.outcome !== 'error') continue;
      const cause = classifyCause(call);
      const key = normalizeErrorKey(failureDescription(call, cause), call.error);
      const groupKey = `${call.tool} ${cause} ${key}`;

      let group = groups.get(groupKey);
      if (!group) {
        group = { tool: call.tool, cause, key, sessions: new Set(), occurrences: 0, wastedMs: 0, examples: [] };
        groups.set(groupKey, group);
      }
      group.occurrences++;
      group.sessions.add(sessionId);
      if (group.examples.length < MAX_EXAMPLE_SESSIONS && !group.examples.includes(sessionId)) {
        group.examples.push(sessionId);
      }

      const next = ordered[i + 1];
      if (!next) continue;
      const gapMs = Date.parse(next.timestamp) - Date.parse(call.timestamp);
      if (!Number.isFinite(gapMs) || gapMs <= 0) continue;
      const nextIsSameFailure =
        next.outcome === 'error' &&
        next.tool === call.tool &&
        classifyCause(next) === cause &&
        normalizeErrorKey(failureDescription(next, cause), next.error) === key;
      if (nextIsSameFailure) {
        // Active retry loop: the whole inter-retry gap is real, agent-driven waste.
        group.wastedMs += gapMs;
      } else if (gapMs >= STALL_MS) {
        // Lone stall: attribute only a bounded recovery window — beyond it the
        // idle is human-away / abandoned, not failure-loop waste (see MAX_LONE_STALL_MS).
        group.wastedMs += Math.min(gapMs, MAX_LONE_STALL_MS);
      }
    }
  }

  const prevById = new Map((prevShard?.failurePatterns ?? []).map((p) => [p.id, p]));
  const allPatterns: FailurePattern[] = [...groups.values()].map((group) => {
    const id = hashSignature(group.tool, group.cause, group.key);
    const prev = prevById.get(id);
    const drift: FailurePattern['drift'] = !prev
      ? 'up'
      : group.occurrences > prev.occurrences
        ? 'up'
        : group.occurrences < prev.occurrences
          ? 'down'
          : 'flat';
    return {
      id,
      label: labelFor(group.tool, group.cause, group.key),
      signature: { tool: group.tool, cause: group.cause, key: group.key },
      sessions: group.sessions.size,
      occurrences: group.occurrences,
      wastedMs: group.wastedMs,
      exampleSessionIds: group.examples,
      drift,
    };
  });

  const wastedMsTotal = allPatterns.reduce((sum, p) => sum + p.wastedMs, 0);
  const failurePatterns = [...allPatterns]
    .sort((a, b) => b.wastedMs - a.wastedMs || b.occurrences - a.occurrences || a.id.localeCompare(b.id))
    .slice(0, TOP_K_PATTERNS);

  const latency = computeLatency(firstToolSegments(rows, bySession));
  return { failurePatterns, wastedMsTotal, latency };
}

/** Synthesize one-step SegmentSessions carrying only the time-to-first-tool offset, for computeLatency() reuse. */
function firstToolSegments(
  rows: readonly SyncRow[],
  bySession: Map<string, ToolCallRow[]>,
): SegmentSession[] {
  return rows.flatMap((row): SegmentSession[] => {
    const sessionCalls = bySession.get(row.id);
    if (!sessionCalls || sessionCalls.length === 0) return [];
    const first = sessionCalls.reduce((min, call) => (call.ordinal < min.ordinal ? call : min));
    const sessionStartMs = Date.parse(row.timestamp);
    const firstCallMs = Date.parse(first.timestamp);
    if (!Number.isFinite(sessionStartMs) || !Number.isFinite(firstCallMs)) return [];
    return [{ steps: [{ startMs: Math.max(0, firstCallMs - sessionStartMs) }] }];
  });
}
