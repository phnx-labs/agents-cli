/**
 * Centralized event logging for agents-cli.
 *
 * Structured JSONL audit log at ~/.agents/events.jsonl with lossless numbered
 * gzip rotation at 10 MB and rich metadata for debugging/auditing.
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
import { gzipSync, gunzipSync } from 'node:zlib';
import { parseSshConnection } from './session/provenance.js';
import { ensureLockTarget, withFileLock } from './fs-atomic.js';
import { getUserAgentsDir } from './state.js';

// ─── Constants ────────────────────────────────────────────────────────────────

// Resolved lazily: events.ts is imported transitively by most CLI surfaces, and
// import itself must stay side-effect free. Tests may override the exact path.
// AGENTS_EVENTS_PATH redirects the sink — a test seam like AGENTS_SECRETS_AGENT_DIR:
// unlike _resetForTest it survives a bare reset AND propagates to CLI subprocesses
// a test spawns, so fixture events can never land in the user's real log (#910).
let _eventsPath: string | undefined;
function eventsPath(): string {
  return (_eventsPath ??= process.env.AGENTS_EVENTS_PATH || path.join(getUserAgentsDir(), 'events.jsonl'));
}

function eventsDir(): string {
  return path.dirname(eventsPath());
}

/** Default retention period in days. */
const DEFAULT_RETENTION_DAYS = 7;

/** Default max length for truncated strings. */
const DEFAULT_TRUNCATE_LENGTH = 500;

/** Gzip rotation threshold in bytes (10 MB). */
const GZIP_ROTATION_BYTES = 10 * 1024 * 1024;

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

export type EventLevel = 'audit' | 'warn' | 'info' | 'debug';

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
  | 'cloud.cancel'
  | 'cloud.message'
  // Teams
  | 'teams.create'
  | 'teams.add'
  | 'teams.start'
  | 'teams.complete'
  | 'teams.disband'
  // Hooks
  | 'hook.fire'
  | 'hook.complete'
  | 'hook.error'
  // MCP
  | 'mcp.add'
  | 'mcp.remove'
  | 'mcp.register'
  // Resources
  | 'resource.sync'
  // Rotation (account/credential)
  | 'rotation.resolved'
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

const AUDIT_EVENTS: ReadonlySet<string> = new Set([
  'command.start', 'command.end',
  'secrets.get', 'secrets.set', 'secrets.delete', 'secrets.rename',
  'teams.create', 'teams.add', 'teams.start', 'teams.complete', 'teams.disband',
  'cloud.dispatch', 'cloud.complete', 'cloud.cancel', 'cloud.message',
  'version.install', 'version.switch', 'version.remove',
  'skill.install', 'skill.remove',
  'mcp.add', 'mcp.remove', 'mcp.register',
  'rotation.resolved',
  'session.start', 'session.end',
]);

export function levelFor(event: EventType): EventLevel {
  if (event === 'warn') return 'warn';
  if (event === 'debug') return 'debug';
  if (AUDIT_EVENTS.has(event)) return 'audit';
  return 'info';
}

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
  level: EventLevel;
  caller: string;
  session?: string;
  osUser: string;
  transport: 'local' | 'ssh';
  sshClientIp?: string;
}

export interface EventPayload {
  // Identity
  agent?: string;
  version?: string;
  sessionId?: string;

