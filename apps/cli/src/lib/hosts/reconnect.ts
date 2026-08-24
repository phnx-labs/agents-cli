/**
 * Auto-reconnect for an interactive `agents run --device` session whose
 * SSH link dropped.
 *
 * A remote interactive agent runs in a DETACHED tmux session on the peer (see
 * lib/exec.ts `runInTmux`), so a network blink kills only the local ssh client —
 * the agent keeps running.
 *
 * **That premise is a guarantee, not a hope, only since RUSH-3125.** It used to
 * rest on the peer's `tmux.enabled`, an ergonomics preference that defaults OFF
 * — so on a default box the agent was a child of the sshd session, a blink
 * SIGHUPed it, and this file reconnected to a corpse while telling the user it
 * was "still running there." The interactive dispatch now exports
 * REMOTE_INTERACTIVE_ENV and exec.ts `resolveTmuxWrap` wraps on it regardless of
 * that toggle, so what is written below actually holds. Anything that would let
 * a remote interactive run reach the peer unwrapped breaks this whole file.
 *
 * `sshStream` reports that drop as exit code 255 (ssh's
 * own connection-layer failure; see ssh-exec.ts). Without this, exec.ts would
 * `process.exit(255)` and the user would have to notice, find the session id, and
 * `agents sessions focus` by hand. Instead we re-attach the live remote pane over
 * SSH automatically, with bounded backoff, until the user detaches cleanly (the
 * remote returns 0), the agent exits (the tmux session is gone; a non-255 code),
 * or the user interrupts the wait with Ctrl-C ({@link waitOrInterrupt} → 130).
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
 * fast-flapping link both give up once {@link RECONNECT_WINDOW_MS} of unproductive
 * retrying has elapsed.
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
 * garbage, the retry window never actually bounding anything.
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
 * single time — refilled the budget on every cycle, printed "attempt 1" forever,
 * and left the retry window bounding nothing. The {@link MIN_HOLD_MS} floor above is
 * what closes it: an attach that dies immediately is not a reconnection, so the
 * budget drains and the loop gives up with {@link unstableNotice}. A flat total-
 * attempt or wall-clock ceiling that ignored `connected` was the alternative and is
 * deliberately NOT taken — any fixed total eventually strands the all-day-blinking
 * session this feature exists for, while the hold floor only ever stops a loop that
 * is failing to put the user back into the agent.
 */
import { sshExec, sshStream, shellQuote } from '../ssh-exec.js';
import { hostIdentityArgs, sshTargetFor, type Host } from './types.js';
import { RUN_AUTO_KEYWORD } from '../types.js';

/** ssh's connection-layer failure code — the signal that the link dropped rather
 *  than the remote command exiting on its own. Mirrors ssh-exec.ts `sshStream`. */
export const SSH_CONN_FAILURE = 255;

/** What a would-be-255 remote-origin exit code is remapped to by
 *  {@link wrapRemoteExitCode} — see the file header. Never produced by the ssh
 *  transport itself, so it can never be confused with {@link SSH_CONN_FAILURE}. */
export const REMOTE_EXIT_255_REMAPPED = 254;

/**
 * How long the loop keeps trying across an UNPRODUCTIVE streak before giving up.
 *
 * A wall-clock window, not an attempt count, because what it has to outlast is
 * measured in minutes: a laptop lid close, a Wi-Fi handoff, a VPN or Tailscale
 * re-auth, a router reboot. The previous `MAX_ATTEMPTS = 6` over a 2/4/8/16/30/30
 * backoff gave up after about **90 seconds** — shorter than any of them
 * (RUSH-3125). Worse, timers are suspended across sleep, so on wake the whole
 * backoff fired back-to-back before the network was up and the budget was gone in
 * seconds.
 *
 * It bounds the STREAK, not the session: a reattach that reconnects and HOLDS
 * resets it to zero ({@link refillsBudget}), so a session that blinks all day
 * still reconnects every time. That is the property the file header insists on,
 * and a flat total would break it — this changes only how a *streak* is bounded.
 */
export const RECONNECT_WINDOW_MS = 15 * 60_000;

/** Backoff curve for a streak: 2s, 4s, 8s, 16s, 30s, then 30s until the window
 *  closes. Capped so a long outage keeps probing at a useful cadence instead of
 *  drifting out to multi-minute gaps and missing the moment the link returns. */
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
   *  that reached the host and held for {@link MIN_HOLD_MS}. Drives the backoff
   *  curve and the human-facing attempt number; no longer the give-up condition. */
  attempt: number;
  /** Wall-clock ms burned on the current unproductive streak — the waits plus the
   *  time each failed attach itself took. Compared against
   *  {@link RECONNECT_WINDOW_MS}; reset to 0 by a reattach that held. */
  unproductiveMs: number;
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
  | { action: 'retry'; waitMs: number; state: ReconnectState; remainingMs: number };

