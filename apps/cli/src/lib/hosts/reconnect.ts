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
 * The re-attach reuses the peer's OWN recovery verb — `agents sessions focus <id>
 * --local` — which JOINS the live local tmux pane there (a second client, no fork)
 * when it still exists, and RESUMES the session in place when the pane is already
 * gone. Dropping `--attach-only` is deliberate: a reattach that lands after the
 * remote pane died must not dead-end at a bare shell (the RUSH-2085 bug), it must
 * fall through to resume so the user is put back into the agent. There is one
 * re-attach implementation (the peer's focus) to keep in sync.
 *
 * **What it takes to refill the budget: reached the host AND held the pane.** ssh
 * returns 255 for BOTH "couldn't connect at all" and "connected, then the link
 * dropped." A failed connect still takes up to `ConnectTimeout` (10s) to return, so
 * the duration of the whole call can't tell the two apart — a threshold below the
 * connect timeout would classify every hung connect as a live session and retry
 * forever under a sustained outage (the exact failure this feature exists to
 * survive). So each attempt runs a fast preflight probe FIRST, and only once that
 * probe proves the host reachable does the interactive attach run — which means the
 * ATTACH's own duration is a clean signal, measured with the connect phase already
 * behind it. A reattach that reached the host and then held for at least
 * {@link MIN_HOLD_MS} refills the retry budget, so a long session that blinks all
 * day keeps reconnecting. Everything else — never reached the host, or reached it
 * and died right back — counts against the budget, so a sustained outage and a
 * fast-flapping link both give up after {@link MAX_ATTEMPTS}.
 *
 * The retry policy is a pure state machine (`reconnectStep`) so it is unit-tested
 * without touching SSH; the loop (`reconnectInteractiveSession`) only adds the real
 * preflight + `sshStream` re-attach and the wait.
 *
 * **255 from the REMOTE side should never be trusted as "the link dropped."**
 * `reattachRemoteSession`'s `connected` flag is set as soon as the fast preflight
 * probe succeeds — it says nothing about whether the interactive attach/resume
 * that follows actually put the user back into the agent. If the REMOTE command
 * (`agents sessions focus <id> --local`) itself ever happened to exit 255 for a
 * reason that has nothing to do with the ssh transport, `sshStream` would return
 * that same 255, `reconnectStep` couldn't tell it apart from a genuine drop, and
 * `connected: true` would refill the retry budget forever — "attempt 1/N" printed
 * on every single cycle, the terminal filling with aborted-TTY escape-code
 * garbage, `MAX_ATTEMPTS` never actually bounding anything.
 *
 * The resume fall-through only widens that surface — the peer's focus now runs a
 * full recovery path (`resumeSessionInPlace` / `runOnPeer`) on a dead pane, any
 * step of which could in principle exit 255 for its own reasons. So the channel-
 * level defense is what matters, not an audit of which branch can fire:
 * {@link wrapRemoteExitCode} wraps the entire remote command so that whatever exit
 * code it decides on, a 255 is remapped to {@link REMOTE_EXIT_255_REMAPPED} before
 * `sshStream` ever sees it, regardless of which internal branch produced it and
 * regardless of the peer's `agents` version (the remap happens in the shell
 * wrapper THIS process sends).
 *
 * A recurring LOCAL ssh failure used to defeat the budget the same way, and the
 * remap alone did not close it (agents-cli#1884): `connected` was set by the
 * preflight probe and said nothing about whether the attach that followed held, so
 * a fast-flapping link — or an attach that died at the TTY-negotiation stage every
 * single time — refilled the budget on every cycle, printed "attempt 1/N" forever,
 * and left `MAX_ATTEMPTS` bounding nothing. The {@link MIN_HOLD_MS} floor above is
 * what closes it: an attach that dies immediately is not a reconnection, so the
 * budget drains and the loop gives up with {@link unstableNotice}. A flat total-
 * attempt or wall-clock ceiling that ignored `connected` was the alternative and is
 * deliberately NOT taken — any fixed total eventually strands the all-day-blinking
 * session this feature exists for, while the hold floor only ever stops a loop that
 * is failing to put the user back into the agent.
 */
import { sshExec, sshStream, shellQuote } from '../ssh-exec.js';
import { hostIdentityArgs, sshTargetFor, type Host } from './types.js';

/** ssh's connection-layer failure code — the signal that the link dropped rather
 *  than the remote command exiting on its own. Mirrors ssh-exec.ts `sshStream`. */
export const SSH_CONN_FAILURE = 255;

/** What a would-be-255 remote-origin exit code is remapped to by
 *  {@link wrapRemoteExitCode} — see the file header. Never produced by the ssh
 *  transport itself, so it can never be confused with {@link SSH_CONN_FAILURE}. */
export const REMOTE_EXIT_255_REMAPPED = 254;

/** Consecutive unproductive reattaches before giving up. Backoff is capped at
 *  {@link MAX_BACKOFF_MS}. A reattach that reconnected and HELD (then dropped again)
 *  refills the budget, so a long session that blinks all day reconnects every time —
 *  an attempt that never reached the host, or reached it and died back inside
 *  {@link MIN_HOLD_MS}, counts against it. */
export const MAX_ATTEMPTS = 6;
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;

/** How long a reattach must hold the remote pane before it counts as a genuine
 *  reconnection that refills the budget. Measured on the interactive attach ALONE
 *  — the preflight probe has already returned by then, so this is not the connect
 *  timing the file header rules out. 10s is comfortably longer than any attach that
 *  dies during TTY negotiation and far shorter than a session the user is working
 *  in; a link that drops the user out inside 10s on every attempt is one this loop
 *  should stop retrying, not one it should keep re-entering. */
export const MIN_HOLD_MS = 10_000;

export interface ReconnectState {
  /** Consecutive unproductive reattaches since the last genuine reconnection — one
   *  that reached the host and held for {@link MIN_HOLD_MS}. */
  attempt: number;
}

export interface ReconnectOutcome {
  /** Exit code of the run (initial) or the last re-attach. */
  code: number;
  /** Whether the ssh handshake for this attempt actually completed. The initial run
   *  and any reattach whose preflight probe succeeded are `connected`; a reattach
   *  that couldn't reach the host is not. Half of the budget refill (see file head). */
  connected: boolean;
  /** Wall-clock ms the interactive attach ran for, timed from after the preflight
   *  probe returned. `0` when the attempt never reached the host. The other half of
   *  the refill: it must be at least {@link MIN_HOLD_MS} to count as a genuine
   *  reconnection rather than a link that drops the user straight back out. */
  heldMs: number;
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
 * Did this attempt genuinely put the user back into the agent? Only such an attempt
 * refills the retry budget — it must have reached the host AND held the pane for at
 * least {@link MIN_HOLD_MS}. An attach that reached the host and died right back is
 * a flapping link, not a reconnection, and counts against the budget like an
 * unreachable host (agents-cli#1884; see the file header).
 */
export function refillsBudget(outcome: ReconnectOutcome): boolean {
  return outcome.connected && outcome.heldMs >= MIN_HOLD_MS;
}

/**
 * Decide what to do after a run/re-attach returned `outcome`. Pure — the only
 * input is the prior state and the outcome, the only output is the next action.
 *
 *  - a non-255 code means the remote command spoke for itself (clean detach = 0,
 *    agent exit / no live session = non-zero) → stop and surface that code.
 *  - a 255 means the link dropped → retry, unless the budget is spent.
 *  - a 255 from an attempt that reconnected AND held ({@link refillsBudget})
 *    refills the budget first; every other 255 counts against it, so a host that
 *    stays unreachable — and a link that keeps dropping the attach immediately —
 *    both give up after MAX_ATTEMPTS.
 */
export function reconnectStep(state: ReconnectState, outcome: ReconnectOutcome): ReconnectDecision {
  if (outcome.code !== SSH_CONN_FAILURE) return { action: 'stop', code: outcome.code };
  const attempts = refillsBudget(outcome) ? 0 : state.attempt;
  if (attempts >= MAX_ATTEMPTS) return { action: 'stop', code: SSH_CONN_FAILURE };
  return { action: 'retry', waitMs: backoffMs(attempts), state: { attempt: attempts + 1 } };
}

/** Human-readable notice shown before each reconnect wait. "13 seconds", not "12.8s". */
export function reconnectNotice(sessionId: string, host: string, attempt: number, waitMs: number): string {
  const secs = Math.round(waitMs / 1000);
  const when = secs <= 1 ? 'now' : `in ${secs} seconds`;
  return `\nConnection to ${host} dropped — the agent is still running there. Reconnecting to ${sessionId.slice(0, 8)} ${when} (attempt ${attempt}/${MAX_ATTEMPTS})…\n`;
}

/** Notice shown once the retry budget is spent on a host that stayed UNREACHABLE.
 *  Hands back the one verb that re-enters the terminal — attach the live pane if it
 *  survived, else resume. */
export function exhaustedNotice(sessionId: string, host: string): string {
  return `\nCouldn't reconnect to ${host} after ${MAX_ATTEMPTS} attempts. The agent may still be running — get back in when the network is back:\n  agents reconnect ${sessionId.slice(0, 8)}\n`;
}

