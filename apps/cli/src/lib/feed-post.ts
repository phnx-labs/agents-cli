/**
 * Agent status posts — deliberate progress messages into the activity stream.
 *
 * Surface: `agents feed post <text>` (agent-callable; humans watch via
 * `agents feed` / `agents activity` / `agents events --module activity`).
 *
 * Identity is automatic: session id, agent, cwd, launch/pid/tmux provenance
 * are resolved from the process environment and the per-pid launch registry
 * (`lib/session/pid-registry.ts`). The agent only authors free-form text —
 * no domain-specific flags (tickets, URLs, tracks).
 *
 * Storage: append-only activity log as a `status.posted` milestone. Does NOT
 * open a feed block (blocks remain "needs you" state only).
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  appendActivityEvent,
  type ActivityEvent,
} from './activity.js';
import { machineId } from './machine-id.js';
import { isValidMailboxId } from './mailbox.js';
import {
  listPidSessionEntries,
  readPidSessionEntry,
  type PidSessionEntry,
} from './session/pid-registry.js';

/** Soft cap so a runaway agent can't flood the activity lane with essays. */
export const STATUS_POST_MAX_CHARS = 500;

export interface FeedPostInput {
  /** Human-readable progress text (required). Domain-agnostic free text. */
  text: string;
  /** Override session id (escape hatch for scripts/tests). Prefer auto-resolve. */
  sessionId?: string;
  /** Override activity root (tests). */
  activityRoot?: string;
  /** Override env for identity resolution (tests). */
  env?: NodeJS.ProcessEnv;
  /** Override cwd stamp (defaults to process.cwd() / env). */
  cwd?: string;
  /** Fixed timestamp (tests). */
  ts?: string;
  /**
   * Starting pid for registry ancestor walk (defaults to process.ppid so the
   * walk begins at the parent of this CLI process — usually the agent/shell).
   * Tests inject a fake pid here.
   */
  startPid?: number;
  /** Override parent-pid lookup (tests). */
  getParentPid?: (pid: number) => number | undefined;
  /** Override registry read (tests). */
  readEntry?: (pid: number) => PidSessionEntry | undefined;
  /** Override full registry list for launchId match (tests). */
  listEntries?: () => PidSessionEntry[];
}

export interface FeedPostResult {
  event: ActivityEvent;
}

export interface PostIdentity {
  sessionId: string;
  mailboxId: string;
  host: string;
  runtime: string;
  agent?: string;
  cwd?: string;
  pid?: number;
  launchId?: string;
  terminalId?: string;
  tmuxPane?: string;
}

/**
 * Resolve who is posting. Order:
 *  1. Explicit --session flag
 *  2. Env: AGENT_SESSION_ID / AGENTS_SESSION_ID / basename(AGENTS_MAILBOX_DIR)
 *  3. Env AGENT_LAUNCH_ID → match in pid registry
 *  4. Walk parent PIDs from startPid (default process.ppid) through by-pid registry
 */
export function resolvePostIdentity(
  input: Pick<FeedPostInput, 'sessionId' | 'env' | 'cwd' | 'startPid' | 'getParentPid' | 'readEntry' | 'listEntries'>,
): PostIdentity | undefined {
  const env = input.env ?? process.env;
  const readEntry = input.readEntry ?? readPidSessionEntry;
  const listEntries = input.listEntries ?? listPidSessionEntries;
  const getParent = input.getParentPid ?? parentPidOf;

  const envSession = firstValidId([
    input.sessionId,
    env.AGENT_SESSION_ID,
    env.AGENTS_SESSION_ID,
    mailboxIdFromEnv(env),
  ]);

  const launchId = env.AGENT_LAUNCH_ID?.trim() || undefined;
  let registry: PidSessionEntry | undefined;

  if (launchId) {
    registry = listEntries().find((e) => e.launchId === launchId);
  }

  if (!registry) {
    const start = input.startPid ?? (typeof process.ppid === 'number' ? process.ppid : undefined);
    if (start && start > 1) {
      registry = walkPidRegistry(start, getParent, readEntry);
    }
  }

  // Prefer env session (explicit + managed run), fill gaps from registry.
  const sessionId = envSession ?? registry?.sessionId;
  if (!sessionId || !isValidMailboxId(sessionId)) return undefined;

  const mailboxFromEnv = mailboxIdFromEnv(env);
  const mailboxId = mailboxFromEnv && isValidMailboxId(mailboxFromEnv)
    ? mailboxFromEnv
    : sessionId;

  return {
    sessionId,
    mailboxId,
    host: machineIdFromEnv(env),
    runtime: env.AGENTS_RUNTIME?.trim() || 'headless',
    agent: env.AGENTS_AGENT_NAME?.trim()
      || registry?.agent
      || detectAgentKind(env),
    cwd: input.cwd
      ?? (env.AGENTS_CWD?.trim() || registry?.cwd || process.cwd()),
    pid: registry?.pid,
    launchId: launchId || registry?.launchId,
    terminalId: env.AGENT_TERMINAL_ID?.trim() || registry?.terminalId,
    tmuxPane: env.TMUX_PANE?.trim() || registry?.tmuxPane,
  };
}

