/**
 * Behavioural facets of a coding session, and the cross-session rollup built from them.
 *
 * This is the engine behind `agents insights`. It answers "how do you work" rather than
 * "what did you spend" (`agents cost`) or "what shipped" (`agents output`), and it is
 * the only surface that splits any of it by the account that produced the work.
 *
 * Everything here is a pure function of a parsed `SessionEvent[]`, so it is testable
 * without a database and cheap to re-run. The expensive part is parsing the transcript,
 * which is why results are cached per session in `session_insights` and recomputed only
 * when the file's (mtime, size) changes — the same staleness contract as `scan_ledger`.
 *
 * Prior art: Claude Code's own `/insights`, which computes a comparable set from
 * `~/.claude/projects` alone. Two deliberate differences:
 *
 *   - It sees ONE account's directory. This reads every indexed session, across every
 *     Claude account and every other harness, and reports them apart.
 *   - It collapses conversation branches before counting. agents-cli is file-per-session
 *     throughout (`discover.ts` keys on the transcript's basename), so session counts
 *     here will read slightly higher than `/insights` on the same machine. Reported as
 *     the raw file count rather than quietly differing.
 */

import type { SessionEvent } from './types.js';
import { computeSummaryStats } from './render.js';
import { classifyFileChanges } from './digest.js';

/** File extension → language label. Mirrors the set `/insights` attributes by. */
const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.rb': 'Ruby', '.java': 'Java',
  '.kt': 'Kotlin', '.swift': 'Swift', '.c': 'C', '.h': 'C', '.cc': 'C++', '.cpp': 'C++',
  '.hpp': 'C++', '.cs': 'C#', '.php': 'PHP', '.sh': 'Shell', '.bash': 'Shell',
  '.zsh': 'Shell', '.fish': 'Shell', '.sql': 'SQL', '.css': 'CSS', '.scss': 'CSS',
  '.html': 'HTML', '.vue': 'Vue', '.svelte': 'Svelte', '.md': 'Markdown',
  '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML',
};

/**
 * Tool-failure categories, matched in order against the result text (lowercased).
 * Substring rules, not judgement calls — the same shape `/insights` uses, so the
 * buckets stay comparable. First match wins; anything unmatched is "Other".
 */
const ERROR_CATEGORIES: ReadonlyArray<readonly [readonly string[], string]> = [
  [['string to replace not found', 'no changes to make'], 'Edit Failed'],
  [['has been modified since', 'modified since read'], 'File Changed'],
  [['exceeds maximum', 'too large', 'too long'], 'File Too Large'],
  [['file not found', 'does not exist', 'no such file'], 'File Not Found'],
  [['rejected', "doesn't want to proceed", 'user doesn’t want'], 'User Rejected'],
  [['exit code', 'command failed', 'error:'], 'Command Failed'],
];

/** Response-gap buckets, in ascending order. Upper bound is exclusive. */
const GAP_BUCKETS: ReadonlyArray<readonly [string, number]> = [
  ['2-10s', 10], ['10-30s', 30], ['30s-1m', 60], ['1-2m', 120],
  ['2-5m', 300], ['5-15m', 900], ['>15m', Infinity],
];

/** Behavioural facets of one session. Serialized as JSON into `session_insights`. */
export interface InsightFacets {
  toolCounts: Record<string, number>;
  /** Per-model assistant turn counts. `/insights` has no model dimension at all. */
  models: Record<string, number>;
  languages: Record<string, number>;
  /** Slash commands the user invoked, by name. */
  slashCommands: Record<string, number>;
  errorCategories: Record<string, number>;
  /** Times the user cut a turn short — the `interrupt` event from parse.ts. */
  interruptions: number;
  /** Seconds between an assistant's last event and the user's next message. */
  responseGaps: number[];
  linesAdded: number;
  linesRemoved: number;
  filesCreated: number;
  filesModified: number;
  filesDeleted: number;
  gitCommits: number;
  gitPushes: number;
  /** 24 slots, local time, indexed by hour of the user's messages. */
  messageHours: number[];
  userTurns: number;
  assistantTurns: number;
  toolCount: number;
  errorCount: number;
}

function emptyFacets(): InsightFacets {
  return {
    toolCounts: {}, models: {}, languages: {}, slashCommands: {}, errorCategories: {},
    interruptions: 0, responseGaps: [], linesAdded: 0, linesRemoved: 0,
    filesCreated: 0, filesModified: 0, filesDeleted: 0, gitCommits: 0, gitPushes: 0,
    messageHours: new Array(24).fill(0), userTurns: 0, assistantTurns: 0,
    toolCount: 0, errorCount: 0,
  };
}