/** Notice shown when the budget is spent the OTHER way: the last reattach reached
 *  the host and the connection dropped again within {@link MIN_HOLD_MS}. Saying
 *  "couldn't reconnect" there would be false — it did reconnect and could not stay
 *  — and the user needs to know the link, not the host, is the problem. It claims
 *  no count of successful reconnections: the budget can also be spent by a run of
 *  unreachable attempts followed by one that reconnected and dropped straight out. */
export function unstableNotice(sessionId: string, host: string): string {
  const secs = Math.round(MIN_HOLD_MS / 1000);
  return `\nGave up reconnecting to ${host} after ${MAX_ATTEMPTS} attempts — it kept dropping again within ${secs} seconds of getting back in. The agent may still be running there; reconnect once the link is stable:\n  agents reconnect ${sessionId.slice(0, 8)}\n`;
}

/** Notice shown when a reattach stops on a remapped remote-side exit
 *  ({@link REMOTE_EXIT_255_REMAPPED} — a would-be-255 the remote command decided
 *  on for its own reasons, not the ssh transport dropping; see
 *  {@link wrapRemoteExitCode}). Distinct from {@link exhaustedNotice}, which is
 *  only for a genuinely spent retry budget. */
export function remoteExitNotice(sessionId: string, host: string): string {
  return `\nReattach to ${sessionId.slice(0, 8)} on ${host} ended (not a network drop) — get back in, or check whether it's still live:\n  agents reconnect ${sessionId.slice(0, 8)}\n`;
}

