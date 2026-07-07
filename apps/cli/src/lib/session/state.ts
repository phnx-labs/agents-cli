/**
 * Session state inference.
 *
 * Turns a chronological slice of normalized `SessionEvent`s (typically the tail
 * of a transcript) plus lightweight context (file mtime, cwd, branch, whether
 * the owning process is alive) into a `SessionState`: is the agent working,
 * waiting on the user, or idle — and did it open a PR, is it in a worktree, is
 * it tied to a tracker ticket. Pure functions, no I/O, so the whole thing is
 * unit-testable and shared by both the live `--active` path and the incremental
 * scanner (which persists the durable signals to the index).
 *
 * Structural signals are preferred over prose heuristics: Claude's
 * `ExitPlanMode` / `AskUserQuestion` tool calls are exact "waiting on you"
 * markers. Codex has no such tools, so it falls back to last-role + question
 * shape + mtime — same function, driven off the normalized events.
 */

import type { SessionEvent } from './types.js';
import { summarizeToolUse } from './parse.js';

export type SessionActivity = 'working' | 'waiting_input' | 'idle';
export type AwaitingReason = 'question' | 'plan_review' | 'permission';

export interface DetectedPr {
  url: string;
  number?: number;
}
export interface DetectedWorktree {
  /** Absolute worktree path (the session cwd). */
  path: string;
  /** The `<slug>` under `.agents/worktrees/`. */
  slug: string;
  branch?: string;
}
export interface DetectedTicket {
  /** Tracker key, e.g. `RUSH-1234`. */
  id: string;
  url?: string;
}

export interface SessionState {
  activity: SessionActivity;
  awaitingReason?: AwaitingReason;
  lastRole?: 'user' | 'assistant';
  lastEventKind?: SessionEvent['type'];
  /** Single-line description of the latest turn (message text or tool action). */
  preview?: string;
  lastActivityMs?: number;
  pr?: DetectedPr;
  worktree?: DetectedWorktree;
  ticket?: DetectedTicket;
}

export interface StateContext {
  /** Session file mtime; drives running-vs-stale. */
  mtimeMs?: number;
  cwd?: string;
  gitBranch?: string;
  /** Whether the owning OS process is alive (from the active scanner). */
  pidAlive?: boolean;
  /** Override the running window (defaults to 2 min, matching active.ts). */
  activeWindowMs?: number;
}

/** A healthy live session writes several times a minute; 2 min ⇒ "recently active". */
const ACTIVE_WINDOW_MS = 2 * 60_000;

/** Claude tool names that structurally mean "the agent handed control back to you". */
const PLAN_TOOL = 'ExitPlanMode';
const ASK_TOOL = 'AskUserQuestion';

