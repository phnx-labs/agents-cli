/**
 * Auto-reconnect for an interactive `agents run --device/--host` session whose
 * SSH link dropped.
 *
 * A remote interactive agent runs in a DETACHED tmux session on the peer (see
 * lib/exec.ts `runInTmux`), so a network blink kills only the local ssh client —
 * the agent keeps running. `sshStream` reports that drop as exit code 255 (ssh's
 * own connection-layer failure; see ssh-exec.ts). Without this, exec.ts would
 * `process.exit(255)` and the user would have to notice, find the session id, and
 * `agents sessions focus` by hand. Instead we re-attach the live remote pane over
 * SSH automatically, with bounded backoff, until the user detaches cleanly (the
 * remote returns 0) or the agent exits (the tmux session is gone; a non-255 code).
 *
 * The re-attach reuses the peer's OWN reconnect verb — `agents sessions focus <id>
 * --local --attach-only` joins the live local tmux pane there (no fork, no resumed
 * copy) — so there is no second re-attach implementation to keep in sync.
 *
 * The retry policy is a pure state machine (`reconnectStep`) so it is unit-tested
 * without touching SSH; the loop (`reconnectInteractiveSession`) only adds the real
 * `sshStream` re-attach and the wait.
 */
import { sshStream, shellQuote } from '../ssh-exec.js';
import { sshTargetFor, type Host } from './types.js';

/** ssh's connection-layer failure code — the signal that the link dropped rather
 *  than the remote command exiting on its own. Mirrors ssh-exec.ts `sshStream`. */
export const SSH_CONN_FAILURE = 255;

/** Retry budget and backoff. A re-attach that held a live session longer than
 *  {@link LIVE_SESSION_MS} counts as a genuine reconnection, so a later drop
 *  refills the budget rather than exhausting it — a long session that blinks
 *  twenty times over a day should reconnect every time, not six times total. */
export const MAX_ATTEMPTS = 6;
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;
export const LIVE_SESSION_MS = 8_000;

export interface ReconnectState {
  /** Consecutive failed re-attach attempts since the last genuine reconnection. */
  attempt: number;
}

export interface ReconnectOutcome {
  /** Exit code of the run (initial) or the last re-attach. */
  code: number;
  /** How long that invocation held before returning, in ms. */
  durationMs: number;
}

export type ReconnectDecision =
  | { action: 'stop'; code: number }
  | { action: 'retry'; waitMs: number; state: ReconnectState };

export function initialReconnectState(): ReconnectState {
  return { attempt: 0 };
}

/** Exponential backoff capped at {@link MAX_BACKOFF_MS}: 2s, 4s, 8s, 16s, 30s… */
export function backoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
}

/**
 * Decide what to do after a run/re-attach returned `outcome`. Pure — the only
 * input is the prior state and the outcome, the only output is the next action.
 *
 *  - a non-255 code means the remote command spoke for itself (clean detach = 0,
 *    agent exit / no live session = non-zero) → stop and surface that code.
 *  - a 255 means the link dropped → retry, unless the budget is spent.
 *  - a 255 that arrived only AFTER a live session (> LIVE_SESSION_MS) refills the
 *    budget first, so an established session that blinks doesn't burn attempts.
 */
export function reconnectStep(state: ReconnectState, outcome: ReconnectOutcome): ReconnectDecision {
  if (outcome.code !== SSH_CONN_FAILURE) return { action: 'stop', code: outcome.code };
  const refilled = outcome.durationMs >= LIVE_SESSION_MS ? 0 : state.attempt;
  if (refilled >= MAX_ATTEMPTS) return { action: 'stop', code: SSH_CONN_FAILURE };
  return { action: 'retry', waitMs: backoffMs(refilled), state: { attempt: refilled + 1 } };
}

/** Human-readable notice shown before each reconnect wait. "13 seconds", not "12.8s". */
export function reconnectNotice(sessionId: string, host: string, attempt: number, waitMs: number): string {
  const secs = Math.round(waitMs / 1000);
  const when = secs <= 1 ? 'now' : `in ${secs} seconds`;
  return `\nConnection to ${host} dropped — the agent is still running there. Reconnecting to ${sessionId.slice(0, 8)} ${when} (attempt ${attempt}/${MAX_ATTEMPTS})…\n`;
}

/** Notice shown once the retry budget is spent. */
export function exhaustedNotice(sessionId: string, host: string): string {
  return `\nCouldn't reconnect to ${host} after ${MAX_ATTEMPTS} attempts. The agent may still be running — reattach when the network is back:\n  agents sessions focus ${sessionId.slice(0, 8)}\n`;
}

/** Re-attach the live remote tmux pane for `sessionId` by driving the peer's own
 *  `agents sessions focus`. This carries no credentials (the agent is already
 *  running on the peer), so it rides the normal multiplexed transport. Returns the
 *  ssh exit code (255 = still unreachable / dropped again; 0 = clean detach; other
 *  = session ended). */
export function reattachRemoteSession(host: Host, sessionId: string): number {
  const target = sshTargetFor(host);
  const remoteCmd = ['agents', 'sessions', 'focus', sessionId, '--local', '--attach-only']
    .map(shellQuote)
    .join(' ');
  return sshStream(target, remoteCmd, { tty: true });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface ReconnectLoopOpts {
  host: Host;
  sessionId: string;
  /** The exit code from the initial interactive run. */
  initialExit: number;
  /** How long the initial run held, in ms (for the live-session budget refill). */
  initialDurationMs: number;
  /** Injected for tests: the real re-attach and wait are swapped for deterministic
   *  fakes so the loop's control flow is exercised without SSH. Production uses the
   *  real {@link reattachRemoteSession} + `sleep`. */
  reattach?: (host: Host, sessionId: string) => ReconnectOutcome;
  wait?: (ms: number) => Promise<void>;
  write?: (s: string) => void;
}

/**
 * Drive the reconnect loop from the initial run's outcome to a terminal code.
 * Only the real SSH re-attach and the wait are side effects; the decision is
 * {@link reconnectStep}. Returns the exit code the process should ultimately use.
 */
export async function reconnectInteractiveSession(opts: ReconnectLoopOpts): Promise<number> {
  const write = opts.write ?? ((s: string) => process.stderr.write(s));
  const wait = opts.wait ?? sleep;
  const reattach =
    opts.reattach ??
    ((host, id): ReconnectOutcome => {
      const t0 = Date.now();
      const code = reattachRemoteSession(host, id);
      return { code, durationMs: Date.now() - t0 };
    });

  let state = initialReconnectState();
  let outcome: ReconnectOutcome = { code: opts.initialExit, durationMs: opts.initialDurationMs };
  for (;;) {
    const decision = reconnectStep(state, outcome);
    if (decision.action === 'stop') {
      if (decision.code === SSH_CONN_FAILURE) write(exhaustedNotice(opts.sessionId, opts.host.name));
      return decision.code;
    }
    write(reconnectNotice(opts.sessionId, opts.host.name, decision.state.attempt, decision.waitMs));
    await wait(decision.waitMs);
    state = decision.state;
    outcome = reattach(opts.host, opts.sessionId);
  }
}