/**
 * Wrap `cmd` in `bash -lc` (the login-shell pattern `buildRemoteAgentsInvocation`
 * in remote-cmd.ts uses for its own POSIX callers — see its doc comment for why
 * a login shell at all; the sibling interactive dispatch in dispatch.ts sends a
 * bare `agents …` with no shell wrapper, so this is a NEW login-shell hop on the
 * reattach path specifically, not something already universal here) with a
 * trailing exit-code remap: whatever `cmd` itself exits with, a 255 becomes
 * {@link REMOTE_EXIT_255_REMAPPED} before the wrapper exits — see the file
 * header for why. Every other code (0, 1, …) passes through unchanged. This
 * carries no PATH bootstrap of its own — `ensureHostReady`/`readyProbe` already
 * gates every `--host` dispatch on `bash -lc 'agents --version'` succeeding
 * before a run is attempted at all, so the peer's login shell resolving `agents`
 * is an established precondition here too. Pure string-building, so it is
 * unit-tested without SSH (and, since the constructed script is ordinary POSIX,
 * also exercised by actually running it through a real shell in the test — no
 * mock needed).
 */
export function wrapRemoteExitCode(cmd: string): string {
  const guarded = `${cmd}; rc=$?; [ "$rc" = "${SSH_CONN_FAILURE}" ] && rc=${REMOTE_EXIT_255_REMAPPED}; exit "$rc"`;
  return `bash -lc ${shellQuote(guarded)}`;
}