  // Context
  cwd?: string;
  /** Top-level command group, e.g. 'teams', 'secrets' — the audit filter key. */
  module?: string;
  /** Full command path, e.g. 'teams create', 'secrets get'. */
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

function ensureLogsDir(): void {
  if (!fs.existsSync(eventsDir())) {
    fs.mkdirSync(eventsDir(), { recursive: true, mode: DIR_MODE });
  } else {
    // Ensure permissions are correct on existing dir
    try {
      fs.chmodSync(eventsDir(), DIR_MODE);
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
const SENSITIVE_ARG_NAME = /password|secret|token|key|api[-_]?key|auth/i;
const SENSITIVE_PAYLOAD_KEY = /password|secret|token|api[-_]?key|auth/i;
const RESERVED_META_KEYS = new Set([
  'ts', 'tz', 'tzName', 'hostname', 'platform', 'arch', 'pid', 'ppid',
  'event', 'level', 'caller', 'session', 'osUser', 'transport', 'sshClientIp',
]);

function promptMarker(value: string): string {
  const { prompt_length, prompt_sha256 } = redactPrompt(value);
  return `[REDACTED prompt length=${prompt_length} sha256=${prompt_sha256}]`;
}

/**
 * Mask argv entries that look like tokens or secret paths. Preserves structure
 * for debugging but drops the sensitive substring.
 */
export function redactArgs(args: string[] | undefined): string[] | undefined {
  if (!args) return undefined;
  const result: string[] = [];
  let redactNext = false;
  let promptNext = false;

  for (const arg of args) {
    if (redactNext) {
      if (arg.startsWith('-')) {
        redactNext = false;
      } else {
        result.push('[REDACTED]');
        redactNext = false;
        continue;
      }
    }
    if (promptNext) {
      if (arg.startsWith('-')) {
        promptNext = false;
      } else {
        result.push(arg.length > 200 ? promptMarker(arg) :
          TOKEN_LIKE.test(arg) || SECRET_PATH.test(arg) ? '[REDACTED]' : arg);
        promptNext = false;
        continue;
      }
    }

    const equals = arg.indexOf('=');
    const flag = equals >= 0 ? arg.slice(0, equals) : arg;
    const value = equals >= 0 ? arg.slice(equals + 1) : undefined;
    if (flag.startsWith('-') && SENSITIVE_ARG_NAME.test(flag)) {
      result.push(value === undefined ? flag : `${flag}=[REDACTED]`);
      redactNext = value === undefined;
      continue;
    }
    if (flag === '--body' || flag === '--value') {
      result.push(value === undefined ? flag : `${flag}=[REDACTED]`);
      redactNext = value === undefined;
      continue;
    }
    if (flag === '--prompt') {
      if (value === undefined) {
        result.push(flag);
        promptNext = true;
      } else {
        const safe = value.length > 200 ? promptMarker(value) :
          TOKEN_LIKE.test(value) || SECRET_PATH.test(value) ? '[REDACTED]' : value;
        result.push(`${flag}=${safe}`);
      }
      continue;
    }
    result.push(TOKEN_LIKE.test(arg) || SECRET_PATH.test(arg) ? '[REDACTED]' : arg);
  }
  return result;
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
function sanitizeNested(value: unknown, key: string, maxLength: number): unknown {
  if (SENSITIVE_PAYLOAD_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    if (TOKEN_LIKE.test(value) || SECRET_PATH.test(value)) return '[REDACTED]';
    return truncate(value, maxLength);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 10).map((item) => sanitizeNested(item, '', maxLength));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      result[nestedKey] = sanitizeNested(nestedValue, nestedKey, maxLength);
    }
    return result;
  }
  return value;
}

function sanitizePayload(payload: EventPayload, maxLength: number = DEFAULT_TRUNCATE_LENGTH): EventPayload {
  const result: EventPayload = {};
  for (const [key, value] of Object.entries(payload)) {
    if (RESERVED_META_KEYS.has(key)) continue;
    if (key === 'args' && Array.isArray(value)) {
      result.args = redactArgs(value.filter((item): item is string => typeof item === 'string'));
      continue;
    }
    if (key.toLowerCase() === 'prompt' && typeof value === 'string') {
      Object.assign(result, redactPrompt(value));
      continue;
    }
    result[key] = sanitizeNested(value, key, maxLength);
  }
  return result;
}

// ─── Caller detection ────────────────────────────────────────────────────────

export interface CallerIdentity {
  kind: string;
  session?: string;
}

const TERMINAL_CALLERS: Readonly<Record<string, string>> = {
  cc: 'claude', cl: 'claude',
  cx: 'codex',
  gx: 'gemini', gm: 'gemini',
  cr: 'cursor',
  oc: 'opencode',
  sh: 'shell',
  ag: 'antigravity',
  gk: 'grok',
};

/** Identify the environment that invoked agents-cli, not the source callsite. */
export function detectCaller(
  env: NodeJS.ProcessEnv = process.env,
  stdoutIsTTY: boolean = Boolean(process.stdout.isTTY),
): CallerIdentity {
  const session = env.AGENT_SESSION_ID?.slice(0, 8) || undefined;
  if (env.CLAUDECODE === '1') return { kind: 'claude-code', ...(session ? { session } : {}) };

  const terminalId = env.AGENT_TERMINAL_ID;
  if (terminalId) {
    const prefix = terminalId.split('-')[0].toLowerCase();
    return { kind: TERMINAL_CALLERS[prefix] ?? 'agent', ...(session ? { session } : {}) };
  }

  return { kind: stdoutIsTTY ? 'terminal' : 'script' };
}

// ─── Audit attribution ────────────────────────────────────────────────────────

interface AuditOrigin {
  osUser: string;
  transport: 'local' | 'ssh';
  sshClientIp?: string;
}

/**
 * Who is running this process and from where. Derived once per process from the
 * OS user and $SSH_CONNECTION (via the same parser the sessions layer uses), then
 * cached — provenance can't change mid-process, so every emit() pays for it once.
 */
let _origin: AuditOrigin | undefined;
function auditOrigin(): AuditOrigin {
  if (_origin) return _origin;
  let osUser = 'unknown';
  try {
    osUser = os.userInfo().username;
  } catch {
    // Container/edge cases where the uid has no passwd entry.
  }
  const ssh = process.env.SSH_CONNECTION ? parseSshConnection(process.env.SSH_CONNECTION) : undefined;
  _origin = {
    osUser,
    transport: ssh ? 'ssh' : 'local',
    ...(ssh ? { sshClientIp: ssh.clientIp } : {}),
  };
  return _origin;
}

// ─── Core API ─────────────────────────────────────────────────────────────────

/**
 * Emit a structured event to the append-only audit log.
 *
 * @param event - The event type
 * @param payload - Event-specific data (agent, version, cwd, etc.)
 */
export function emit(event: EventType, payload: EventPayload = {}): void {
  if (isDisabled()) return;

  try {
    ensureLogsDir();

    const caller = detectCaller();
    const safePayload = sanitizePayload(payload);
    const record: EventRecord = {
      ...safePayload,
      ts: new Date().toISOString(),
      tz: getTimezoneOffset(),
      tzName: getTimezoneName(),
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      pid: process.pid,
      ppid: process.ppid,
      event,
      level: levelFor(event),
      caller: caller.kind,
      ...(caller.session ? { session: caller.session } : {}),
      ...auditOrigin(),
    };

    const line = JSON.stringify(record) + '\n';
    const logPath = eventsPath();
    const isNew = !fs.existsSync(logPath);
    ensureLockTarget(logPath, '', DIR_MODE);
    withFileLock(logPath, () => {
      fs.appendFileSync(logPath, line, { mode: FILE_MODE });

      if (isNew || logPath !== _chmoddedPath) {
        _chmoddedPath = logPath;
        try {
          fs.chmodSync(logPath, FILE_MODE);
        } catch {
          // May fail if not owner
        }
      }

      maybeGzipRotateLocked(logPath);
    });
  } catch {
    // Silent failure - logging should never break the CLI
  }
}

/** Last log path this process chmod'd — avoids a redundant chmod per append. */
let _chmoddedPath: string | undefined;

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

// ─── Gzip rotation ──────────────────────────────────────────────────────────

/** Rotate the active file while its append lock is held. */
function maybeGzipRotateLocked(logPath: string): void {
  const stat = fs.statSync(logPath);
  if (stat.size < GZIP_ROTATION_BYTES) return;

  const raw = fs.readFileSync(logPath);
  const tmpArchive = path.join(eventsDir(), `.events.1.jsonl.gz.${process.pid}.tmp`);
  fs.writeFileSync(tmpArchive, gzipSync(raw), { mode: FILE_MODE });

  try {
    const archives = fs.readdirSync(eventsDir())
      .map((file) => ({ file, match: file.match(/^events\.(\d+)\.jsonl\.gz$/) }))
      .filter((entry): entry is { file: string; match: RegExpMatchArray } => entry.match !== null)
      .map((entry) => ({ file: entry.file, number: Number(entry.match[1]) }))
      .sort((a, b) => b.number - a.number);

    for (const archive of archives) {
      fs.renameSync(
        path.join(eventsDir(), archive.file),
        path.join(eventsDir(), `events.${archive.number + 1}.jsonl.gz`),
      );
    }
    fs.renameSync(tmpArchive, path.join(eventsDir(), 'events.1.jsonl.gz'));
    fs.truncateSync(logPath, 0);
  } catch (err) {
    try { fs.unlinkSync(tmpArchive); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

// ─── Rotation ─────────────────────────────────────────────────────────────────

/**
 * Remove log files older than the retention period.
 * Removes numbered gzip archives whose filesystem mtime exceeds retention.
 *
 * @param retentionDays - Number of days to keep (default 7, from DEFAULT_RETENTION_DAYS)
 * @returns Number of files removed
 */
export function rotate(retentionDays: number = DEFAULT_RETENTION_DAYS): number {
  try {
    if (!fs.existsSync(eventsDir())) return 0;

    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(eventsDir()).filter(f => /^events\.\d+\.jsonl\.gz$/.test(f));
    let removed = 0;

    for (const file of files) {
      const filePath = path.join(eventsDir(), file);
      if (fs.statSync(filePath).mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
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
  level?: EventLevel;
  agent?: string;
  caller?: string;
  command?: string;
  module?: string;
  limit?: number;
}): EventRecord[] {
  const { startDate, endDate = new Date(), eventTypes, level, agent, caller, command, module, limit } = options;
  const results: EventRecord[] = [];

  if (!fs.existsSync(eventsDir())) return results;

  const files: Array<{ path: string; gzip: boolean }> = [];
  if (fs.existsSync(eventsPath())) files.push({ path: eventsPath(), gzip: false });
  const archives = fs.readdirSync(eventsDir())
    .map((file) => ({ file, match: file.match(/^events\.(\d+)\.jsonl\.gz$/) }))
    .filter((entry): entry is { file: string; match: RegExpMatchArray } => entry.match !== null)
    .map((entry) => ({ file: entry.file, number: Number(entry.match[1]) }))
    .sort((a, b) => a.number - b.number);
  for (const archive of archives) {
    files.push({ path: path.join(eventsDir(), archive.file), gzip: true });
  }

  const startMs = startDate?.getTime();
  const endMs = endDate?.getTime();

  for (const file of files) {
    let content: string;
    if (file.gzip) {
      try {
        content = gunzipSync(fs.readFileSync(file.path)).toString('utf-8');
      } catch {
        continue;
      }
    } else {
      content = fs.readFileSync(file.path, 'utf-8');
    }
    const lines = content.trim().split('\n').filter(Boolean);

    for (const line of lines.reverse()) {
      try {
        const record = JSON.parse(line) as EventRecord;

        const recMs = Date.parse(record.ts);
        if (startMs !== undefined && !isNaN(recMs) && recMs < startMs) continue;
        if (endMs !== undefined && !isNaN(recMs) && recMs > endMs) continue;

        if (eventTypes && !eventTypes.includes(record.event)) continue;
        if (level && (record.level ?? levelFor(record.event as EventType)) !== level) continue;
        if (agent && record.agent !== agent) continue;
        if (caller && record.caller !== caller) continue;
        if (command && record.command !== command &&
            !(typeof record.command === 'string' && record.command.startsWith(command + ' '))) continue;
        if (module && record.module !== module) continue;

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

// ─── Stats ───────────────────────────────────────────────────────────────────

export interface EventStats {
  totalEvents: number;
  byLevel: Record<string, number>;
  byEvent: Record<string, number>;
  byModule: Record<string, number>;
  byUser: Record<string, number>;
  fileCount: number;
  totalBytes: number;
}

export function stats(options: { days?: number } = {}): EventStats {
  const days = options.days ?? 7;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const records = query({ startDate, limit: 100_000 });

  const byLevel: Record<string, number> = {};
  const byEvent: Record<string, number> = {};
  const byModule: Record<string, number> = {};
  const byUser: Record<string, number> = {};

  for (const r of records) {
    const lvl = r.level ?? levelFor(r.event as EventType);
    byLevel[lvl] = (byLevel[lvl] ?? 0) + 1;
    byEvent[r.event] = (byEvent[r.event] ?? 0) + 1;
    if (r.module) byModule[r.module] = (byModule[r.module] ?? 0) + 1;
    const user = `${r.osUser ?? '?'}@${r.hostname}`;
    byUser[user] = (byUser[user] ?? 0) + 1;
  }

  let fileCount = 0;
  let totalBytes = 0;
  try {
    if (fs.existsSync(eventsDir())) {
      const files = fs.readdirSync(eventsDir()).filter(f =>
        f === 'events.jsonl' || /^events\.\d+\.jsonl\.gz$/.test(f)
      );
      fileCount = files.length;
      for (const f of files) {
        try {
          totalBytes += fs.statSync(path.join(eventsDir(), f)).size;
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }

  return {
    totalEvents: records.length,
    byLevel,
    byEvent,
    byModule,
    byUser,
    fileCount,
    totalBytes,
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export function getLogsPath(): string {
  return eventsPath();
}

export function _resetForTest(overrideEventsPath?: string): void {
  _eventsPath = overrideEventsPath;
  _origin = undefined;
  _chmoddedPath = undefined;
  lastRotationCheck = 0;
}