/** Trailing '?' or a leading interrogative — a question aimed at the user. */
const QUESTION_TRAILING = /\?["'”)\]]?\s*$/;
const QUESTION_PHRASE =
  /\b(shall i|should i|do you want|would you like|which (?:one|option|approach|of)|can you (?:confirm|clarify)|please (?:confirm|clarify|advise)|let me know|are you (?:ok|okay|sure)|proceed\?)\b/i;

/**
 * Linear/Jira-style ref, e.g. RUSH-1234. Team key is letters-only (2–6) so a
 * regex snippet like `[A-Z0-9]-\d` in a code discussion can't masquerade as a
 * ticket. Uppercase-only so we don't match `utf-8`.
 */
const TICKET_RE = /\b([A-Z]{2,6}-\d{1,6})\b/;
/** Lowercase branch form (Linear branch names): muqsit/rush-1234-fix. */
const TICKET_BRANCH_RE = /(?:^|[/_-])([a-z]{2,6})-(\d{2,6})(?=[/_-]|$)/;
/** Keys that look like tickets but aren't — avoid false positives from branches. */
const TICKET_DENYLIST = new Set(['UTF', 'SHA', 'ISO', 'RFC', 'IPV', 'X86', 'ARM', 'MP', 'H']);

const PR_URL_RE = /https:\/\/github\.com\/[^\s"'()<>]+\/pull\/(\d+)/;
const WORKTREE_RE = /\/\.agents\/worktrees\/([^/]+)/;
/** gh invocations that create/open a PR. */
const GH_PR_CREATE_RE = /\bgh\s+pr\s+(?:create|new)\b/;
/** gh invocation that opens an issue — the created number is read from its result. */
const GH_ISSUE_CREATE_RE = /\bgh\s+issue\s+create\b/;
/** A created GitHub issue URL (…/issues/123) in tool-result output. */
const GH_ISSUE_URL_RE = /https:\/\/github\.com\/[^\s"'()<>]+\/issues\/(\d+)/;
/**
 * `agents teams create <name>` / `agents teams add <team> …` (also the `ag` alias).
 * The team NAME is the first bareword after the sub-verb, skipping any flags. This
 * is the structural signal that a session SPAWNED a team (vs. was spawned by one).
 */
const TEAMS_SPAWN_RE = /\bag(?:ents)?\s+teams?\s+(?:create|add)\s+(?:--?[a-z][\w-]*(?:[= ]\S+)?\s+)*([A-Za-z0-9][\w-]*)/;

/** Collapse to a single trimmed line for a one-row preview cell. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Detect a worktree from the session cwd, per the `.agents/worktrees/<slug>/` convention. */
export function detectWorktree(cwd?: string, branch?: string): DetectedWorktree | undefined {
  if (!cwd) return undefined;
  const m = cwd.match(WORKTREE_RE);
  if (!m) return undefined;
  return { path: cwd, slug: m[1], branch: branch || undefined };
}

/** Detect a tracker ticket from free text (prompt/topic) then a branch name. */
export function detectTicket(text?: string, branch?: string): DetectedTicket | undefined {
  if (text) {
    const m = text.match(TICKET_RE);
    if (m && !TICKET_DENYLIST.has(m[1].split('-')[0])) return { id: m[1] };
  }
  if (branch) {
    const m = branch.match(TICKET_BRANCH_RE);
    if (m) {
      const key = m[1].toUpperCase();
      if (!TICKET_DENYLIST.has(key)) return { id: `${key}-${m[2]}` };
    }
  }
  return undefined;
}

/** Pull a PR URL + number out of tool-result output text. */
export function extractPrUrl(output?: string): DetectedPr | undefined {
  if (!output) return undefined;
  const m = output.match(PR_URL_RE);
  if (!m) return undefined;
  return { url: m[0], number: Number.parseInt(m[1], 10) };
}

/** True when a Bash/exec command string is a `gh pr create`. */
export function isPrCreateCommand(command?: string): boolean {
  return !!command && GH_PR_CREATE_RE.test(command);
}

/**
 * The team a session SPAWNED, from an `agents teams create/add <name>` command.
 * Returns the team name, or undefined if the command isn't a team spawn. Note this
 * is the opposite of `isTeamOrigin` (which marks sessions spawned BY a team).
 */
export function detectSpawnedTeam(command?: string): string | undefined {
  if (!command) return undefined;
  const m = command.match(TEAMS_SPAWN_RE);
  return m ? m[1] : undefined;
}

/**
 * True when a tool_use call CREATES a tracker ticket — a Linear MCP `create_issue`
 * tool, or a Bash `gh issue create`. The created id is then read from the matching
 * tool_result via {@link extractCreatedTicket}.
 */
export function isTicketCreateTool(name?: string, command?: string): boolean {
  if (typeof name === 'string' && /linear/i.test(name) && /create[_-]?issue/i.test(name)) return true;
  // Any shell tool (Bash / shell / local_shell) running `gh issue create`.
  if (!!command && GH_ISSUE_CREATE_RE.test(command)) return true;
  return false;
}

/**
 * Pull a created ticket ref out of a create-issue tool_result. Linear returns a
 * key like `RUSH-1234`; `gh issue create` returns the issue URL, from which we
 * take `#<number>`. Returns undefined when neither shape is present.
 */
export function extractCreatedTicket(text?: string): string | undefined {
  if (!text) return undefined;
  const lin = text.match(TICKET_RE);
  if (lin && !TICKET_DENYLIST.has(lin[1].split('-')[0])) return lin[1];
  const gh = text.match(GH_ISSUE_URL_RE);
  if (gh) return `#${gh[1]}`;
  return undefined;
}

/** Does an assistant message read as a question directed at the user? */
function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // Only weigh the final line — a long answer that ends with a question is a question.
  const lastLine = t.split('\n').filter(Boolean).pop() ?? t;
  return QUESTION_TRAILING.test(lastLine) || QUESTION_PHRASE.test(lastLine);
}

/** Human-readable one-liner for the latest event (message text or tool action). */
function describeEvent(e: SessionEvent): string | undefined {
  if (e.type === 'message' && e.content) return oneLine(e.content);
  if (e.type === 'tool_use' && e.tool) return oneLine(summarizeToolUse(e.tool, e.args));
  if (e.type === 'thinking') return 'thinking…';
  if (e.type === 'tool_result') return e.tool ? `↳ ${e.tool}` : undefined;
  if (e.type === 'error') return oneLine(e.content || 'error');
  return e.content ? oneLine(e.content) : undefined;
}

/** Last event of a given type, scanning from the end. */
function lastOf(events: SessionEvent[], pred: (e: SessionEvent) => boolean): SessionEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) if (pred(events[i])) return events[i];
  return undefined;
}

/**
 * Infer live activity + a preview from a chronological event slice. `pr` /
 * `ticket` / `worktree` are attached by `inferSessionState`; this focuses on the
 * running-vs-waiting-vs-idle decision and the preview line.
 */
