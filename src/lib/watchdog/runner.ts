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
  type InjectResolution,
  type InjectRail,
} from '../terminal/resolve.js';
import { injectIntoTerminal, type InjectResult } from '../terminal/inject.js';
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
   * Use the LLM decider (`agents run`) to decide + choose nudge text instead of
   * the deterministic promise-without-toolcall path. Default false so ticks are
   * reproducible. Best-effort: a decider failure falls back to skip.
   */
  smart?: boolean;
  /** Agent the smart decider runs as. Default 'claude'. */
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
}

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
  /** The resolved rail, when addressable. */
  rail?: InjectRail;
  /** True when resolveInjectTarget said addressable (only meaningful once we'd nudge). */
  addressable?: boolean;
  /** True when a nudge was actually delivered this tick. */
  injected?: boolean;
  /** The text that was (or would be) delivered. */
  nudgeText?: string;
}

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

/**
 * The deterministic v1 decision: nudge only when the tail shows a
 * promise-without-toolcall (isLikelyTrulyBlocked) AND the session is not waiting
 * on the user. isLikelyTrulyBlocked already refuses on WAITING/COMPLETION hints;
 * the state engine's `waiting_input` activity is an extra, stronger guard against
 * typing over an open AskUserQuestion.
 */
/** A decide result shared by the deterministic and smart paths. `text` overrides the default nudge text. */
interface NudgeDecision {
  nudge: boolean;
  reason: string;
  text?: string;
}

/**
 * Minimal local mirror of COMPLETION_HINTS in watchdog.ts:42-47. We cannot lean
 * on isLikelyTrulyBlocked to screen completions out: its FORCE_REVIEW_STALL_MS
 * short-circuit (watchdog.ts:171 — `stalledForMs >= 15m` returns true) fires
 * BEFORE its own COMPLETION_HINTS check (watchdog.ts:176), so a session idle
 * 15m-60m whose tail says "done"/"finished" would be reported as blocked. Keep
 * this list in sync with the core.
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
): NudgeDecision {
  if (session.activity === 'waiting_input') {
    return { nudge: false, reason: `waiting on user${session.awaitingReason ? ` (${session.awaitingReason})` : ''}` };
  }
  // Completion is checked EXPLICITLY here — never nudge a finished session, even
  // past the 15m force-review window where isLikelyTrulyBlocked would return true
  // before reaching its completion check (see COMPLETION_HINTS note above).
  if (tailShowsCompletion(candidate)) {
    return { nudge: false, reason: 'tail shows completion (done / finished / all set) — skip regardless of stall age' };
  }
  if (isLikelyTrulyBlocked(candidate)) {
    return { nudge: true, reason: 'stalled after announcing an action with no follow-through' };
  }
  return { nudge: false, reason: 'no promise-without-toolcall signal in tail (completion / question / unclear)' };
}

/**
 * The optional LLM decider. Shells out to `agents run <agent>` with the watchdog
 * prompt and parses its JSON verdict. Best-effort and NON-deterministic — the
 * default path is deterministicDecision. Isolated here so the tick stays pure
 * over its seams; the command layer opts in with --smart.
 */
async function smartDecision(
  candidate: WatchdogCandidate,
  agent: string,
): Promise<NudgeDecision> {
  const prompt = renderWatchdogPrompt([candidate]);
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync('agents', ['run', agent, '--mode', 'plan', prompt], {
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

  const sessions = opts.sessions ?? (await getActiveSessions());
  const ledger = readNudgeLedger(dir);
  const flags: Record<string, { reason: string; host?: string; atMs: number }> = {};
  const outcomes: SessionOutcome[] = [];

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

    const decision: NudgeDecision = opts.smart
      ? await smartDecision(candidate, opts.smartAgent ?? 'claude')
      : deterministicDecision(session, candidate);
    const chosenText = decision.text ?? nudgeText;

    if (!decision.nudge) {
      outcomes.push({ ...base, decision: 'skip', reason: decision.reason });
      continue;
    }

    // A nudge is warranted — run it past the safety gate BEFORE any delivery.
    const resolution: InjectResolution = resolveInjectTargetForSession(session, {
      allowGhosttyFocus: opts.allowGhosttyFocus,
    });

    if (!resolution.addressable) {
      // Flag the un-addressable stall for the tray; NEVER guess a target.
      flags[session.sessionId] = { reason: resolution.reason, host: session.host, atMs: nowMs };
      outcomes.push({
        ...base, decision: 'skip', addressable: false,
        reason: `nudge-worthy but un-addressable — ${resolution.reason}`,
        nudgeText: chosenText,
      });
      continue;
    }

    // handsoff = detect + flag, but never inject. Record a flag so the tray can
    // surface "would-nudge but hands-off" alongside the un-addressable flags.
    if (policy === 'handsoff') {
      flags[session.sessionId] = {
        reason: `handsoff: would nudge via ${resolution.rail} but policy is hands-off`,
        host: session.host,
        atMs: nowMs,
      };
      outcomes.push({
        ...base, decision: 'nudge', addressable: true, rail: resolution.rail, injected: false,
        reason: `handsoff: flagged, not injected (would nudge via ${resolution.rail})`,
        nudgeText: chosenText,
      });
      continue;
    }

    // Dry status (no --nudge): report what WOULD happen, deliver nothing.
    if (!opts.nudge) {
      outcomes.push({
        ...base, decision: 'nudge', addressable: true, rail: resolution.rail, injected: false,
        reason: `would nudge via ${resolution.rail} (dry — pass --nudge to inject)`,
        nudgeText: chosenText,
      });
      continue;
    }

    // Deliver into the EXACT resolved split.
    let result: InjectResult;
    try {
      result = await injectIntoTerminal(resolution.target, chosenText, { dryRun: opts.injectDryRun });
    } catch (err) {
      result = { ok: false, backend: resolution.target.backend, writes: 0, error: err instanceof Error ? err.message : String(err) };
    }

    if (result.ok) {
      ledger[session.sessionId] = nowMs; // start the cooldown clock
      outcomes.push({
        ...base, decision: 'nudge', addressable: true, rail: resolution.rail, injected: true,
        reason: `nudged via ${resolution.rail}`,
        nudgeText: chosenText,
      });
    } else {
      outcomes.push({
        ...base, decision: 'skip', addressable: true, rail: resolution.rail, injected: false,
        reason: `inject failed via ${resolution.rail}: ${result.error ?? 'unknown error'}`,
        nudgeText: chosenText,
      });
    }
  }

  // Persist the tray-readable state.
  writeJsonFile(path.join(dir, 'nudges.json'), ledger);
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
  return result;
}
