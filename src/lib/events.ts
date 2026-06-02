/**
 * Centralized event logging for agents-cli.
 *
 * Structured JSONL logs at ~/.agents/logs/events-YYYY-MM-DD.jsonl
 * with automatic daily rotation and rich metadata for debugging/auditing.
 *
 * Features:
 * - Rich metadata: hostname, platform, arch, pid, timezone
 * - Timing helpers: measure operation duration automatically
 * - Truncation: long inputs/outputs are trimmed with ellipsis
 * - Permissions: logs dir is 0700, files are 0600 (owner-only)
 * - Performance tracking: withTiming() wrapper for any async function
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'node:crypto';

// ─── Constants ────────────────────────────────────────────────────────────────

// Logs live under the cache bucket — they're regenerable telemetry.
const LOGS_DIR = path.join(os.homedir(), '.agents', '.cache', 'logs');

/** Default retention period in days. */
const DEFAULT_RETENTION_DAYS = 7;

/** Default max length for truncated strings. */
const DEFAULT_TRUNCATE_LENGTH = 500;

/** Environment variable to disable event logging. */
const DISABLE_ENV_VAR = 'AGENTS_DISABLE_EVENT_LOG';

/** Check if audit logging is disabled via environment variable. */
function isDisabled(): boolean {
  const val = process.env[DISABLE_ENV_VAR];
  return val === '1' || val === 'true';
}

/** Directory permissions (owner read/write/execute only). */
const DIR_MODE = 0o700;

/** File permissions (owner read/write only). */
const FILE_MODE = 0o600;

// ─── Types ────────────────────────────────────────────────────────────────────

export type EventType =
  // Agent lifecycle
  | 'agent.run.start'
  | 'agent.run.end'
  | 'agent.spawn.start'
  | 'agent.spawn.end'
  // Version management
  | 'version.install'
  | 'version.switch'
  | 'version.remove'
  // Skills
  | 'skill.install'
  | 'skill.remove'
  // Browser
  | 'browser.launch'
  | 'browser.close'
  | 'browser.navigate'
  | 'browser.screenshot'
  // Secrets (no values logged)
  | 'secrets.get'
  | 'secrets.set'
  | 'secrets.delete'
  | 'secrets.rename'
  // Cloud dispatch
  | 'cloud.dispatch'
  | 'cloud.complete'
  // Teams
  | 'teams.create'
  | 'teams.add'
  | 'teams.start'
  | 'teams.complete'
  // Hooks
  | 'hook.fire'
  | 'hook.complete'
  | 'hook.error'
  // Resources
  | 'resource.sync'
  // Commands (CLI entry points)
  | 'command.start'
  | 'command.end'
  // Performance
  | 'perf.timing'
  // Sessions
  | 'session.start'
  | 'session.end'
  // Generic
  | 'error'
  | 'warn'
  | 'info'
  | 'debug';

export interface EventMeta {
  ts: string;
  tz: string;
  tzName: string;
  hostname: string;
  platform: NodeJS.Platform;
  arch: string;
  pid: number;
  ppid: number;
  event: EventType;
}

export interface EventPayload {
  // Identity
  agent?: string;
  version?: string;
  sessionId?: string;

  // Context
  cwd?: string;
  command?: string;
  args?: string[];

  // Input/Output (truncated)
  input?: string;
  output?: string;

  // Prompt is NEVER persisted in raw form — only length + hash.
  // Users paste secrets into prompts; raw retention is a leak.
  prompt_length?: number;
  prompt_sha256?: string;

  // Timing
  durationMs?: number;
  startupMs?: number;

  // Result
  exitCode?: number;
  status?: string;
  error?: string;
  errorStack?: string;

  // Extensible
  [key: string]: unknown;
}

export type EventRecord = EventMeta & EventPayload;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getTimezoneOffset(): string {
  const offset = new Date().getTimezoneOffset();
  const sign = offset <= 0 ? '+' : '-';
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const mins = String(Math.abs(offset) % 60).padStart(2, '0');
  return `${sign}${hours}:${mins}`;
}

function getTimezoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'Unknown';
  }
}