export function initialReconnectState(): ReconnectState {
  return { attempt: 0, unproductiveMs: 0 };
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
 *    both give up once the retry window closes.
 */
export function reconnectStep(state: ReconnectState, outcome: ReconnectOutcome): ReconnectDecision {
  if (outcome.code !== SSH_CONN_FAILURE) return { action: 'stop', code: outcome.code };
  const productive = refillsBudget(outcome);
  const attempts = productive ? 0 : state.attempt;
  // The attach's own duration counts against the window: a 10s connect timeout
  // burned on every attempt is real elapsed time the user is waiting, and
  // ignoring it would stretch a "15 minute" window well past fifteen minutes.
  const burned = productive ? 0 : state.unproductiveMs + outcome.heldMs;
  if (burned >= RECONNECT_WINDOW_MS) return { action: 'stop', code: SSH_CONN_FAILURE };
  const waitMs = backoffMs(attempts);
  return {
    action: 'retry',
    waitMs,
    state: { attempt: attempts + 1, unproductiveMs: burned + waitMs },
    remainingMs: Math.max(0, RECONNECT_WINDOW_MS - (burned + waitMs)),
  };
}

/** "14m51s", "51s" — a duration a waiting human can read at a glance. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return m > 0 ? `${m}m${String(sec).padStart(2, '0')}s` : `${sec}s`;
}

/**
 * Notice shown before each reconnect wait.
 *
 * Says how long is left in the window rather than "attempt 2/6": with a
 * wall-clock budget the attempt number no longer tells the user when this stops,
 * and "how much longer will it keep trying" is the actual question during an
 * outage. Ctrl-C is advertised because a user who wants their shell back should
 * not have to guess whether interrupting is safe — it is (the agent keeps
 * running on the peer, which is the whole point).
 */
export function reconnectNotice(target: ReconnectTarget, host: string, attempt: number, waitMs: number, remainingMs: number): string {
  const secs = Math.round(waitMs / 1000);
  const when = secs <= 1 ? 'now' : `in ${secs}s`;
  return `\nConnection to ${host} dropped — ${targetLabel(target)} is still running there.`
    + `\n  Reconnecting ${when} · ${formatDuration(remainingMs)} left · attempt ${attempt} · Ctrl-C to stop\n`;
}

/** Notice shown once the retry budget is spent on a host that stayed UNREACHABLE.
 *  Hands back the one verb that re-enters the terminal — attach the live pane if it
 *  survived, else resume. */
export function exhaustedNotice(target: ReconnectTarget, host: string): string {
  return `\nCouldn't reconnect to ${host} after ${formatDuration(RECONNECT_WINDOW_MS)}. The agent may still be running — get back in when the network is back:\n${recoveryHint(target, host)}`;
}

/** Notice shown when the budget is spent the OTHER way: the last reattach reached
 *  the host and the connection dropped again within {@link MIN_HOLD_MS}. Saying
 *  "couldn't reconnect" there would be false — it did reconnect and could not stay
 *  — and the user needs to know the link, not the host, is the problem. It claims
 *  no count of successful reconnections: the budget can also be spent by a run of
 *  unreachable attempts followed by one that reconnected and dropped straight out. */
export function unstableNotice(target: ReconnectTarget, host: string): string {
  const secs = Math.round(MIN_HOLD_MS / 1000);
  return `\nGave up reconnecting to ${host} after ${formatDuration(RECONNECT_WINDOW_MS)} — it kept dropping again within ${secs} seconds of getting back in. The agent may still be running there; reconnect once the link is stable:\n${recoveryHint(target, host)}`;
}

/** Notice shown when a reattach stops on a remapped remote-side exit
 *  ({@link REMOTE_EXIT_255_REMAPPED} — a would-be-255 the remote command decided
 *  on for its own reasons, not the ssh transport dropping; see
 *  {@link wrapRemoteExitCode}). Distinct from {@link exhaustedNotice}, which is
 *  only for a genuinely spent retry budget. */
export function remoteExitNotice(target: ReconnectTarget, host: string): string {
  return `\nReattach to ${targetLabel(target)} on ${host} ended (not a network drop) — get back in, or check whether it's still live:\n${recoveryHint(target, host)}`;
}

/** Shown when the user Ctrl-Cs out of the wait. The agent is untouched — it is
 *  detached on the peer — so this says how to get back rather than implying the
 *  work was lost. */
export function interruptedNotice(target: ReconnectTarget, host: string): string {
  return `\nStopped reconnecting. ${targetLabel(target)} is still running on ${host}:\n${recoveryHint(target, host)}`;
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
 * gates every `--device` dispatch on `bash -lc 'agents --version'` succeeding
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
 * How a dropped run is named when we go back for it.
 *
 * `session` is the direct case: the id was known before the link died — Claude
 * is handed one up front, and a resumed run already has one.
 *
 * `launch` is what makes reconnect work for every OTHER harness (RUSH-3125).
 * Their real session id is coined on the peer, and the launcher used to read it
 * back over SSH *after* the stream returned — i.e. over the link that had just
 * dropped. That read fails exactly when it matters, leaving `reconnectId`
 * undefined and the process exiting straight to a shell, which is why a Grok tab
 * got no reconnect at all while a Claude tab beside it got a countdown. The
 * launch id is minted locally before the connection exists, so it survives the
 * drop; the peer maps it to the real session with a purely local lookup.
 */
export type ReconnectTarget =
  | { kind: 'session'; id: string }
  | { kind: 'launch'; id: string };

/** The short form shown to a human. Both kinds are uuid-shaped, so 8 chars reads the same. */
export function targetLabel(target: ReconnectTarget): string {
  return target.id.slice(0, 8);
}

/**
 * The command to hand a user whose reconnect gave up.
 *
 * A `session` target has a real id, so `agents sessions resume <id>` does the
 * same attach-else-recover the loop was attempting. (It used to say `agents
 * reconnect`, which is deprecated and hidden — `commands/reconnect.ts` — so the
 * advice printed at the worst possible moment was itself stale; RUSH-3125.)
 *
 * A `launch` target has no id a user-facing verb accepts: the mapping lives in
 * the peer's hook records, which is exactly why reconnect uses it. So point at
 * the peer's own resolver rather than inventing a launch-id selector on every
 * local command for a string no human ever types.
 */
export function recoveryHint(target: ReconnectTarget, host: string): string {
  return target.kind === 'session'
    ? `  agents sessions resume ${target.id}\n`
    : `  agents ssh ${host} 'agents sessions focus --launch-id ${target.id} --local'\n`
      + `  or pick it:  agents sessions --active\n`;
}

/** What the launcher knows about a run once its interactive stream has returned. */
export interface ReconnectTargetInputs {
  /** The harness (or {@link RUN_AUTO_KEYWORD}) that was dispatched. */
  agent: string;
  /** An id forced by the launcher up front — Claude's `--session-id`. */
  sessionId?: string;
  /** An id read back off the peer AFTER the stream returned. Absent on a drop. */
  resolvedId?: string;
  /** The id of a run that was resuming an existing session. */
  resumeId?: string;
  /** The launcher-minted AGENT_LAUNCH_ID, known before the connection existed. */
  launchId?: string;
}

/**
 * Choose how to name the dropped run when going back for it.
 *
 * Order matters, and the last clause is the fix (RUSH-3125):
 *
 *  1. `run auto` prefers `resolvedId` — the harness the remote ACTUALLY picked,
 *     which the launcher's own `--session-id` (adopted only by Claude) may not
 *     name. Every other agent prefers the id the launcher forced.
 *  2. `resumeId` covers a run that was continuing a known session.
 *  3. **`launchId` last, and it is what makes this work at all off-Claude.**
 *     Every id above either came from the launcher or was read back over SSH —
 *     and that read happens after the stream returned, i.e. over the link that
 *     just died, so on a real drop it yields nothing. Falling through to the
 *     launch id means the reconnect no longer depends on reaching the host to
 *     learn what to reconnect to; the peer resolves it locally instead.
 *
 * Returns undefined only when the launcher has no handle at all (a hookless
 * harness with no forced id), which is the one case reconnect genuinely cannot
 * serve. Pure, so the precedence is unit-tested without SSH.
 */
export function pickReconnectTarget(inputs: ReconnectTargetInputs): ReconnectTarget | undefined {
  const { agent, sessionId, resolvedId, resumeId, launchId } = inputs;
  const preferred = agent === RUN_AUTO_KEYWORD
    ? resolvedId ?? sessionId
    : sessionId ?? resolvedId;
  const id = preferred ?? resumeId;
  if (id) return { kind: 'session', id };
  return launchId ? { kind: 'launch', id: launchId } : undefined;
}

/**
 * The remote command a reattach runs — the peer's own recovery verb
 * (`agents sessions focus … --local`), wrapped by {@link wrapRemoteExitCode}
 * so a stray remote-origin 255 (from this command, whatever produces it — see the
 * file header) can never masquerade as a network drop. No `--attach-only`: focus
 * joins the live pane when it survived, else RESUMES the session in place, so a
 * reattach landing after the pane died recovers the agent instead of dead-ending
 * (RUSH-2085). Split out from {@link reattachRemoteSession} so it is unit-tested
 * without SSH — mirrors `remoteAgentsJsonCommand` in lib/remote-agents-json.ts.
 *
 * A `launch` target passes `--launch-id`, which focus resolves against the hook
 * records on the peer itself — no network read from this side, which is the
 * whole point (see {@link ReconnectTarget}).
 */
export function reattachRemoteCommand(target: ReconnectTarget): string {
  const selector = target.kind === 'launch'
    ? ['--launch-id', target.id]
    : [target.id];
  const inner = ['agents', 'sessions', 'focus', ...selector, '--local']
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
export function reattachRemoteSession(host: Host, target: ReconnectTarget): ReconnectOutcome {
  const sshTarget = sshTargetFor(host);
  const extraSshArgs = hostIdentityArgs(host);
  // Fresh (non-multiplexed) reachability probe: code 0 means the handshake actually
  // completed, so a hung/failed connect is never mistaken for a live reconnection.
  // RUSH-2265: pass host identity on every hop (probe + stream), not only the first.
  const probe = sshExec(sshTarget, 'true', { multiplex: false, extraSshArgs });
  if (probe.code !== 0) return { code: SSH_CONN_FAILURE, connected: false, heldMs: 0 };
  // Timed from AFTER the probe returned, so this is the attach's own duration and
  // carries none of the connect phase the file header rules out as a signal.
  const startedAt = Date.now();
  const code = sshStream(sshTarget, reattachRemoteCommand(target), { tty: true, extraSshArgs });
  return { code, connected: true, heldMs: Date.now() - startedAt };
}

/**
 * Wait `ms`, but return early if the user interrupts.
 *
 * Without this, Ctrl-C during the backoff killed the whole `agents` process:
 * node's default SIGINT handler exits, so the loop never got to say what
 * happened, the terminal was left mid-notice, and the user was dropped at a bare
 * shell with no hint that the agent was still alive on the peer — the same
 * dead-end the reconnect exists to prevent. The handler is installed only for
 * the duration of the wait and always removed, so it can never swallow a Ctrl-C
 * meant for the attached agent (during an attach, ssh owns the tty and this
 * process is not in the foreground group anyway).
 */
async function waitOrInterrupt(ms: number): Promise<'elapsed' | 'interrupted'> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (how: 'elapsed' | 'interrupted') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.removeListener('SIGINT', onSigint);
      resolve(how);
    };
    const onSigint = () => finish('interrupted');
    const timer = setTimeout(() => finish('elapsed'), ms);
    process.on('SIGINT', onSigint);
  });
}

