/**
 * The unified event reader -- one stream over BOTH operational events
 * (`~/.agents/events.jsonl` via events.ts: secrets, commands, teams, ...) and
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
import { query, type EventRecord, type EventType, type EventLevel, levelFor } from './events.js';
import { readActivityAsEventRecords } from './activity.js';

export interface UnifiedQuery {
  startDate?: Date;
  endDate?: Date;
  eventTypes?: EventType[];
  level?: EventLevel;
  agent?: string;
  caller?: string;
  command?: string;
  module?: string;
  limit?: number;
  /** Include agent-semantic activity events. Default true. */
  includeActivity?: boolean;
  /** Override the activity dir (tests). */
  activityRoot?: string;
}

/** Apply the same filters query() applies, to an activity-derived record. */
function matches(r: EventRecord, q: UnifiedQuery): boolean {
  const ms = Date.parse(r.ts);
  if (q.startDate && !Number.isNaN(ms) && ms < q.startDate.getTime()) return false;
  if (q.endDate && !Number.isNaN(ms) && ms > q.endDate.getTime()) return false;
  if (q.eventTypes && !q.eventTypes.includes(r.event)) return false;
  if (q.level && (r.level ?? levelFor(r.event)) !== q.level) return false;
  if (q.agent && r.agent !== q.agent) return false;
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
 * result (each source is fetched up to `limit`, so the top-N is exact).
 */
export function readUnifiedEvents(q: UnifiedQuery = {}): EventRecord[] {
  const ops = query({
    startDate: q.startDate,
    endDate: q.endDate,
    eventTypes: q.eventTypes,
    level: q.level,
    agent: q.agent,
    caller: q.caller,
    command: q.command,
    module: q.module,
    limit: q.limit,
  });

  if (q.includeActivity === false) return ops;

  const acts = readActivityAsEventRecords({
    sinceMs: q.startDate?.getTime(),
    limit: q.limit,
    root: q.activityRoot,
  }).filter((r) => matches(r, q));

  const merged = [...ops, ...acts].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  return typeof q.limit === 'number' ? merged.slice(0, q.limit) : merged;
}