export function inferActivity(events: SessionEvent[], ctx: StateContext = {}): SessionState {
  const windowMs = ctx.activeWindowMs ?? ACTIVE_WINDOW_MS;
  const fresh = ctx.mtimeMs != null && Date.now() - ctx.mtimeMs < windowMs;
  // A non-live process (pidAlive === false) can never be "working"; the strongest
  // it gets is "waiting on you" (a dangling question) or "idle".
  const canWork = ctx.pidAlive !== false && (ctx.pidAlive === true || fresh);

  const meaningful = events.filter(
    e => e.type === 'message' || e.type === 'tool_use' || e.type === 'tool_result' || e.type === 'thinking' || e.type === 'error',
  );
  const last = meaningful[meaningful.length - 1];
  const lastMsg = lastOf(meaningful, e => e.type === 'message');
  const lastToolUse = lastOf(meaningful, e => e.type === 'tool_use');

  // The most informative recent line: a message or tool call as-is, but for a
  // trailing tool_result/thinking show the tool *call* that produced it (its
  // command) rather than a bare "↳ Bash".
  const previewSource = !last
    ? undefined
    : last.type === 'message' || last.type === 'tool_use'
      ? last
      : (lastToolUse ?? last);

  const base: SessionState = {
    activity: 'idle',
    lastRole: lastMsg?.role,
    lastEventKind: last?.type,
    lastActivityMs: ctx.mtimeMs,
    preview: previewSource ? describeEvent(previewSource) : undefined,
  };

  if (!last) return base;

  // Structural "waiting on you" — Claude handed control back via a plan/question
  // tool and nothing has come after it.
  const lastPlanOrAsk = lastOf(
    meaningful,
    e => e.type === 'tool_use' && (e.tool === PLAN_TOOL || e.tool === ASK_TOOL),
  );
  if (lastPlanOrAsk && meaningful.indexOf(lastPlanOrAsk) === meaningful.length - 1) {
    return {
      ...base,
      activity: 'waiting_input',
      awaitingReason: lastPlanOrAsk.tool === PLAN_TOOL ? 'plan_review' : 'question',
      preview: lastPlanOrAsk.tool === PLAN_TOOL ? 'Plan ready — awaiting your review' : 'Asked you a question',
    };
  }

  // Pending tool call (tool_use with no following tool_result): mid-turn.
  if (last.type === 'tool_use') {
    if (canWork && fresh) return { ...base, activity: 'working' };
    // Alive but the file hasn't moved — likely blocked on a permission prompt.
    if (ctx.pidAlive) return { ...base, activity: 'waiting_input', awaitingReason: 'permission' };
    return { ...base, activity: 'idle' };
  }

  // Thinking or a tool result just landed → agent is mid-turn if recently active.
  if (last.type === 'thinking' || last.type === 'tool_result' || last.type === 'error') {
    return { ...base, activity: canWork && fresh ? 'working' : 'idle' };
  }

  // Last event is a message.
  if (last.type === 'message') {
    if (last.role === 'user') {
      // User spoke last; the agent owes a reply → working if it's alive/fresh.
      return { ...base, activity: canWork ? 'working' : 'idle' };
    }
    // Assistant spoke last and stopped. A trailing question → waiting; else idle.
    if (looksLikeQuestion(last.content ?? '')) {
      return { ...base, activity: 'waiting_input', awaitingReason: 'question' };
    }
    return { ...base, activity: 'idle' };
  }

  return base;
}

/**
 * Scan an event slice for the durable signals (PR opened, ticket) that aren't
 * about the cwd. Correlates each `gh pr create` with the nearest following
 * tool_result URL; keeps the last PR found.
 */
export function detectDurableSignals(events: SessionEvent[]): { pr?: DetectedPr; ticket?: DetectedTicket } {
  let pr: DetectedPr | undefined;
  let sawPrCreate = false;
  let ticket: DetectedTicket | undefined;

  for (const e of events) {
    // Structural PR signal: a real `gh pr create` tool call, then the pull URL
    // from a following tool_result — never a bare URL mentioned in prose.
    if (e.type === 'tool_use' && isPrCreateCommand(e.command)) sawPrCreate = true;
    if (sawPrCreate && e.type === 'tool_result') {
      const found = extractPrUrl(e.output);
      if (found) { pr = found; sawPrCreate = false; }
    }
    if (!ticket && e.type === 'message' && e.role === 'user') {
      ticket = detectTicket(e.content);
    }
  }
  return { pr, ticket };
}

/** Full inference: activity + preview + durable signals + worktree/ticket from ctx. */
export function inferSessionState(events: SessionEvent[], ctx: StateContext = {}): SessionState {
  const state = inferActivity(events, ctx);
  const { pr, ticket } = detectDurableSignals(events);
  const worktree = detectWorktree(ctx.cwd, ctx.gitBranch);
  return {
    ...state,
    pr: pr ?? state.pr,
    worktree: worktree ?? state.worktree,
    ticket: ticket ?? detectTicket(undefined, ctx.gitBranch) ?? state.ticket,
  };
}