export interface ReconnectLoopOpts {
  host: Host;
  target: ReconnectTarget;
  /** The exit code from the initial interactive run (which, having run the agent,
   *  is treated as a connected attempt). */
  initialExit: number;
  /** Injected for tests: the real re-attach and wait are swapped for deterministic
   *  fakes so the loop's control flow is exercised without SSH. Production uses the
   *  real {@link reattachRemoteSession} + {@link waitOrInterrupt}. */
  reattach?: (host: Host, target: ReconnectTarget) => ReconnectOutcome;
  /** Resolves 'interrupted' when the user Ctrl-Cs out of the backoff. */
  wait?: (ms: number) => Promise<'elapsed' | 'interrupted'>;
  write?: (s: string) => void;
}

/**
 * Drive the reconnect loop from the initial run's outcome to a terminal code.
 * Only the real SSH re-attach and the wait are side effects; the decision is
 * {@link reconnectStep}. Returns the exit code the process should ultimately use.
 */
export async function reconnectInteractiveSession(opts: ReconnectLoopOpts): Promise<number> {
  const write = opts.write ?? ((s: string) => process.stderr.write(s));
  const wait = opts.wait ?? waitOrInterrupt;
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
          ? unstableNotice(opts.target, opts.host.name)
          : exhaustedNotice(opts.target, opts.host.name));
      } else if (decision.code === REMOTE_EXIT_255_REMAPPED) {
        write(remoteExitNotice(opts.target, opts.host.name));
      }
      return decision.code;
    }
    write(reconnectNotice(opts.target, opts.host.name, decision.state.attempt, decision.waitMs, decision.remainingMs));
    if (await wait(decision.waitMs) === 'interrupted') {
      // The user asked for their shell back. Nothing was lost — say where the
      // agent is and how to return, then exit as an interrupt (128 + SIGINT).
      write(interruptedNotice(opts.target, opts.host.name));
      return 130;
    }
    state = decision.state;
    outcome = reattach(opts.host, opts.target);
  }
}