function firstValidId(candidates: Array<string | undefined>): string | undefined {
  for (const raw of candidates) {
    const id = (raw ?? '').trim();
    if (id && isValidMailboxId(id)) return id;
  }
  return undefined;
}

function mailboxIdFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const dir = env.AGENTS_MAILBOX_DIR?.trim();
  if (!dir) return undefined;
  const base = path.basename(dir.replace(/[/\\]+$/, ''));
  return base || undefined;
}

/** Walk up to 16 ancestors looking for a by-pid registry entry with a session. */
export function walkPidRegistry(
  startPid: number,
  getParent: (pid: number) => number | undefined,
  readEntry: (pid: number) => PidSessionEntry | undefined,
): PidSessionEntry | undefined {
  let pid: number | undefined = startPid;
  const seen = new Set<number>();
  let firstHit: PidSessionEntry | undefined;
  for (let i = 0; i < 16 && pid && pid > 1 && !seen.has(pid); i++) {
    seen.add(pid);
    const entry = readEntry(pid);
    if (entry) {
      if (entry.sessionId && isValidMailboxId(entry.sessionId)) return entry;
      if (!firstHit) firstHit = entry;
    }
    pid = getParent(pid);
  }
  // Entry without sessionId still carries agent/cwd/launchId — usable when
  // session id comes from env.
  return firstHit;
}

/** Best-effort parent pid of `pid` (Linux /proc, else `ps`). */
export function parentPidOf(pid: number): number | undefined {
  if (!Number.isInteger(pid) || pid <= 1) return undefined;
  if (process.platform === 'linux') {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = status.match(/^PPid:\s*(\d+)/m);
      if (m) {
        const pp = Number(m[1]);
        return Number.isInteger(pp) && pp > 0 ? pp : undefined;
      }
    } catch {
      /* fall through */
    }
  }
  try {
    const r = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1000,
    });
    if (r.status === 0) {
      const pp = Number((r.stdout || '').trim());
      return Number.isInteger(pp) && pp > 0 ? pp : undefined;
    }
  } catch {
    /* best-effort */
  }
  return undefined;
}

export function normalizeStatusText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  if (collapsed.length <= STATUS_POST_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, STATUS_POST_MAX_CHARS - 1)}…`;
}

/**
 * Append a `status.posted` milestone for the calling agent.
 * Throws if text is empty or session identity cannot be resolved.
 */
export function postFeedStatus(input: FeedPostInput): FeedPostResult {
  const detail = normalizeStatusText(input.text);
  if (!detail) {
    throw new Error('Status text is empty. Usage: agents feed post "what just happened"');
  }

  const identity = resolvePostIdentity(input);
  if (!identity) {
    throw new Error(
      'No session id. Run from an agents-cli session '
      + '(AGENT_SESSION_ID / AGENTS_MAILBOX_DIR / pid registry), or pass --session <id>.',
    );
  }

  const event: Omit<ActivityEvent, 'v' | 'tier'> = {
    ts: input.ts ?? new Date().toISOString(),
    event: 'status.posted',
    sessionId: identity.sessionId,
    mailboxId: identity.mailboxId,
    host: identity.host,
    runtime: identity.runtime,
    cwd: identity.cwd,
    agent: identity.agent,
    tool: 'feed.post',
    detail,
    ...(identity.pid !== undefined ? { pid: identity.pid } : {}),
    ...(identity.launchId ? { launchId: identity.launchId } : {}),
    ...(identity.terminalId ? { terminalId: identity.terminalId } : {}),
    ...(identity.tmuxPane ? { tmuxPane: identity.tmuxPane } : {}),
  };

  appendActivityEvent(event, input.activityRoot);
  return {
    event: {
      v: 1,
      tier: 'milestone',
      ...event,
    },
  };
}

function machineIdFromEnv(env: NodeJS.ProcessEnv): string {
  const raw = env.AGENTS_SYNC_MACHINE_ID || undefined;
  if (raw) {
    return raw.split('.')[0].trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'unknown';
  }
  return machineId();
}

function detectAgentKind(env: NodeJS.ProcessEnv): string {
  if (env.CLAUDECODE === '1') return 'claude';
  if (env.CODEX_CI || env.CODEX_HOME) return 'codex';
  return 'agent';
}
