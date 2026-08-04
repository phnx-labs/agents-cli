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
 * **Why the budget refills on `connected`, not on call duration.** ssh returns 255
 * for BOTH "couldn't connect at all" and "connected, then the link dropped." A
 * failed connect still takes up to `ConnectTimeout` (10s) to return, so timing
 * alone can't tell the two apart — a duration threshold below the connect timeout
 * would classify every hung connect as a live session and retry forever under a
 * sustained outage (the exact failure this feature exists to survive). Instead each
 * attempt runs a fast preflight probe: a reattach that genuinely reconnected (and
 * then dropped again) refills the retry budget; one that never reached the host
 * counts against it, so a sustained outage gives up after MAX_ATTEMPTS.
 *
 * The retry policy is a pure state machine (`reconnectStep`) so it is unit-tested
 * without touching SSH; the loop (`reconnectInteractiveSession`) only adds the real
 * preflight + `sshStream` re-attach and the wait.
 *
 * **255 must mean exactly one thing: the ssh link to THIS host dropped.**
 * `reattachRemoteSession`'s `connected` flag is set as soon as the fast preflight
 * probe succeeds — it says nothing about whether the interactive attach that
 * follows actually reattached a live pane. If the REMOTE command (`agents
 * sessions focus <id> --local --attach-only`) itself happens to exit 255 for a
 * reason that has nothing to do with the ssh transport — its `refuseFallback`
 * fallback opening an interactive login shell on a THIRD machine, that shell
 * later closing; a nested remote-tmux hop (`jumpTo`'s "remote tmux" path in
 * commands/go.ts) dropping; any future remote-side path that happens to exit
 * 255 — `sshStream` returns that same 255, `reconnectStep` cannot tell it apart
 * from a genuine drop, and `connected: true` refills the retry budget. The loop
 * reconnects, the remote command does the same wrong thing again, closes again,
 * and repeats forever — "attempt 1/N" printed on every single cycle, the
 * terminal filling with aborted-TTY escape-code garbage, `MAX_ATTEMPTS` never
 * actually bounding anything. This is fixed at the SOURCE, not per producer:
 * {@link wrapRemoteExitCode} wraps the entire remote command so that whatever
 * exit code IT decides on, a 255 is remapped to {@link REMOTE_EXIT_255_REMAPPED}
 * before `sshStream` ever sees it — 255 is reclaimed exclusively for the local
 * ssh transport's own connection-layer failure, regardless of which remote-side
 * path produced the original code, and regardless of the peer's `agents` version
 * (the remap happens in the shell wrapper THIS process sends, not in anything
 * the peer's own binary has to understand). Both hairpin paths above are
 * covered by construction, since the wrapper sees only the whole remote
 * command's final exit code, not which internal branch produced it.
 */
import { sshExec, sshStream, shellQuote } from '../ssh-exec.js';
import { sshTargetFor, type Host } from './types.js';

/** ssh's connection-layer failure code — the signal that the link dropped rather
 *  than the remote command exiting on its own. Mirrors ssh-exec.ts `sshStream`. */
export const SSH_CONN_FAILURE = 255;

/** What a would-be-255 remote-origin exit code is remapped to by
 *  {@link wrapRemoteExitCode} — see the file header. Never produced by the ssh
 *  transport itself, so it can never be confused with {@link SSH_CONN_FAILURE}. */
export const REMOTE_EXIT_255_REMAPPED = 254;

/** Consecutive failed-to-connect reattaches before giving up. Backoff is capped at
 *  {@link MAX_BACKOFF_MS}. A reattach that actually reconnected (then dropped again)
 *  refills the budget, so a long session that blinks all day reconnects every time
 *  — only consecutive UNREACHABLE attempts exhaust it. */
export const MAX_ATTEMPTS = 6;
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;

export interface ReconnectState {
  /** Consecutive failed-to-connect reattaches since the last genuine reconnection. */
  attempt: number;
}

export interface ReconnectOutcome {
  /** Exit code of the run (initial) or the last re-attach. */
  code: number;
  /** Whether the ssh handshake for this attempt actually completed. The initial run
   *  and any reattach whose preflight probe succeeded are `connected`; a reattach
   *  that couldn't reach the host is not. Drives the budget refill (see file head). */
  connected: boolean;
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
 *  - a 255 from an attempt that DID connect (a genuine reconnection that then
 *    dropped) refills the budget first; a 255 that never connected counts against
 *    it, so a host that stays unreachable gives up after MAX_ATTEMPTS.
 */
export function reconnectStep(state: ReconnectState, outcome: ReconnectOutcome): ReconnectDecision {
  if (outcome.code !== SSH_CONN_FAILURE) return { action: 'stop', code: outcome.code };
  const attempts = outcome.connected ? 0 : state.attempt;
  if (attempts >= MAX_ATTEMPTS) return { action: 'stop', code: SSH_CONN_FAILURE };
  return { action: 'retry', waitMs: backoffMs(attempts), state: { attempt: attempts + 1 } };
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

/** Notice shown when a reattach stops on a remapped remote-side exit
 *  ({@link REMOTE_EXIT_255_REMAPPED} — a would-be-255 the remote command decided
 *  on for its own reasons, not the ssh transport dropping; see
 *  {@link wrapRemoteExitCode}). Distinct from {@link exhaustedNotice}, which is
 *  only for a genuinely spent retry budget. */
export function remoteExitNotice(sessionId: string, host: string): string {
  return `\nReattach to ${sessionId.slice(0, 8)} on ${host} ended (not a network drop) — check whether it's still live:\n  agents sessions ${sessionId.slice(0, 8)}\n`;
}

/**
 * Wrap `cmd` in `bash -lc` (the same pattern `buildRemoteAgentsInvocation` in
 * remote-cmd.ts uses for every other remote dispatch — see its own doc comment
 * for why a login shell, `bash -lc`, is used at all) with a trailing exit-code
 * remap: whatever `cmd` itself exits with, a 255 becomes
 * {@link REMOTE_EXIT_255_REMAPPED} before the wrapper exits — see the file
 * header for why. Every other code (0, 1, …) passes through unchanged. Unlike
 * `buildRemoteAgentsInvocation`'s callers, this carries no PATH bootstrap of its
 * own — `ensureHostReady`/`readyProbe` already gates every `--host` dispatch on
 * `bash -lc 'agents --version'` succeeding before a run is attempted at all, so
 * the peer's login shell resolving `agents` is an established precondition, not
 * something this wrapper needs to re-derive. Pure string-building, so it is
 * unit-tested without SSH (and, since the constructed script is ordinary POSIX,
 * also exercised by actually running it through a real shell in the test — no
 * mock needed).
 */
export function wrapRemoteExitCode(cmd: string): string {
  const guarded = `${cmd}; rc=$?; [ "$rc" = "${SSH_CONN_FAILURE}" ] && rc=${REMOTE_EXIT_255_REMAPPED}; exit "$rc"`;
  return `bash -lc ${shellQuote(guarded)}`;
}

/**
 * The remote command a reattach runs — the peer's own reconnect verb
 * (`agents sessions focus <id> --local --attach-only`), wrapped by
 * {@link wrapRemoteExitCode} so a stray remote-origin 255 (an unsupervised
 * shell fallback closing, a nested remote-tmux hop dropping) can never
 * masquerade as a network drop. Split out from {@link reattachRemoteSession} so
 * it is unit-tested without SSH — mirrors `remoteAgentsJsonCommand` in
 * lib/remote-agents-json.ts.
 */
export function reattachRemoteCommand(sessionId: string): string {
  const inner = ['agents', 'sessions', 'focus', sessionId, '--local', '--attach-only']
    .map(shellQuote)
    .join(' ');
  return wrapRemoteExitCode(inner);
}

/**
 * Re-attach the live remote tmux pane for `sessionId` by driving the peer's own
 * `agents sessions focus`. A fast, un-multiplexed preflight probe (`ssh … true`)
 * first establishes whether the host is actually reachable this attempt — that
 * `connected` bit, not the call duration, is what the retry policy keys on. Only on
 * a reachable host do we run the interactive attach (which carries no credentials —
 * the agent already runs on the peer — so it rides the normal transport). Returns
 * the ssh exit code (255 = dropped again / unreachable; 0 = clean detach; other =
 * session ended) plus whether this attempt connected.
 */
export function reattachRemoteSession(host: Host, sessionId: string): ReconnectOutcome {
  const target = sshTargetFor(host);
  // Fresh (non-multiplexed) reachability probe: code 0 means the handshake actually
  // completed, so a hung/failed connect is never mistaken for a live reconnection.
  const probe = sshExec(target, 'true', { multiplex: false });
  if (probe.code !== 0) return { code: SSH_CONN_FAILURE, connected: false };
  return { code: sshStream(target, reattachRemoteCommand(sessionId), { tty: true }), connected: true };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface ReconnectLoopOpts {
  host: Host;
  sessionId: string;
  /** The exit code from the initial interactive run (which, having run the agent,
   *  is treated as a connected attempt). */
  initialExit: number;
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
  const reattach = opts.reattach ?? reattachRemoteSession;

  let state = initialReconnectState();
  // The initial run reached the point of running the agent, so it connected.
  let outcome: ReconnectOutcome = { code: opts.initialExit, connected: true };
  for (;;) {
    const decision = reconnectStep(state, outcome);
    if (decision.action === 'stop') {
      if (decision.code === SSH_CONN_FAILURE) write(exhaustedNotice(opts.sessionId, opts.host.name));
      else if (decision.code === REMOTE_EXIT_255_REMAPPED) write(remoteExitNotice(opts.sessionId, opts.host.name));
      return decision.code;
    }
    write(reconnectNotice(opts.sessionId, opts.host.name, decision.state.attempt, decision.waitMs));
    await wait(decision.waitMs);
    state = decision.state;
    outcome = reattach(opts.host, opts.sessionId);
  }
}
