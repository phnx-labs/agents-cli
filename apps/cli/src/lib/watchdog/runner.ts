/**
 * Watchdog runner — the CONSUMER that wires the merged pure pieces into a
 * working auto-nudge (RUSH-1415). The `agents watchdog` command drives it, so
 * the whole loop runs WITHOUT the Swift menu-bar.
 *
 * One tick, per session:
 *
 *   getActiveSessions()                            (session/active.ts)
 *     -> classifyTerminal(...)                     (watchdog/watchdog.ts)  — stalled?
 *       -> readWatchdogTail(...)                   (watchdog/read.ts)      — the transcript tail
 *         -> isLikelyTrulyBlocked(...)             (watchdog/watchdog.ts)  — promise-without-toolcall, NOT waiting-on-user
 *           -> resolveInjectTargetForSession(...)  (terminal/resolve.ts)   — THE safety gate: addressable or an honest refusal
 *             -> injectIntoTerminal(target,text)   (terminal/inject.ts)    — deliver "Continue." into the EXACT split
 *
 * The safety gate is absolute: a nudge is delivered ONLY when the resolver
 * returns `addressable: true`. On `addressable: false` the reason is recorded to
 * a state file the menu-bar can surface later and the session is SKIPPED — never
 * a guessed / frontmost target.
 *
 * Persistence (all under ~/.agents/.cache/state/watchdog/, tray-readable):
 *   - nudges.json  — { [sessionId]: lastNudgeMs } — enforces the cooldown.
 *   - flags.json   — { [sessionId]: { reason, host, atMs } } — un-addressable stalls.
 *   - last-tick.json — the full outcome list from the most recent tick.
 *   - policy/<sessionId> — per-session sentinel: off | keep | handsoff.
 *
 * The pure logic (classifyTerminal / isLikelyTrulyBlocked) is imported and never
 * re-implemented; the runner only supplies its I/O (sessions, tails, clock,
 * policy, injection) — each an injectable seam so runner.test.ts drives real
 * synthetic sessions without a live terminal.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ActiveSession } from '../session/active.js';
import { getActiveSessions } from '../session/active.js';
import {
  resolveInjectTargetForSession,
  type InjectRail,
} from '../terminal/resolve.js';
import { injectIntoTerminal, type InjectResult, type InjectTarget } from '../terminal/inject.js';
import {
  classifyTerminal,
  isLikelyTrulyBlocked,
  renderWatchdogPrompt,
  parseWatchdogResponse,
  type StallStatus,
  type WatchdogCandidate,
} from './watchdog.js';
import {
  readWatchdogTail,
  WATCHDOG_STALL_MS,
  WATCHDOG_COOLDOWN_MS,
  WATCHDOG_DORMANT_MS,
  WATCHDOG_TAIL_LINES,
} from './read.js';
import { getRuntimeStateDir } from '../state.js';
import { withFileLock, atomicWriteFileSync, ensureLockTarget } from '../fs-atomic.js';
import { resolveAnswerRoute, isOpenQuestionBlock } from '../answer-router.js';
import { enqueue, mailboxDir } from '../mailbox.js';
import { mailboxIdForActiveSession } from '../mailbox-target.js';
import { readBlock, blockIdForSession, type OpenBlock } from '../feed.js';
import { summarizeWatchdogTail } from './watchdogTail.js';
import { appendWatchdogEvents, type WatchdogEvent } from './log.js';

/** Per-session policy sentinel. `keep` is the default (watchdog may nudge). */
export type WatchdogPolicy = 'off' | 'keep' | 'handsoff';

/** Stall / cooldown / dormant thresholds (ms). Defaults mirror read.ts. */
export interface WatchdogThresholds {
  stallMs: number;
  cooldownMs: number;
  dormantMs: number;
}

export const DEFAULT_THRESHOLDS: WatchdogThresholds = {
  stallMs: WATCHDOG_STALL_MS,
  cooldownMs: WATCHDOG_COOLDOWN_MS,
  dormantMs: WATCHDOG_DORMANT_MS,
};

/** The default nudge text — a short imperative, configurable via opts.nudgeText. */
export const DEFAULT_NUDGE_TEXT = 'Continue.';

