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

/** One discrete choice the agent offered the user. */
export interface QuestionOption {
  /** The choice label — also what a free-text reply channel sends back. */
  label: string;
  /** Optional longer description shown under the label. */
  description?: string;
  /**
   * Selection keystroke for an interactive TUI prompt (AskUserQuestion / plan /
   * permission are select-lists, not text inputs): a digit ('1'), or 'esc' to
   * cancel/deny. Absent for a plain prose question, which takes free text.
   */
  key?: string;
}

/**
 * The decision an agent handed back to the user, extracted at the SOURCE so every
 * consumer (Factory panel, teams, cloud) gets the real question + options instead
 * of re-deriving them from a truncated preview line. `reason` mirrors
 * {@link AwaitingReason}; `options` is present when the agent offered discrete choices.
 */
export interface StructuredQuestion {
  text: string;
  reason: AwaitingReason;
  options?: QuestionOption[];
}

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
  /**
   * The structured decision the agent is waiting on (question / plan / permission),
   * with its options when it offered any. Set only when activity is waiting_input.
   */
  question?: StructuredQuestion;
  /**
   * The plan markdown from the most recent `ExitPlanMode` tool call, surfaced
   * when `awaitingReason === 'plan_review'`. The state engine detects the
   * handoff off the same tool event; carrying the plan text alongside it lets
   * consumers (the Factory NEEDS-YOU panel, `agents sessions <id> --json`)
   * render the actual plan without re-parsing the transcript.
   */
  plan?: string;
  /** Last few assistant turns (most-recent last), one line each — panel context. */
  tail?: string[];
  lastActivityMs?: number;
  pr?: DetectedPr;
  worktree?: DetectedWorktree;
  ticket?: DetectedTicket;
  /** Tracker refs this session CREATED (Linear create_issue / gh issue create). */
  createdTickets?: string[];
  /** Team name this session SPAWNED via `agents teams create/add`. */
  spawnedTeam?: string;
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

/**
 * A prose trailing question ("…?") is a HEURISTIC, so it decays: past this long
 * with no session writes it stops classifying as waiting_input — otherwise a
 * finished session that signed off with "anything else?" reads as needing input
 * forever (RUSH-1522). The structural ExitPlanMode / AskUserQuestion signals are
 * exempt: they are precise, still-unanswered decisions.
 */
const PROSE_QUESTION_FRESH_MS = 30 * 60_000;

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

/**
 * Pull the plan markdown out of an `ExitPlanMode` tool_use event's args. The
 * Claude tool schema is `{ plan: string }`; the transcript parser already
 * lifts `input` onto `event.args`. Returns undefined for a missing/empty plan
 * so consumers can rely on `plan?: string` truthiness.
 */
export function extractPlanText(args?: Record<string, any>): string | undefined {
  const plan = args?.plan;
  if (typeof plan !== 'string') return undefined;
  const trimmed = plan.trim();
  return trimmed ? plan : undefined;
}

/**
 * Structured question from a Claude `AskUserQuestion` tool call. Its input is
 * `{ questions: [{ question, header, options: [{label, description}] }] }` and the
 * whole thing is already parsed onto `event.args` by the transcript parser — this
 * surfaces the first question + its options (instead of collapsing to a generic
 * "Asked you a question"). The prompt is a select-list, so each option carries its
 * 1-based selection digit as `key`.
 */
export function structuredQuestionFromAsk(args?: Record<string, any>): StructuredQuestion | undefined {
  const q = Array.isArray(args?.questions) ? args!.questions[0] : undefined;
  if (!q) return undefined;
  const text = oneLine(String(q.question ?? q.header ?? '')) || 'Asked you a question';
  const raw = Array.isArray(q.options) ? q.options : [];
  const options: QuestionOption[] = [];
  for (const o of raw) {
    const label = typeof o === 'string' ? oneLine(o) : o?.label != null ? oneLine(String(o.label)) : '';
    if (!label) continue;
    const description = typeof o === 'object' && o?.description != null ? oneLine(String(o.description)) : undefined;
    options.push({ label, description, key: String(options.length + 1) });
  }
  return { text, reason: 'question', options: options.length ? options : undefined };
}

/**
 * Canonical approve/deny choices for an interactive prompt that carries no
 * agent-supplied option list: Claude's plan-review and permission dialogs. Approve
 * is reliably option 1; deny/keep-planning maps to ESC, which cancels the prompt in
 * every variant (2- or 3-option) — safer than guessing a digit that could differ.
 */
