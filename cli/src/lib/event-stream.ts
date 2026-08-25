/**
 * The unified event reader -- one stream over BOTH operational events
 * (`~/.agents/.history/events/YYYY-MM-DD/` via events.ts: secrets, commands, teams, ...) and
 * agent-semantic events (the per-session activity logs via activity.ts: plans,
 * PRs, worktrees, sub-agents, artifacts). They share one {@link EventType}
 * vocabulary and one {@link EventRecord} shape, so `agents events` and any
 * higher-level feature (a session/project summarizer, RSS) read them together.
 *
 * The two write paths stay separate for efficiency -- operational events append
 * to the locked global log (low frequency), agent events append to lock-free
 * per-session shards (high frequency, one writer each). This module is the
 * single READ surface that merges them; nothing here writes.
 */
import { query, type EventRecord, type EventType, type EventLevel, levelFor } from './feed/events.js';
import { readActivityAsEventRecords } from './feed/activity.js';
import { applyFamilies, type EventFamily } from './event-families.js';

export interface UnifiedQuery {
  startDate?: Date;
  endDate?: Date;
  eventTypes?: EventType[];
  /** Drop these event kinds after read (used by --exclude commands / runs). */
  excludeEventTypes?: EventType[];
  level?: EventLevel;
  /** Drop this level (used by --exclude security). */
  excludeLevel?: EventLevel;
  agent?: string;
  /** Only events stamped with this session id (payload `sessionId`, the provenance floor). */
  sessionId?: string;
  /** Only events carrying this bundle name in their payload (e.g. secrets events).
   * Combined with `sessionId`, answers "which session read this secrets bundle". */
  bundle?: string;
  caller?: string;
  command?: string;
  module?: string;
  limit?: number;
  /** Include agent-semantic activity events. Default true. */
  includeActivity?: boolean;
  /** Override the activity dir (tests). */
  activityRoot?: string;
  /** Sessions-style family filters (resolved via applyFamilies). */
  includeFamilies?: EventFamily[];
  excludeFamilies?: EventFamily[];
}

/** Apply the same filters query() applies, to an activity-derived record. */
function matches(r: EventRecord, q: UnifiedQuery): boolean {
  const ms = Date.parse(r.ts);
  // Mirror query()'s default upper bound (endDate = now) so both sources drop
  // future-dated records identically -- keeps the two in exact filter parity.
  const endMs = (q.endDate ?? new Date()).getTime();
  if (q.startDate && !Number.isNaN(ms) && ms < q.startDate.getTime()) return false;
  if (!Number.isNaN(ms) && ms > endMs) return false;
  if (q.eventTypes && !q.eventTypes.includes(r.event)) return false;
  if (q.excludeEventTypes?.includes(r.event)) return false;
  const lvl = r.level ?? levelFor(r.event);
  if (q.level && lvl !== q.level) return false;
  if (q.excludeLevel && lvl === q.excludeLevel) return false;
  if (q.agent && r.agent !== q.agent) return false;
  if (q.sessionId && r.sessionId !== q.sessionId) return false;
  if (q.bundle && r.bundle !== q.bundle) return false;
  if (q.caller && r.caller !== q.caller) return false;
  if (q.command && r.command !== q.command &&
      !(typeof r.command === 'string' && r.command.startsWith(q.command + ' '))) return false;
  if (q.module && r.module !== q.module) return false;
  return true;
}

/**
 * Read a unified, newest-first event stream. Operational events come from
 * events.ts `query()`; agent-semantic events from the activity logs, normalized
 * to the same record shape and filtered identically. `limit` caps the merged
 * result (each source is fetched up to `limit` *after* its primary filters —
 * eventTypes for activity, eventTypes/module/bundle for ops — so the top-N is
 * exact for those filters).
 */
export function readUnifiedEvents(raw: UnifiedQuery = {}): EventRecord[] {
  const q = applyFamilies(raw);

  // `bundle` is filtered inside query()'s scan (before its limit cutoff) so a
  // matching-bundle record older than the newest-`limit` window is not dropped.
  // Over-fetch when we will post-filter excludeEventTypes / excludeLevel so the
  // top-N is still meaningful after drops.
  const needsPost = Boolean(q.excludeEventTypes?.length || q.excludeLevel);
  const fetchLimit = q.limit === undefined
    ? undefined
    : needsPost
      ? Math.min(q.limit * 4, q.limit + 500)
      : q.limit;

  const ops = query({
    startDate: q.startDate,
    endDate: q.endDate,
    eventTypes: q.eventTypes,
    level: q.level,
    agent: q.agent,
    sessionId: q.sessionId,
    caller: q.caller,
    command: q.command,
    module: q.module,
    bundle: q.bundle,
    limit: fetchLimit,
  }).filter((r) => matches(r, q));

  if (q.includeActivity === false) {
    return typeof q.limit === 'number' ? ops.slice(0, q.limit) : ops;
  }

  // Activity events always stamp module: 'activity'. A non-activity module
  // filter can never match them — skip the activity scan entirely.
  if (q.module != null && q.module !== 'activity') {
    return typeof q.limit === 'number' ? ops.slice(0, q.limit) : ops;
  }

  // Push eventTypes into the activity reader so `limit` is applied AFTER the
  // event-type filter (readRecentActivity already does this for `events`).
  // Without this, a rare match older than the newest-`limit` window of routine
  // churn is silently dropped — the same class of bug as the ops-side bundle
  // pre-filter above (RUSH-2093). Remaining filters (agent, sessionId, …) still
  // run via matches() for fields activity.ts does not pre-filter.
  const acts = readActivityAsEventRecords({
    sinceMs: q.startDate?.getTime(),
    limit: fetchLimit,
    root: q.activityRoot,
    events: q.eventTypes,
  }).filter((r) => matches(r, q));

  const merged = [...ops, ...acts].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  return typeof q.limit === 'number' ? merged.slice(0, q.limit) : merged;
}