export interface WatchdogTickOptions {
  /** Actually inject when a nudge is decided. Default false (dry status). */
  nudge?: boolean;
  /** Nudge text delivered into the terminal. Default "Continue." */
  nudgeText?: string;
  /**
   * Force the LLM decider (`agents run`) on EVERY stalled candidate instead of the
   * hybrid path. Default false. Even when false the tick still ESCALATES the
   * judgment-heavy cases (parked-on-question, ambiguous stalls) to the smart brain
   * — `smart: true` additionally routes the obvious promise-without-toolcall
   * nudges through it. Non-reproducible; the deterministic pre-filter is the
   * reproducible default.
   */
  smart?: boolean;
  /** Agent the smart decider runs as (and the built-in fallback prompt). Default 'claude'. */
  smartAgent?: string;
  /** Threshold overrides. Missing fields fall back to DEFAULT_THRESHOLDS. */
  thresholds?: Partial<WatchdogThresholds>;
  /** Permit the coarse, focus-stealing Ghostty path. Off by default. */
  allowGhosttyFocus?: boolean;
  /** Pass dryRun through to injectIntoTerminal (tests set true — no real terminal). */
  injectDryRun?: boolean;

  // --- injectable I/O seams (production defaults resolve the real thing) ---
  /** Session list. Default getActiveSessions(). Tests pass synthetic sessions. */
  sessions?: ActiveSession[];
  /** Clock. Default Date.now(). Tests pin it. */
  nowMs?: number;
  /** Override the state directory (tests point at a tmpdir). */
  stateDir?: string;
  /** lastActivity (ms) for a session. Default = its transcript mtime. */
  lastActivityFor?: (s: ActiveSession) => number | undefined;
  /** Transcript tail lines for a session. Default readWatchdogTail(). */
  tailFor?: (s: ActiveSession) => string[];
  /** Per-session policy. Default = the on-disk sentinel. */
  policyFor?: (s: ActiveSession) => WatchdogPolicy;
  /**
   * The smart brain: given a stalled candidate, decide drive-forward vs
   * leave-for-human and craft the message. Default resolves a `watchdog` workflow
   * (repo/user override + `model:` frontmatter) and, failing that, the improved
   * built-in prompt — both via `agents run … --mode plan`. Tests inject a
   * synthetic decider so escalation is exercised without shelling out.
   */
  smartDecider?: SmartDecider;
  /** Open feed block for a session (parked-on-question detection). Default reads the feed. */
  openBlockFor?: (s: ActiveSession) => OpenBlock | null;
  /** Inject primitive. Default injectIntoTerminal — tests capture the resolved target. */
  injectFn?: (target: InjectTarget, text: string, opts: { dryRun?: boolean }) => Promise<InjectResult>;
  /** Override the canonical watchdog.log path (tests point at a tmp file). */
  logPath?: string;
}

/** The smart brain seam: a stalled candidate in, a nudge decision out. */
export type SmartDecider = (session: ActiveSession, candidate: WatchdogCandidate) => Promise<NudgeDecision>;

/** What the tick decided for a single session — the row `--json` / the tray reads. */
export interface SessionOutcome {
  sessionId?: string;
  kind: string;
  host?: string;
  cwd?: string;
  label?: string;
  /** classifyTerminal's verdict for this session. */
  stall: StallStatus['kind'];
  /** stalled duration (ms), when stalled. */
  stalledForMs?: number;
  policy: WatchdogPolicy;
  decision: 'nudge' | 'skip';
  reason: string;
  /** The resolved rail, when delivered by injecting into a terminal split. */
  rail?: InjectRail;
  /** How the nudge was (or would be) delivered: inject | mailbox | resume. */
  via?: NudgeVia;
  /** True when resolveInjectTarget said addressable (only meaningful once we'd nudge). */
  addressable?: boolean;
  /** True when a nudge was actually delivered this tick (any mechanism). */
  injected?: boolean;
  /** The text that was (or would be) delivered. */
  nudgeText?: string;
}

/** Delivery mechanism the answer-router picked for a nudge. */
export type NudgeVia = 'inject' | 'mailbox' | 'resume';

export interface WatchdogTickResult {
  atMs: number;
  /** Whether this tick was allowed to inject (opts.nudge). */
  didNudge: boolean;
  outcomes: SessionOutcome[];
  /** Convenience counts for the menu-bar / status line. */
  counts: {
    total: number;
    stalled: number;
    nudged: number;
    unaddressable: number;
    skipped: number;
  };
}