function getLogFilePath(date: Date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return path.join(LOGS_DIR, `events-${yyyy}-${mm}-${dd}.jsonl`);
}

function ensureLogsDir(): void {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true, mode: DIR_MODE });
  } else {
    // Ensure permissions are correct on existing dir
    try {
      fs.chmodSync(LOGS_DIR, DIR_MODE);
    } catch {
      // May fail if not owner
    }
  }
}

// ─── Redaction ────────────────────────────────────────────────────────────────

/**
 * Replace a prompt string with length + short SHA so we can correlate runs
 * without persisting the raw text. Returns the fields to spread into a payload.
 */
export function redactPrompt(prompt: string | null | undefined): { prompt_length?: number; prompt_sha256?: string } {
  if (prompt == null) return {};
  return {
    prompt_length: prompt.length,
    prompt_sha256: createHash('sha256').update(prompt).digest('hex').slice(0, 16),
  };
}

const TOKEN_LIKE = /(sk_(?:live|test)_|pk_(?:live|test)_|ghp_|gho_|ghu_|ghs_|xox[bpars]-|AKIA|ASIA|AIza|Bearer\s+|eyJ[A-Za-z0-9_-]+\.)/i;
const SECRET_PATH = /\/(secrets|credentials|\.env|user\.yaml)\b/i;

/**
 * Mask argv entries that look like tokens or secret paths. Preserves structure
 * for debugging but drops the sensitive substring.
 */
export function redactArgs(args: string[] | undefined): string[] | undefined {
  if (!args) return undefined;
  return args.map(a => {
    if (typeof a !== 'string') return a;
    if (TOKEN_LIKE.test(a) || SECRET_PATH.test(a)) return '[REDACTED]';
    return a;
  });
}

// ─── Truncation ───────────────────────────────────────────────────────────────

/**
 * Truncate a string to maxLength, adding ellipsis if truncated.
 * Returns undefined for null/undefined input.
 */
