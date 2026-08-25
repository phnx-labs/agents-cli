/**
 * Hook profiling — reads `hook.fire` events from the daily JSONL logs that
 * generated shims (see `cache.ts`) emit on every invocation, and aggregates
 * per-hook timing + cache stats.
 *
 * Every hook gets a generated shim now (resolveHookCommand in hooks.ts) —
 * `cache:`, `matches:`, or a bare `matcher:` (e.g. git-guard/rm-guard) are all
 * enough to opt in. The only hooks NOT in this profile are ones with none of
 * the three, since a pure lifecycle hook with nothing to gate/cache/match runs
 * the raw script path with no timing wrapper at all.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getLogsDir } from '../state.js';
import { percentile } from '../percentile.js';

export interface HookProfileRow {
  hook: string;
  n: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  meanMs: number;
  maxMs: number;
  cacheHitPct: number;
  cacheStalePct: number;
  cacheMissPct: number;
  errorCount: number;
  /**
   * Fraction (0-1) of fires with a real crash exit (exit 1 / other nonzero
   * except intentional PreToolUse deny code 2). Exit 2 is blockRate.
   */
  errorRate?: number;
  /**
   * Count of intentional deny/block exits (PreToolUse exit 2). Deny-by-design
   * guards (ask-user-question-guard, git-guard, plan-html-reminder) use this
   * path — not a crash.
   */
  blockCount: number;
  /** Fraction (0-1) of fires with exit code 2 (intentional deny/block). */
  blockRate?: number;
  /** Fraction (0-1) of fires that hit their configured timeout. */
  timeoutRate?: number;
  /** Project key the row is scoped to (see project-key.ts) — set only when
   *  a `--project` filter narrowed the underlying query. */
  project?: string;
}

interface RawFireEvent {
  event?: string;
  hook?: string;
  ms?: number;
  cache?: 'hit' | 'miss' | 'stale-prefetch' | string;
  exit?: number;
}

/**
 * Load every `hook.fire` event from the last `days` daily log files.
 * Lines that aren't JSON or aren't `hook.fire` events are silently skipped —
 * the events log is multiplexed (version.switch, secrets.get, …).
 */
export function loadHookFireEvents(days = 7, logsDir: string = getLogsDir()): RawFireEvent[] {
  if (!fs.existsSync(logsDir)) return [];
  const today = new Date();
  const events: RawFireEvent[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const file = path.join(logsDir, `events-${yyyy}-${mm}-${dd}.jsonl`);
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let parsed: RawFireEvent;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (parsed.event !== 'hook.fire') continue;
      if (typeof parsed.hook !== 'string') continue;
      if (typeof parsed.ms !== 'number') continue;
      events.push(parsed);
    }
  }
  return events;
}

/** Aggregate fire events into a per-hook profile, sorted by p99 desc. */
export function aggregateHookProfile(events: RawFireEvent[]): HookProfileRow[] {
  const byHook = new Map<string, RawFireEvent[]>();
  for (const e of events) {
    if (!e.hook) continue;
    if (!byHook.has(e.hook)) byHook.set(e.hook, []);
    byHook.get(e.hook)!.push(e);
  }

  const rows: HookProfileRow[] = [];
  for (const [hook, evs] of byHook) {
    const sortedMs = evs.map(e => e.ms!).sort((a, b) => a - b);
    const n = evs.length;
    const sum = sortedMs.reduce((a, b) => a + b, 0);
    const hits = evs.filter(e => e.cache === 'hit').length;
    const stale = evs.filter(e => e.cache === 'stale-prefetch').length;
    const misses = evs.filter(e => e.cache === 'miss').length;
    // Exit classes (Claude/Codex PreToolUse convention): 0 allow, 2 deny/block,
    // 1 / other nonzero = real error. Exit 2 is not a crash.
    const blocks = evs.filter(e => e.exit === 2).length;
    const errors = evs.filter(e => typeof e.exit === 'number' && e.exit !== 0 && e.exit !== 2).length;
    rows.push({
      hook,
      n,
      p50Ms: Math.round(percentile(sortedMs, 50)),
      p95Ms: Math.round(percentile(sortedMs, 95)),
      p99Ms: Math.round(percentile(sortedMs, 99)),
      meanMs: Math.round(sum / n),
      maxMs: sortedMs[sortedMs.length - 1],
      cacheHitPct: Math.round((hits / n) * 100),
      cacheStalePct: Math.round((stale / n) * 100),
      cacheMissPct: Math.round((misses / n) * 100),
      errorCount: errors,
      blockCount: blocks,
      ...(errors > 0 ? { errorRate: Math.round((errors / n) * 1000) / 1000 } : {}),
      ...(blocks > 0 ? { blockRate: Math.round((blocks / n) * 1000) / 1000 } : {}),
      // timeoutRate is not derivable here: the daily JSONL a shim writes only
      // covers fires that reached their own trailing printf — an externally
      // enforced timeout (the agent harness killing the process) never gets
      // that far, so this log has no timeout signal at all. The warehouse
      // path (asHookRows in commands/perf.ts) is the one that can see it,
      // via the perf-spool `status:"timeout"` sample OpenCode's generated
      // plugin writes directly (hooks.ts's recordTimeoutSample).
    });
  }

  rows.sort((a, b) => b.p99Ms - a.p99Ms);
  return rows;
}

/** Human-friendly duration: "42ms" / "1.2s" / "12s" / "2m". */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return secs > 0 ? `${mins}m${secs}s` : `${mins}m`;
}

/** Format a row's cache column: `hit:97% miss:3%` or `n/a` when nothing cached. */
export function formatCacheColumn(row: HookProfileRow): string {
  if (row.cacheHitPct + row.cacheStalePct + row.cacheMissPct === 0) return 'n/a';
  const parts: string[] = [];
  if (row.cacheHitPct > 0) parts.push(`hit:${row.cacheHitPct}%`);
  if (row.cacheStalePct > 0) parts.push(`stale:${row.cacheStalePct}%`);
  if (row.cacheMissPct > 0) parts.push(`miss:${row.cacheMissPct}%`);
  return parts.join(' ');
}

export const DEFAULT_SLOW_HOOK_WARN_MS = 2000;