// --- state persistence ------------------------------------------------------

function watchdogStateDir(opts: WatchdogTickOptions): string {
  return opts.stateDir ?? path.join(getRuntimeStateDir(), 'watchdog');
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(file: string, value: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  } catch {
    /* best-effort: the tray tolerates a missing/partial state file */
  }
}

/** Last-nudge timestamps keyed by sessionId (the cooldown ledger). */
function readNudgeLedger(dir: string): Record<string, number> {
  return readJsonFile<Record<string, number>>(path.join(dir, 'nudges.json'), {});
}

/**
 * On-disk per-session policy sentinel: `<stateDir>/policy/<sessionId>` whose
 * contents are `off` | `keep` | `handsoff`. Absent / unreadable / unknown → keep.
 */
export function readPolicySentinel(dir: string, sessionId: string): WatchdogPolicy {
  if (!sessionId) return 'keep';
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, 'policy', sessionId), 'utf8').trim().toLowerCase();
  } catch {
    return 'keep';
  }
  return raw === 'off' || raw === 'handsoff' ? raw : 'keep';
}

/** Write a per-session policy sentinel (used by the CLI `agents watchdog policy`). */
export function writePolicySentinel(dir: string, sessionId: string, policy: WatchdogPolicy): void {
  const file = path.join(dir, 'policy', sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, policy + '\n');
}

// --- helpers ----------------------------------------------------------------

function defaultLastActivity(s: ActiveSession): number | undefined {
  if (s.sessionFile) {
    try {
      return fs.statSync(s.sessionFile).mtimeMs;
    } catch {
      /* file vanished */
    }
  }
  return s.startedAtMs;
}

/** A decide result shared by the deterministic and smart paths. `text` overrides the default nudge text. */
export interface NudgeDecision {
  nudge: boolean;
  reason: string;
  text?: string;
}

/**
 * The deterministic PRE-FILTER outcome. It resolves only the two obvious cases
 * cheaply — a clearly-complete session (`skip`) and a clear promise-without-
 * toolcall stall (`nudge`) — and ESCALATES the judgment-heavy cases (parked on a
 * question, or an ambiguous stall) to the smart brain, which decides drive-forward
 * vs leave-for-human and crafts the message. This is the shift Muqsit asked for:
 * a parked-on-question is no longer hard-skipped, it is evaluated.
 */
type DetOutcome =
  | { kind: 'nudge'; reason: string }
  | { kind: 'skip'; reason: string }
  | { kind: 'escalate'; reason: string };

/**
 * COMPLETION_HINTS mirror of watchdog.ts. The deterministic pre-filter screens
 * completions to `skip` before the promise check so a finished-but-idle session
 * is never nudged. (isLikelyTrulyBlocked also guards completion now that its 15m
 * precedence is fixed; this explicit check keeps the pre-filter self-contained.)
 */
const COMPLETION_HINTS = ['done', 'completed', 'all set', 'finished'];

function tailShowsCompletion(candidate: WatchdogCandidate): boolean {
  if (candidate.tailLines.length === 0) return false;
  const lowerTail = candidate.tailLines.join('\n').toLowerCase();
  return COMPLETION_HINTS.some((hint) => lowerTail.includes(hint));
}

function deterministicDecision(
  session: ActiveSession,
  candidate: WatchdogCandidate,
): DetOutcome {
  // Parked on a question — the case Muqsit cares about most. Do NOT drop it:
  // escalate to the brain, which decides drive-forward vs leave-for-human.
  if (session.activity === 'waiting_input') {
    return {
      kind: 'escalate',
      reason: `parked on a question${session.awaitingReason ? ` (${session.awaitingReason})` : ''} — escalate to the brain`,
    };
  }
  // Clearly complete — cheap skip, no LLM.
  if (tailShowsCompletion(candidate)) {
    return { kind: 'skip', reason: 'tail shows completion (done / finished / all set) — skip' };
  }
  // Clear promise-without-toolcall — cheap nudge, no LLM.
  if (isLikelyTrulyBlocked(candidate)) {
    return { kind: 'nudge', reason: 'stalled after announcing an action with no follow-through' };
  }
  // Ambiguous stall — let the brain judge rather than blindly skip.
  return { kind: 'escalate', reason: 'ambiguous stall — escalate to the brain' };
}

