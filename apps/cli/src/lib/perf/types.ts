/** Shared perf sample shape (spool NDJSON + SQLite rows). */

export type PerfKind = 'hook.fire' | 'perf.timing' | 'command.end' | string;

export interface PerfSample {
  tsMs?: number;
  kind: PerfKind;
  label: string;
  durationMs: number;
  /** Full session id — same string as sessions.id when known. */
  sessionId?: string;
  /** First 8 chars of sessionId (sessions.short_id shape). */
  sessionShort?: string;
  agent?: string;
  agentVersion?: string;
  /** Fleet registry name (sessions.machine), preferred over raw hostname. */
  machine?: string;
  hostname?: string;
  actor?: string;
  cwd?: string;
  cache?: string;
  exitCode?: number;
  status?: string;
  metaJson?: string;
}

export interface PerfAggregateRow {
  kind: string;
  label: string;
  n: number;
  p50Ms: number;
  p99Ms: number;
  meanMs: number;
  maxMs: number;
  minMs: number;
  cacheHitPct?: number;
  cacheStalePct?: number;
  cacheMissPct?: number;
  errorCount?: number;
}

export interface AggregateOptions {
  days?: number;
  kinds?: string[];
  label?: string;
  machine?: string;
  agent?: string;
  minN?: number;
}