/**
 * The remote command a reattach runs — the peer's own recovery verb
 * (`agents sessions focus <id> --local`), wrapped by {@link wrapRemoteExitCode}
 * so a stray remote-origin 255 (from this command, whatever produces it — see the
 * file header) can never masquerade as a network drop. No `--attach-only`: focus
 * joins the live pane when it survived, else RESUMES the session in place, so a
 * reattach landing after the pane died recovers the agent instead of dead-ending
 * (RUSH-2085). Split out from {@link reattachRemoteSession} so it is unit-tested
 * without SSH — mirrors `remoteAgentsJsonCommand` in lib/remote-agents-json.ts.
 */
export function reattachRemoteCommand(sessionId: string): string {
  const inner = ['agents', 'sessions', 'focus', sessionId, '--local']
    .map(shellQuote)
    .join(' ');
  return wrapRemoteExitCode(inner);
}

/**
 * Re-attach the live remote tmux pane for `sessionId` by driving the peer's own
 * `agents sessions focus`. A fast, un-multiplexed preflight probe (`ssh … true`)
 * first establishes whether the host is actually reachable this attempt — that
 * `connected` bit, not the call duration, is what the retry policy keys on. Only on
 * a reachable host do we run the interactive attach-or-resume (which carries no
 * credentials — the agent already runs on the peer — so it rides the normal
 * transport). Returns the ssh exit code (255 = dropped again / unreachable; 0 =
 * clean detach; other = session ended), whether this attempt connected, and how
 * long the attach held — the two inputs {@link refillsBudget} decides on.
 */
export function reattachRemoteSession(host: Host, sessionId: string): ReconnectOutcome {
  const target = sshTargetFor(host);
  const extraSshArgs = hostIdentityArgs(host);
  // Fresh (non-multiplexed) reachability probe: code 0 means the handshake actually
  // completed, so a hung/failed connect is never mistaken for a live reconnection.
  // RUSH-2265: pass host identity on every hop (probe + stream), not only the first.
  const probe = sshExec(target, 'true', { multiplex: false, extraSshArgs });
  if (probe.code !== 0) return { code: SSH_CONN_FAILURE, connected: false, heldMs: 0 };
  // Timed from AFTER the probe returned, so this is the attach's own duration and
  // carries none of the connect phase the file header rules out as a signal.
  const startedAt = Date.now();
  const code = sshStream(target, reattachRemoteCommand(sessionId), { tty: true, extraSshArgs });
  return { code, connected: true, heldMs: Date.now() - startedAt };
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
  // The initial run reached the point of running the agent, so it connected. Its
  // hold duration is never measured — exec.ts owns that call — and never needs to
  // be: refilling is a no-op at attempt 0, which is where the loop starts, so this
  // outcome can only ever produce the first retry either way.
  let outcome: ReconnectOutcome = { code: opts.initialExit, connected: true, heldMs: 0 };
  for (;;) {
    const decision = reconnectStep(state, outcome);
    if (decision.action === 'stop') {
      // A spent budget has two shapes and one wrong message: `outcome` is the
      // reattach that spent it, so an unreachable host reads "couldn't reconnect"
      // and a link that reconnected but kept dropping reads as exactly that.
      if (decision.code === SSH_CONN_FAILURE) {
        write(outcome.connected
          ? unstableNotice(opts.sessionId, opts.host.name)
          : exhaustedNotice(opts.sessionId, opts.host.name));
      } else if (decision.code === REMOTE_EXIT_255_REMAPPED) {
        write(remoteExitNotice(opts.sessionId, opts.host.name));
      }
      return decision.code;
    }
    write(reconnectNotice(opts.sessionId, opts.host.name, decision.state.attempt, decision.waitMs));
    await wait(decision.waitMs);
    state = decision.state;
    outcome = reattach(opts.host, opts.sessionId);
  }
}