function bump(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

/** Newline count of a string, 0 for empty. Used for Edit/Write line deltas. */
function lineCount(text: unknown): number {
  if (typeof text !== 'string' || text === '') return 0;
  return text.split('\n').length;
}

function categorizeError(text: string): string {
  const lower = text.toLowerCase();
  for (const [needles, label] of ERROR_CATEGORIES) {
    if (needles.some((n) => lower.includes(n))) return label;
  }
  return 'Other';
}

/**
 * Count invocations of a git subcommand in a shell command line.
 *
 * Matches `git commit`, `git -C /repo commit`, and the same again after a `&&`, `||`
 * or `;`, without trying to parse shell. The subcommand must be its own whitespace-
 * separated token, so `git-commit` (a different binary) does not count.
 *
 * Known limitation, shared with the `/insights` implementation this mirrors: a git
 * command quoted inside another command (`echo "run git commit later"`) still counts.
 * Distinguishing that needs a real shell parse, which is not worth it for a rollup.
 */
function countGitOp(command: string, op: string): number {
  const re = new RegExp(`(?:^|[\\s&|;(])git(?:\\s+[^\\s&|;]+)*?\\s+${op}\\b`, 'g');
  return (command.match(re) ?? []).length;
}

/**
 * Compute every behavioural facet of one session from its parsed events.
 *
 * Pure: no I/O, no clock, no filesystem. `timezoneOffsetMinutes` is injected rather
 * than read from the environment so the hour histogram is deterministic in tests and
 * can be re-bucketed for a different display timezone without re-parsing.
 */
export function computeInsightFacets(
  events: SessionEvent[],
  timezoneOffsetMinutes = new Date().getTimezoneOffset(),
): InsightFacets {
  const f = emptyFacets();
  const stats = computeSummaryStats(events);
  f.toolCounts = stats.toolCounts;
  f.userTurns = stats.userTurns;
  f.assistantTurns = stats.assistantTurns;
  f.toolCount = stats.toolCount;
  f.errorCount = stats.errorCount;

  const changes = classifyFileChanges(events);
  for (const c of changes) {
    if (c.op === 'created') f.filesCreated++;
    else if (c.op === 'modified') f.filesModified++;
    else f.filesDeleted++;
    const dot = c.path.lastIndexOf('.');
    if (dot > 0) {
      const lang = LANGUAGE_BY_EXT[c.path.slice(dot).toLowerCase()];
      if (lang) bump(f.languages, lang);
    }
  }

  // Response gap: assistant goes quiet, user speaks again. Bounded below to skip
  // same-instant turn pairs and above to skip an overnight break, matching /insights.
  let lastAssistantTs: number | null = null;

  for (const e of events) {
    const ts = new Date(e.timestamp).getTime();
    const hasTs = !Number.isNaN(ts);

    switch (e.type) {
      case 'interrupt':
        f.interruptions++;
        break;

      case 'usage':
        if (e.model) bump(f.models, e.model);
        break;

      case 'error':
        bump(f.errorCategories, categorizeError(e.content ?? e.output ?? ''));
        break;

      case 'message':
        if (e.role === 'assistant') {
          if (hasTs) lastAssistantTs = ts;
          break;
        }
        if (e.role !== 'user') break;
        if (hasTs) {
          // Local-time hour. parse.ts falls back to `new Date()` for a record with no
          // timestamp; those are indistinguishable here, but they are rare and would
          // only smear the histogram toward the scan time, never invent a session.
          const local = new Date(ts - timezoneOffsetMinutes * 60_000);
          f.messageHours[local.getUTCHours()]++;
          if (lastAssistantTs !== null) {
            const gap = (ts - lastAssistantTs) / 1000;
            if (gap > 2 && gap < 3600) f.responseGaps.push(gap);
          }
        }
        lastAssistantTs = null;
        if (e.slashCommand) bump(f.slashCommands, e.slashCommand);
        break;

      case 'tool_use': {
        if (e._local) break;
        if (hasTs) lastAssistantTs = ts;
        const args = e.args ?? {};
        if (e.tool === 'Edit' || e.tool === 'MultiEdit') {
          f.linesRemoved += lineCount(args.old_string);
          f.linesAdded += lineCount(args.new_string);
          for (const edit of Array.isArray(args.edits) ? args.edits : []) {
            f.linesRemoved += lineCount(edit?.old_string);
            f.linesAdded += lineCount(edit?.new_string);
          }
        } else if (e.tool === 'Write') {
          f.linesAdded += lineCount(args.content);
        }
        if (e.command) {
          f.gitCommits += countGitOp(e.command, 'commit');
          f.gitPushes += countGitOp(e.command, 'push');
        }
        break;
      }

      default:
        if (hasTs && e.role === 'assistant') lastAssistantTs = ts;
    }
  }

  return f;
}

/** Percentile of a numeric sample, nearest-rank. Returns 0 for an empty sample. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Bucket response gaps for display. Returns every bucket, including empty ones. */
export function bucketGaps(gaps: number[]): Array<{ bucket: string; count: number }> {
  const out = GAP_BUCKETS.map(([bucket]) => ({ bucket, count: 0 }));
  for (const g of gaps) {
    for (let i = 0; i < GAP_BUCKETS.length; i++) {
      if (g < GAP_BUCKETS[i][1]) { out[i].count++; break; }
    }
  }
  return out;
}

/** A session's time span, for overlap detection. */
export interface SessionSpan {
  id: string;
  accountKey: string;
  startMs: number;
  endMs: number;
}

/** How much work ran concurrently, and how much of it straddled two accounts. */
export interface OverlapReport {
  /** Pairs of sessions whose spans intersect. */
  overlappingPairs: number;
  /** Of those, pairs belonging to DIFFERENT accounts. */
  crossAccountPairs: number;
  /** Distinct sessions involved in any overlap. */
  sessionsInvolved: number;
}

/**
 * Detect concurrent sessions by interval intersection.
 *
 * This is the metric that makes the account split legible rather than academic: a
 * cross-account overlap is `balanced` rotation actively running two orgs' quota at the
 * same moment. `/insights` has a comparable "multi-clauding" count, but with one
 * account it can only ever report the same-account case.
 *
 * Sweep in start order, keeping only spans that could still intersect, so this is
 * O(n log n + pairs) rather than O(n^2) over ~3k sessions.
 */
export function detectOverlap(spans: SessionSpan[]): OverlapReport {
  const usable = spans
    .filter((s) => Number.isFinite(s.startMs) && Number.isFinite(s.endMs) && s.endMs > s.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  let overlappingPairs = 0;
  let crossAccountPairs = 0;
  const involved = new Set<string>();
  const active: SessionSpan[] = [];

  for (const span of usable) {
    // Drop spans that ended before this one started; they cannot intersect it or
    // anything after it.
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].endMs <= span.startMs) active.splice(i, 1);
    }
    for (const other of active) {
      overlappingPairs++;
      if (other.accountKey !== span.accountKey) crossAccountPairs++;
      involved.add(other.id);
      involved.add(span.id);
    }
    active.push(span);
  }

  return { overlappingPairs, crossAccountPairs, sessionsInvolved: involved.size };
}