/**
 * The smart brain. Resolves a `watchdog` workflow for the session's cwd
 * (project > user > system precedence, via resolveWorkflowRef) so a repo/user
 * override AND `model:` frontmatter come for free; when a workflow resolves it
 * runs `agents run watchdog --mode plan <prompt>`, else it falls back to the
 * improved built-in prompt via `agents run <agent> --mode plan <prompt>`. Plan
 * mode keeps the decider read-only. Best-effort and NON-deterministic: any
 * failure (decider unavailable, no verdict) returns a SAFE skip — a parked
 * question we cannot judge is left for the human, never blindly nudged.
 */
export function makeDefaultSmartDecider(agent: string): SmartDecider {
  return async (session, candidate) => {
    const prompt = renderWatchdogPrompt([candidate]);
    try {
      const [{ resolveWorkflowRef }, { execFile }, { promisify }] = await Promise.all([
        import('../workflows.js'),
        import('child_process'),
        import('util'),
      ]);
      const cwd = session.cwd || process.cwd();
      const workflowPath = resolveWorkflowRef('watchdog', cwd);
      // A resolved `watchdog` workflow runs by name so its WORKFLOW.md body + model
      // frontmatter apply; otherwise the bare agent runs the built-in prompt.
      const runTarget = workflowPath ? 'watchdog' : agent;
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync('agents', ['run', runTarget, '--mode', 'plan', prompt], {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        timeout: 120_000,
      });
      const decisions = parseWatchdogResponse(stdout);
      const d = decisions.find((x) => x.terminalId === candidate.terminalId) ?? decisions[0];
      if (!d) return { nudge: false, reason: 'smart decider returned no verdict' };
      return { nudge: d.action === 'nudge', reason: d.reason || `smart: ${d.action}`, text: d.text || undefined };
    } catch (err) {
      return { nudge: false, reason: `smart decider unavailable: ${err instanceof Error ? err.message : String(err)}` };
    }
  };
}

// --- delivery planning ------------------------------------------------------

/**
 * How a decided nudge should be delivered. The four outcomes mirror the
 * answer-router contract: a running/looping agent gets the message in its mailbox
 * (seen at the next tool call); a parked-on-question agent gets it typed into the
 * EXACT split (inject) or, when headless, re-entered via resume; and a parked
 * agent with no addressable rail is refused (flagged, never a guessed target).
 */
type DeliveryPlan =
  | { via: 'inject'; rail: InjectRail; target: InjectTarget }
  | { via: 'resume' }
  | { via: 'mailbox'; mailboxId: string }
  | { via: 'refuse'; reason: string };

/**
 * Pick the delivery mechanism. resolveAnswerRoute (answer-router.ts) chooses
 * mailbox vs resume vs refuse; resolveInjectTargetForSession (resolve.ts) supplies
 * the precise inject target — CRUCIALLY it handles the vscodium rail that the
 * answer-router's own resolver cannot, so an IDE-terminal (VS Codium / Cursor /
 * VS Code) session parked on a question is injected into its exact terminal rather
 * than being downgraded to resume/refuse. When a precise rail exists it wins
 * (that includes a stalled non-parked agent, so the v1 terminal-inject path is
 * preserved and no nudge is stranded in a mailbox the agent will never poll).
 */
function planDelivery(
  session: ActiveSession,
  chosenText: string,
  block: OpenBlock | null,
  allowGhosttyFocus: boolean | undefined,
): DeliveryPlan {
  const sessionId = session.sessionId ?? '';
  const mailboxId = mailboxIdForActiveSession(session) ?? sessionId;
  const resolution = resolveInjectTargetForSession(session, { allowGhosttyFocus });
  const route = resolveAnswerRoute({ mailboxId, answer: chosenText, session, block });

  // A precise split (tmux / iTerm / vscodium / pty) is the authoritative target.
  if (resolution.addressable) {
    return { via: 'inject', rail: resolution.rail, target: resolution.target };
  }
  // No precise rail: honor the answer-router's parked-agent decision.
  if (route.kind === 'resume') return { via: 'resume' };
  // Mailbox is correct ONLY for a still-looping agent that has an OPEN question
  // block — it is seen at the next tool call. A stalled agent that simply stopped
  // (no open block) would never poll the mailbox, so it is flagged instead of
  // silently dropping a nudge into a spool it will never read.
  if (route.kind === 'mailbox' && isOpenQuestionBlock(block)) return { via: 'mailbox', mailboxId };
  return { via: 'refuse', reason: route.kind === 'refuse' ? route.reason : resolution.reason };
}