function planReviewQuestion(): StructuredQuestion {
  return {
    text: 'Plan ready — review it',
    reason: 'plan_review',
    options: [
      { label: 'Approve plan', key: '1' },
      { label: 'Keep planning', key: 'esc' },
    ],
  };
}
function permissionQuestion(preview?: string): StructuredQuestion {
  return {
    text: preview ? `Permission — ${preview}` : 'Waiting on a permission prompt',
    reason: 'permission',
    options: [
      { label: 'Approve', key: '1' },
      { label: 'Deny', key: 'esc' },
    ],
  };
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
  // command), or — failing that — the last assistant message, rather than a bare
  // "↳ Bash" or a content-free "thinking…". This is what stops a trailing thinking
  // block from masking the real turn (the defect behind the "Thinking…" panel).
  const previewSource = !last
    ? undefined
    : last.type === 'message' || last.type === 'tool_use'
      ? last
      : (lastToolUse ?? lastMsg ?? last);

  // Last few assistant turns, most-recent last — context for the decision panel.
  const tail = meaningful
    .filter(e => e.type === 'message' && e.role === 'assistant' && e.content)
    .slice(-3)
    .map(e => oneLine(e.content ?? ''))
    .filter(Boolean);

  const base: SessionState = {
    activity: 'idle',
    lastRole: lastMsg?.role,
    lastEventKind: last?.type,
    lastActivityMs: ctx.mtimeMs,
    preview: previewSource ? describeEvent(previewSource) : undefined,
    tail: tail.length ? tail : undefined,
  };

  if (!last) return base;

  // Structural "waiting on you" — Claude handed control back via a plan/question
  // tool and nothing has come after it.
  const lastPlanOrAsk = lastOf(
    meaningful,
    e => e.type === 'tool_use' && (e.tool === PLAN_TOOL || e.tool === ASK_TOOL),
  );
  if (lastPlanOrAsk && meaningful.indexOf(lastPlanOrAsk) === meaningful.length - 1) {
    if (lastPlanOrAsk.tool === PLAN_TOOL) {
      const question = planReviewQuestion();
      const plan = extractPlanText(lastPlanOrAsk.args);
      return { ...base, activity: 'waiting_input', awaitingReason: 'plan_review', preview: question.text, question, plan };
    }
    // AskUserQuestion: surface the real question + options (they're on `args`),
    // not the generic "Asked you a question" that discarded them.
    const question = structuredQuestionFromAsk(lastPlanOrAsk.args) ?? { text: 'Asked you a question', reason: 'question' as const };
    return { ...base, activity: 'waiting_input', awaitingReason: 'question', preview: question.text, question };
  }

  // Pending tool call (tool_use with no following tool_result): mid-turn.
  if (last.type === 'tool_use') {
    if (canWork && fresh) return { ...base, activity: 'working' };
    // Alive but the file hasn't moved — likely blocked on a permission prompt.
    if (ctx.pidAlive) return { ...base, activity: 'waiting_input', awaitingReason: 'permission', question: permissionQuestion(base.preview) };
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
    // A prose question takes a free-text reply (no select-list), so no options/keys.
    // Unlike the structural plan/ask signals above, the prose heuristic DECAYS: a
    // question nobody answered within PROSE_QUESTION_FRESH_MS is a session that
    // ended, not one that needs you (RUSH-1522). Unknown mtime keeps the question.
    const questionFresh = ctx.mtimeMs == null || Date.now() - ctx.mtimeMs < PROSE_QUESTION_FRESH_MS;
    if (questionFresh && looksLikeQuestion(last.content ?? '')) {
      const text = oneLine(last.content ?? '');
      return { ...base, activity: 'waiting_input', awaitingReason: 'question', question: { text, reason: 'question' } };
    }
    return { ...base, activity: 'idle' };
  }

  return base;
}

/**
 * Scan an event slice for the durable signals that aren't about the cwd: the PR
 * opened, the injected ticket, plus the artifacts the session PRODUCED — tracker
 * refs it created and any team it spawned. Each `gh pr create` / create-issue tool
 * call is correlated with the nearest following tool_result; the team name comes
 * straight off the `agents teams create/add` command.
 */
export function detectDurableSignals(events: SessionEvent[]): {
  pr?: DetectedPr;
  ticket?: DetectedTicket;
  createdTickets?: string[];
  spawnedTeam?: string;
} {
  let pr: DetectedPr | undefined;
  let sawPrCreate = false;
  let ticket: DetectedTicket | undefined;
  let sawTicketCreate = false;
  let spawnedTeam: string | undefined;
  const createdTickets = new Set<string>();

  for (const e of events) {
    // Structural PR signal: a real `gh pr create` tool call, then the pull URL
    // from a following tool_result — never a bare URL mentioned in prose.
    if (e.type === 'tool_use' && isPrCreateCommand(e.command)) sawPrCreate = true;
    if (sawPrCreate && e.type === 'tool_result') {
      const found = extractPrUrl(e.output);
      if (found) { pr = found; sawPrCreate = false; }
    }
    // Produced artifacts: a team spawn is read off the command; a created ticket
    // is a create-issue tool call whose following tool_result carries the new ref.
    if (e.type === 'tool_use') {
      if (!spawnedTeam) {
        const team = detectSpawnedTeam(e.command);
        if (team) spawnedTeam = team;
      }
      if (isTicketCreateTool(e.tool, e.command)) sawTicketCreate = true;
    }
    if (sawTicketCreate && e.type === 'tool_result') {
      const t = extractCreatedTicket(e.output);
      if (t) createdTickets.add(t);
      sawTicketCreate = false;
    }
    if (!ticket && e.type === 'message' && e.role === 'user') {
      ticket = detectTicket(e.content);
    }
  }
  return {
    pr,
    ticket,
    createdTickets: createdTickets.size > 0 ? [...createdTickets] : undefined,
    spawnedTeam,
  };
}

/** Full inference: activity + preview + durable signals + worktree/ticket from ctx. */
export function inferSessionState(events: SessionEvent[], ctx: StateContext = {}): SessionState {
  const state = inferActivity(events, ctx);
  const { pr, ticket, createdTickets, spawnedTeam } = detectDurableSignals(events);
  const worktree = detectWorktree(ctx.cwd, ctx.gitBranch);
  return {
    ...state,
    pr: pr ?? state.pr,
    worktree: worktree ?? state.worktree,
    ticket: ticket ?? detectTicket(undefined, ctx.gitBranch) ?? state.ticket,
    createdTickets,
    spawnedTeam,
  };
}