/** Merge a session's facets into a running total. */
export function mergeFacets(into: InsightFacets, add: InsightFacets): void {
  for (const [k, v] of Object.entries(add.toolCounts)) bump(into.toolCounts, k, v);
  for (const [k, v] of Object.entries(add.models)) bump(into.models, k, v);
  for (const [k, v] of Object.entries(add.languages)) bump(into.languages, k, v);
  for (const [k, v] of Object.entries(add.slashCommands)) bump(into.slashCommands, k, v);
  for (const [k, v] of Object.entries(add.errorCategories)) bump(into.errorCategories, k, v);
  into.interruptions += add.interruptions;
  into.responseGaps.push(...add.responseGaps);
  into.linesAdded += add.linesAdded;
  into.linesRemoved += add.linesRemoved;
  into.filesCreated += add.filesCreated;
  into.filesModified += add.filesModified;
  into.filesDeleted += add.filesDeleted;
  into.gitCommits += add.gitCommits;
  into.gitPushes += add.gitPushes;
  into.userTurns += add.userTurns;
  into.assistantTurns += add.assistantTurns;
  into.toolCount += add.toolCount;
  into.errorCount += add.errorCount;
  for (let i = 0; i < 24; i++) into.messageHours[i] += add.messageHours[i];
}

/** A fresh zeroed accumulator, for callers folding many sessions together. */
export function newFacetAccumulator(): InsightFacets {
  return emptyFacets();
}

/** Top-N entries of a count map, highest first, ties broken by name for determinism. */
export function topEntries(
  counts: Record<string, number>,
  limit: number,
): Array<{ name: string; count: number }> {
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}