/** Default open-block reader — the same lookup `agents message` uses. */
function defaultOpenBlockFor(session: ActiveSession): OpenBlock | null {
  const id = mailboxIdForActiveSession(session) ?? session.sessionId;
  if (!id) return null;
  const direct = readBlock(blockIdForSession(id));
  if (direct && direct.mailboxId === id) return direct;
  return null;
}

/** Enqueue a nudge into a session's mailbox (running agent, seen at next tool call). */
function deliverViaMailbox(mailboxId: string, text: string, block: OpenBlock | null): void {
  enqueue(mailboxDir(mailboxId), { to: mailboxId, text, from: 'watchdog', blockId: block?.blockId });
}

/** Re-enter a parked headless agent with the nudge as its next user turn. */
async function deliverViaResume(session: ActiveSession, text: string): Promise<{ ok: boolean; error?: string }> {
  const sid = session.sessionId;
  if (!sid) return { ok: false, error: 'no session id to resume' };
  try {
    const [{ getAgentsInvocation }, { spawn }] = await Promise.all([
      import('../daemon.js'),
      import('child_process'),
    ]);
    const inv = getAgentsInvocation(['run', session.kind, '--resume', sid, '--', text]);
    const code: number = await new Promise((resolve) => {
      const child = spawn(inv.command, inv.args, { stdio: 'ignore', env: process.env, detached: false });
      child.on('exit', (c) => resolve(c ?? 1));
      child.on('error', () => resolve(1));
    });
    return code === 0 ? { ok: true } : { ok: false, error: `resume exited ${code}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// --- the tick ---------------------------------------------------------------

/**
 * Run ONE watchdog pass. Returns a structured outcome per live session; injects
 * only when `opts.nudge` is set AND the safety gate says addressable AND policy
 * permits. Persists the cooldown ledger, un-addressable flags, and a last-tick
 * snapshot to the tray-readable state dir.
 */
export async function runWatchdogTick(opts: WatchdogTickOptions = {}): Promise<WatchdogTickResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const nudgeText = opts.nudgeText ?? DEFAULT_NUDGE_TEXT;
  const thresholds: WatchdogThresholds = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
  const dir = watchdogStateDir(opts);
  const lastActivityFor = opts.lastActivityFor ?? defaultLastActivity;
  const tailFor = opts.tailFor ?? ((s) => (s.sessionId ? readWatchdogTail(s.sessionId, s.kind, WATCHDOG_TAIL_LINES) : []));
  const policyFor = opts.policyFor ?? ((s) => (s.sessionId ? readPolicySentinel(dir, s.sessionId) : 'keep'));
  const smartDecider = opts.smartDecider ?? makeDefaultSmartDecider(opts.smartAgent ?? 'claude');
  const openBlockFor = opts.openBlockFor ?? defaultOpenBlockFor;
  const injectFn = opts.injectFn ?? injectIntoTerminal;

  const sessions = opts.sessions ?? (await getActiveSessions());
  const ledger = readNudgeLedger(dir);
  // Cooldown timestamps this tick decided to (re)start — merged into the ledger
  // under a lock at the end so a concurrent tick's updates are never lost.
  const ledgerUpdates: Record<string, number> = {};
  const flags: Record<string, { reason: string; host?: string; atMs: number }> = {};
  const outcomes: SessionOutcome[] = [];
  const logEvents: WatchdogEvent[] = [];
  const viaLabel = (plan: DeliveryPlan): string =>
    plan.via === 'inject' ? `inject (${plan.rail})` : plan.via;

  for (const session of sessions) {
    const policy = policyFor(session);
    const base: SessionOutcome = {
      sessionId: session.sessionId,
      kind: session.kind,
      host: session.host,
      cwd: session.cwd,
      label: session.label,
      policy,
      stall: 'active',
      decision: 'skip',
      reason: '',
      nudgeText,
    };

    // A session with no id can neither be addressed nor cooldown-tracked.
    if (!session.sessionId) {
      outcomes.push({ ...base, reason: 'no session id (cannot address or track)' });
      continue;
    }
    // `off` = fully opted out. We short-circuit here rather than relying on
    // classifyTerminal (which is always called with optedOut: false below), so the
    // policy reason is reported explicitly.
    if (policy === 'off') {
      outcomes.push({ ...base, stall: 'opted_out', reason: 'policy: off (opted out)' });
      continue;
    }

    const lastActivityMs = lastActivityFor(session);
    if (lastActivityMs === undefined) {
      outcomes.push({ ...base, reason: 'no activity timestamp (no transcript / start time)' });
      continue;
    }

    const status = classifyTerminal({
      lastActivityMs,
      nowMs,
      lastNudgeMs: ledger[session.sessionId] ?? null,
      optedOut: false,
      stallMs: thresholds.stallMs,
      cooldownMs: thresholds.cooldownMs,
      dormantMs: thresholds.dormantMs,
    });
    base.stall = status.kind;

    if (status.kind !== 'stalled') {
      const reason =
        status.kind === 'active' ? `active (last activity ${Math.round((nowMs - lastActivityMs) / 1000)}s ago)`
        : status.kind === 'dormant' ? 'dormant (idle past the dormant window)'
        : status.kind === 'rate_limited' ? `cooling down (${Math.round(status.cooldownRemainingMs / 1000)}s left)`
        : 'opted out';
      outcomes.push({ ...base, reason });
      continue;
    }

    base.stalledForMs = status.stalledForMs;

    // Stalled — read the tail and decide.
    const tailLines = tailFor(session);
    const candidate: WatchdogCandidate = {
      terminalId: session.sessionId,
      agentType: (session.kind === 'codex' || session.kind === 'gemini' ? session.kind : 'claude'),
      tailLines,
      stalledForMs: status.stalledForMs,
    };

    // The brain. The cheap deterministic pre-filter resolves the obvious cases;
    // parked-on-question and ambiguous stalls ESCALATE to the smart brain. `smart`
    // forces every stalled candidate through the brain.
    let decision: NudgeDecision;
    if (opts.smart) {
      decision = await smartDecider(session, candidate);
    } else {
      const det = deterministicDecision(session, candidate);
      decision = det.kind === 'escalate'
        ? await smartDecider(session, candidate)
        : { nudge: det.kind === 'nudge', reason: det.reason };
    }
    const chosenText = decision.text ?? nudgeText;

    // Log the decision for the Factory watchdog card.
    const summary = summarizeWatchdogTail(tailLines, candidate.agentType);
    logEvents.push({
      ts: nowMs,
      kind: 'decision',
      terminalId: session.sessionId,
      agentType: candidate.agentType,
      message: decision.reason,
      reason: decision.reason,
      stalledForMs: status.stalledForMs,
      tailLines,
      nudgeText: decision.nudge ? chosenText : undefined,
      lastUserMessage: summary.lastUserMessage,
      lastAssistantMessage: summary.lastAssistantMessage,
    });

    if (!decision.nudge) {
      outcomes.push({ ...base, decision: 'skip', reason: decision.reason });
      continue;
    }

    // A nudge is warranted — plan delivery (answer-router picks mailbox/resume/
    // refuse; resolveInjectTargetForSession supplies the vscodium-aware inject
    // target) BEFORE any side effect.
    const block = openBlockFor(session);
    const plan = planDelivery(session, chosenText, block, opts.allowGhosttyFocus);
    const rail = plan.via === 'inject' ? plan.rail : undefined;
    const addressable = plan.via === 'inject' ? true : undefined;

    if (plan.via === 'refuse') {
      // No addressable rail and not headless-resumable — flag, NEVER guess.
      flags[session.sessionId] = { reason: plan.reason, host: session.host, atMs: nowMs };
      outcomes.push({
        ...base, decision: 'skip', addressable: false,
        reason: `nudge-worthy but un-addressable — ${plan.reason}`,
        nudgeText: chosenText,
      });
      continue;
    }

    // handsoff = detect + flag, but never deliver.
    if (policy === 'handsoff') {
      flags[session.sessionId] = {
        reason: `handsoff: would nudge via ${viaLabel(plan)} but policy is hands-off`,
        host: session.host,
        atMs: nowMs,
      };
      outcomes.push({
        ...base, decision: 'nudge', addressable, rail, via: plan.via, injected: false,
        reason: `handsoff: flagged, not delivered (would nudge via ${viaLabel(plan)})`,
        nudgeText: chosenText,
      });
      continue;
    }

    // Dry status (no --nudge): report what WOULD happen, deliver nothing.
    if (!opts.nudge) {
      outcomes.push({
        ...base, decision: 'nudge', addressable, rail, via: plan.via, injected: false,
        reason: `would nudge via ${viaLabel(plan)} (dry — pass --nudge)`,
        nudgeText: chosenText,
      });
      continue;
    }

    // Deliver. injectDryRun exercises the path without a real side effect: inject
    // still calls injectFn (which honors dryRun), mailbox/resume are short-circuited.
    let delivered: { ok: boolean; error?: string };
    if (plan.via === 'inject') {
      try {
        const r = await injectFn(plan.target, chosenText, { dryRun: opts.injectDryRun });
        delivered = { ok: r.ok, error: r.error };
      } catch (err) {
        delivered = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    } else if (plan.via === 'mailbox') {
      if (opts.injectDryRun) {
        delivered = { ok: true };
      } else {
        try { deliverViaMailbox(plan.mailboxId, chosenText, block); delivered = { ok: true }; }
        catch (err) { delivered = { ok: false, error: err instanceof Error ? err.message : String(err) }; }
      }
    } else {
      delivered = opts.injectDryRun ? { ok: true } : await deliverViaResume(session, chosenText);
    }

    if (delivered.ok) {
      ledgerUpdates[session.sessionId] = nowMs; // start the cooldown clock
      logEvents.push({
        ts: nowMs, kind: 'nudge', terminalId: session.sessionId, agentType: candidate.agentType,
        message: `nudged via ${viaLabel(plan)}`, reason: decision.reason, nudgeText: chosenText,
      });
      outcomes.push({
        ...base, decision: 'nudge', addressable, rail, via: plan.via, injected: true,
        reason: `nudged via ${viaLabel(plan)}`,
        nudgeText: chosenText,
      });
    } else {
      outcomes.push({
        ...base, decision: 'skip', addressable, rail, via: plan.via, injected: false,
        reason: `nudge via ${viaLabel(plan)} failed: ${delivered.error ?? 'unknown error'}`,
        nudgeText: chosenText,
      });
    }
  }

  // Persist the cooldown ledger under a lock: fresh-read + merge this tick's
  // updates + atomic write, so a concurrent tick's timestamps are never lost
  // (the old unlocked read-at-start / write-at-end was a lost-update race).
  if (Object.keys(ledgerUpdates).length > 0) {
    const nudgesPath = path.join(dir, 'nudges.json');
    const ledgerLock = path.join(dir, '.ledger.lock');
    try {
      ensureLockTarget(ledgerLock);
      withFileLock(ledgerLock, () => {
        const current = readNudgeLedger(dir);
        for (const [sid, ts] of Object.entries(ledgerUpdates)) current[sid] = ts;
        atomicWriteFileSync(nudgesPath, JSON.stringify(current, null, 2));
      });
    } catch {
      /* best-effort: a lock failure must not throw out of a tick */
    }
  }
  writeJsonFile(path.join(dir, 'flags.json'), flags);

  const counts = {
    total: outcomes.length,
    stalled: outcomes.filter((o) => o.stall === 'stalled').length,
    nudged: outcomes.filter((o) => o.injected).length,
    unaddressable: outcomes.filter((o) => o.addressable === false).length,
    skipped: outcomes.filter((o) => o.decision === 'skip').length,
  };
  const result: WatchdogTickResult = { atMs: nowMs, didNudge: opts.nudge === true, outcomes, counts };
  writeJsonFile(path.join(dir, 'last-tick.json'), result);

  // Heartbeat + decision/nudge events to the canonical watchdog.log the Factory
  // Floor reads. Best-effort; never throws into the tick.
  logEvents.push({
    ts: nowMs,
    kind: 'tick',
    message: `${counts.total} live · ${counts.stalled} stalled · ${counts.nudged} nudged · ${counts.unaddressable} un-addressable`,
  });
  appendWatchdogEvents(logEvents, { logPath: opts.logPath });

  return result;
}