export function truncate(
  str: string | null | undefined,
  maxLength: number = DEFAULT_TRUNCATE_LENGTH
): string | undefined {
  if (str == null) return undefined;
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

/**
 * Truncate all string values in a payload object.
 */
function truncatePayload(payload: EventPayload, maxLength: number = DEFAULT_TRUNCATE_LENGTH): EventPayload {
  const result: EventPayload = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string') {
      result[key] = truncate(value, maxLength);
    } else if (Array.isArray(value)) {
      // Truncate array to first 10 items, truncate each string item
      result[key] = value.slice(0, 10).map(v =>
        typeof v === 'string' ? truncate(v, maxLength) : v
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ─── Core API ─────────────────────────────────────────────────────────────────

/**
 * Emit a structured event to the daily log file.
 *
 * @param event - The event type
 * @param payload - Event-specific data (agent, version, cwd, etc.)
 */
export function emit(event: EventType, payload: EventPayload = {}): void {
  if (isDisabled()) return;

  try {
    ensureLogsDir();

    const record: EventRecord = {
      ts: new Date().toISOString(),
      tz: getTimezoneOffset(),
      tzName: getTimezoneName(),
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      pid: process.pid,
      ppid: process.ppid,
      event,
      ...truncatePayload(payload),
    };

    const line = JSON.stringify(record) + '\n';
    const logPath = getLogFilePath();
    fs.appendFileSync(logPath, line, { mode: FILE_MODE });

    // Ensure file permissions (appendFileSync doesn't respect mode on existing files)
    try {
      fs.chmodSync(logPath, FILE_MODE);
    } catch {
      // May fail if not owner
    }
  } catch {
    // Silent failure - logging should never break the CLI
  }
}

/**
 * Convenience wrapper for timed operations.
 * Returns a function to call when the operation completes.
 *
 * @example
 * const done = emitStart('agent.run.start', { agent: 'claude' });
 * // ... do work ...
 * done({ exitCode: 0 }); // emits agent.run.end with durationMs
 */
export function emitStart(
  startEvent: EventType,
  payload: EventPayload = {}
): (endPayload?: EventPayload) => void {
  const startTime = Date.now();
  emit(startEvent, payload);

  const endEvent = startEvent.replace('.start', '.end') as EventType;

  return (endPayload: EventPayload = {}) => {
    emit(endEvent, {
      ...payload,
      ...endPayload,
      durationMs: Date.now() - startTime,
    });
  };
}

// ─── Timing Utilities ─────────────────────────────────────────────────────────

/**
 * Measure execution time of a synchronous function.
 * Emits a perf.timing event with the duration.
 *
 * @example
 * const result = time('parse-config', () => parseConfig(path));
 */
export function time<T>(label: string, fn: () => T, payload: EventPayload = {}): T {
  const start = Date.now();
  try {
    const result = fn();
    emit('perf.timing', {
      ...payload,
      label,
      durationMs: Date.now() - start,
      status: 'success',
    });
    return result;
  } catch (err) {
    emit('perf.timing', {
      ...payload,
      label,
      durationMs: Date.now() - start,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Measure execution time of an async function.
 * Emits a perf.timing event with the duration.
 *
 * @example
 * const result = await timeAsync('fetch-data', () => fetchData(url));
 */
export async function timeAsync<T>(
  label: string,
  fn: () => Promise<T>,
  payload: EventPayload = {}
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    emit('perf.timing', {
      ...payload,
      label,
      durationMs: Date.now() - start,
      status: 'success',
    });
    return result;
  } catch (err) {
    emit('perf.timing', {
      ...payload,
      label,
      durationMs: Date.now() - start,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Create a timing context for measuring multiple phases of an operation.
 * Useful for tracking startup time vs execution time.
 *
 * @example
 * const timer = createTimer('agent.run', { agent: 'claude' });
 * // ... setup work ...
 * timer.mark('startup'); // records startup time
 * // ... main work ...
 * timer.end({ exitCode: 0 }); // records total time and emits event
 */
export function createTimer(label: string, payload: EventPayload = {}): {
  mark: (phase: string) => number;
  end: (endPayload?: EventPayload) => void;
  elapsed: () => number;
} {
  const start = Date.now();
  const marks: Record<string, number> = {};

  return {
    mark(phase: string): number {
      const elapsed = Date.now() - start;
      marks[phase] = elapsed;
      return elapsed;
    },
    elapsed(): number {
      return Date.now() - start;
    },
    end(endPayload: EventPayload = {}): void {
      const durationMs = Date.now() - start;
      emit('perf.timing', {
        ...payload,
        ...endPayload,
        label,
        durationMs,
        phases: marks,
      });
    },
  };
}

/**
 * Higher-order function that wraps an async function with timing.
 * The wrapper emits start/end events automatically.
 *
 * @example
 * const timedFetch = withTiming('fetch', fetchData, { service: 'api' });
 * const result = await timedFetch(url);
 */
export function withTiming<Args extends unknown[], R>(
  label: string,
  fn: (...args: Args) => Promise<R>,
  basePayload: EventPayload = {}
): (...args: Args) => Promise<R> {
  return async (...args: Args): Promise<R> => {
    const start = Date.now();
    try {
      const result = await fn(...args);
      emit('perf.timing', {
        ...basePayload,
        label,
        durationMs: Date.now() - start,
        status: 'success',
      });
      return result;
    } catch (err) {
      emit('perf.timing', {
        ...basePayload,
        label,
        durationMs: Date.now() - start,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };
}

// ─── Command Tracking ─────────────────────────────────────────────────────────

/**
 * Emit a command.start event with CLI args.
 * Returns a done() function to emit command.end with duration.
 *
 * @example
 * // At CLI entry point:
 * const done = emitCommand('run', process.argv.slice(2));
 * // ... execute command ...
 * done({ exitCode: 0 });
 */
export function emitCommand(
  command: string,
  args: string[] = [],
  payload: EventPayload = {}
): (endPayload?: EventPayload) => void {
  return emitStart('command.start', {
    ...payload,
    command,
    args: args.slice(0, 20), // Limit args to first 20
    cwd: process.cwd(),
  });
}

// ─── Error Tracking ───────────────────────────────────────────────────────────

/**
 * Emit an error event with full details.
 */
export function emitError(
  err: Error | string,
  payload: EventPayload = {}
): void {
  const error = err instanceof Error ? err : new Error(err);
  emit('error', {
    ...payload,
    error: error.message,
    errorStack: truncate(error.stack, 1000),
  });
}

// ─── Rotation ─────────────────────────────────────────────────────────────────

/**
 * Remove log files older than the retention period.
 * Called lazily on emit or explicitly via CLI.
 *
 * @param retentionDays - Number of days to keep (default 7, from DEFAULT_RETENTION_DAYS)
 * @returns Number of files removed
 */
export function rotate(retentionDays: number = DEFAULT_RETENTION_DAYS): number {
  try {
    if (!fs.existsSync(LOGS_DIR)) return 0;

    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(LOGS_DIR).filter(f => f.startsWith('events-') && f.endsWith('.jsonl'));
    let removed = 0;

    for (const file of files) {
      const match = file.match(/^events-(\d{4})-(\d{2})-(\d{2})\.jsonl$/);
      if (!match) continue;

      const [, yyyy, mm, dd] = match;
      const fileDate = new Date(parseInt(yyyy), parseInt(mm) - 1, parseInt(dd));

      if (fileDate.getTime() < cutoff) {
        fs.unlinkSync(path.join(LOGS_DIR, file));
        removed++;
      }
    }

    return removed;
  } catch {
    return 0;
  }
}

/**
 * Lazy rotation - runs at most once per day per process.
 */
let lastRotationCheck = 0;
export function maybeRotate(): void {
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;

  if (now - lastRotationCheck > oneDayMs) {
    lastRotationCheck = now;
    rotate();
  }
}

// ─── Query ────────────────────────────────────────────────────────────────────

/**
 * Read events from log files within a date range.
 *
 * @param options - Query options
 * @returns Array of event records
 */
export function query(options: {
  startDate?: Date;
  endDate?: Date;
  eventTypes?: EventType[];
  agent?: string;
  command?: string;
  limit?: number;
}): EventRecord[] {
  const { startDate, endDate = new Date(), eventTypes, agent, command, limit } = options;
  const results: EventRecord[] = [];

  if (!fs.existsSync(LOGS_DIR)) return results;

  const files = fs.readdirSync(LOGS_DIR)
    .filter(f => f.startsWith('events-') && f.endsWith('.jsonl'))
    .sort()
    .reverse();

  for (const file of files) {
    const match = file.match(/^events-(\d{4})-(\d{2})-(\d{2})\.jsonl$/);
    if (!match) continue;

    const [, yyyy, mm, dd] = match;
    const fileDate = new Date(parseInt(yyyy), parseInt(mm) - 1, parseInt(dd));

    if (startDate && fileDate < startDate) continue;
    if (endDate && fileDate > endDate) continue;

    const content = fs.readFileSync(path.join(LOGS_DIR, file), 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    for (const line of lines.reverse()) {
      try {
        const record = JSON.parse(line) as EventRecord;

        if (eventTypes && !eventTypes.includes(record.event)) continue;
        if (agent && record.agent !== agent) continue;
        if (command && record.command !== command) continue;

        results.push(record);

        if (limit && results.length >= limit) {
          return results;
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  return results;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

/**
 * Get performance stats for a specific label.
 */
export function getTimingStats(label: string, options: { days?: number } = {}): {
  count: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
} | null {
  const days = options.days ?? 7;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const events = query({
    startDate,
    eventTypes: ['perf.timing'],
  }).filter(e => e.label === label && typeof e.durationMs === 'number');

  if (events.length === 0) return null;

  const durations = events.map(e => e.durationMs as number).sort((a, b) => a - b);
  const sum = durations.reduce((a, b) => a + b, 0);

  return {
    count: durations.length,
    avgMs: Math.round(sum / durations.length),
    minMs: durations[0],
    maxMs: durations[durations.length - 1],
    p50Ms: durations[Math.floor(durations.length * 0.5)],
    p95Ms: durations[Math.floor(durations.length * 0.95)],
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export const LOGS_PATH = LOGS_DIR;
