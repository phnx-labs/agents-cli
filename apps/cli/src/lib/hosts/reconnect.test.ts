/**
 * Tests for the interactive-session auto-reconnect policy. The load-bearing logic
 * is the pure state machine `reconnectStep` + `backoffMs` — exercised directly with
 * real inputs, no mocks. `reconnectInteractiveSession` is driven through that same
 * real state machine; only the two genuinely-external effects (the SSH re-attach and
 * the wall-clock wait) are supplied as deterministic sequences, because SSH cannot
 * run in CI. No production code path is stubbed.
 */
import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import type { Host } from './types.js';
import {
  reconnectStep,
  backoffMs,
  reconnectNotice,
  exhaustedNotice,
  remoteExitNotice,
  reconnectInteractiveSession,
  reattachRemoteCommand,
  wrapRemoteExitCode,
  initialReconnectState,
  SSH_CONN_FAILURE,
  MAX_ATTEMPTS,
  REMOTE_EXIT_255_REMAPPED,
  type ReconnectOutcome,
} from './reconnect.js';

const HOST = { name: 'zion' } as Host;
const SID = '94c75686-145c-465d-b3f8-a9c0d3a0387c';
const dropped = (connected: boolean): ReconnectOutcome => ({ code: SSH_CONN_FAILURE, connected });

describe('reconnectStep — the pure retry decision', () => {
  test('a clean detach (exit 0) stops and surfaces 0 — never reconnects', () => {
    expect(reconnectStep(initialReconnectState(), { code: 0, connected: true })).toEqual({ action: 'stop', code: 0 });
  });

  test('a real remote exit code (agent ended, non-255) stops and surfaces it', () => {
    expect(reconnectStep({ attempt: 0 }, { code: 1, connected: true })).toEqual({ action: 'stop', code: 1 });
    expect(reconnectStep({ attempt: 3 }, { code: 130, connected: false })).toEqual({ action: 'stop', code: 130 });
  });

  test('a 255 drop from a connected attempt retries with backoff and advances the attempt', () => {
    expect(reconnectStep({ attempt: 0 }, dropped(true))).toEqual({ action: 'retry', waitMs: 2_000, state: { attempt: 1 } });
    expect(reconnectStep({ attempt: 1 }, dropped(true))).toEqual({ action: 'retry', waitMs: 2_000, state: { attempt: 1 } });
  });

  test('a 255 from a FAILED connect counts against the budget (attempt accumulates)', () => {
    expect(reconnectStep({ attempt: 0 }, dropped(false))).toEqual({ action: 'retry', waitMs: 2_000, state: { attempt: 1 } });
    expect(reconnectStep({ attempt: 1 }, dropped(false))).toEqual({ action: 'retry', waitMs: 4_000, state: { attempt: 2 } });
    expect(reconnectStep({ attempt: 3 }, dropped(false))).toEqual({ action: 'retry', waitMs: 16_000, state: { attempt: 4 } });
  });

  test('the budget is bounded: MAX_ATTEMPTS consecutive FAILED connects stops at 255', () => {
    expect(reconnectStep({ attempt: MAX_ATTEMPTS }, dropped(false))).toEqual({ action: 'stop', code: SSH_CONN_FAILURE });
  });

  test('a genuine reconnection (connected) refills the budget even at the cap', () => {
    // The regression prix caught: a hung/failed connect must NOT look like a live
    // session. Only `connected: true` refills; `connected: false` at the cap stops.
    expect(reconnectStep({ attempt: MAX_ATTEMPTS }, dropped(true))).toEqual({
      action: 'retry',
      waitMs: backoffMs(0),
      state: { attempt: 1 },
    });
  });
});

describe('backoffMs — capped exponential', () => {
  test('doubles then caps at 30s', () => {
    expect(backoffMs(0)).toBe(2_000);
    expect(backoffMs(1)).toBe(4_000);
    expect(backoffMs(2)).toBe(8_000);
    expect(backoffMs(3)).toBe(16_000);
    expect(backoffMs(4)).toBe(30_000); // 32s clamped
    expect(backoffMs(10)).toBe(30_000);
  });
});

describe('wrapRemoteExitCode — the root-cause fix, exercised with a REAL shell (no mock)', () => {
  // These run the actual returned string through a real `bash`, the same
  // interpreter ssh hands it to on a POSIX peer. This is what directly
  // reproduces (and proves fixed) the "attempt 1/6 forever" bug: the loop only
  // ever looped because a remote-origin 255 was indistinguishable from a real
  // ssh drop. Skipped on Windows CI, where `bash` isn't guaranteed on PATH —
  // interactive host dispatch (what this wraps) is already POSIX-only
  // (dispatch.ts), so there's no Windows behavior to regress.
  const runsBash = process.platform !== 'win32';

  // `(exit N)` runs in a forked SUBSHELL — it returns control to the wrapper
  // script with status N (via `$?`), unlike a bare top-level `exit N` builtin,
  // which would terminate the wrapper script before its own remap logic ever
  // runs. This is what makes these tests actually exercise the remap, the same
  // way a real subprocess (`agents sessions focus …`) returning exit code N does
  // in production — it doesn't terminate the wrapping `bash -lc` script either.
  function realBashExitCode(cmd: string): number | undefined {
    try {
      execFileSync('bash', ['-c', wrapRemoteExitCode(cmd)]);
      return 0;
    } catch (e) {
      return (e as { status?: number }).status;
    }
  }

  test.skipIf(!runsBash)('exit codes other than 255 pass through unchanged (0, 1, 42)', () => {
    for (const code of [0, 1, 42]) {
      expect(realBashExitCode(`(exit ${code})`)).toBe(code);
    }
  });

  test.skipIf(!runsBash)('a 255 exit is remapped to REMOTE_EXIT_255_REMAPPED (254), verified via real bash exit status — this is the exact mechanism that let the "attempt 1/6 forever" bug loop', () => {
    // Before this fix: a remote command (the login-shell fallback, a nested
    // remote-tmux hop) that happened to exit 255 for its own reasons rode back
    // up through `sshStream` as SSH_CONN_FAILURE — indistinguishable from the ssh
    // transport itself dropping — and kept refilling the reconnect loop's retry
    // budget forever.
    expect(realBashExitCode('(exit 255)')).toBe(REMOTE_EXIT_255_REMAPPED);
    expect(REMOTE_EXIT_255_REMAPPED).not.toBe(SSH_CONN_FAILURE);
  });

  test('wraps in bash -lc, matching buildRemoteAgentsInvocation\'s pattern for every other remote dispatch', () => {
    expect(wrapRemoteExitCode('true')).toBe(`bash -lc 'true; rc=$?; [ "$rc" = "255" ] && rc=254; exit "$rc"'`);
  });
});

describe('reattachRemoteCommand — the real remote invocation, exercised through a REAL shell with an argv-echoing "agents" shim (no mock)', () => {
  const runsBash = process.platform !== 'win32';
  // Mirrors remote-cmd.test.ts's decodeRemoteArgv/injection-test shim: define
  // "agents" as a bash FUNCTION (so it runs in-process, not a real binary) that
  // either echoes its argv one-per-line, or `return`s a chosen status (NOT
  // `exit`, which would kill the whole script — a function must `return` to
  // hand a status back to its caller without terminating the shell, the same
  // way a real subprocess handing back an exit code doesn't kill the wrapper).
  const argvShim = `agents() { for a in "$@"; do printf '%s\\n' "$a"; done; }; export -f agents; `;
  const exit255Shim = `agents() { return 255; }; export -f agents; `;

  // A session id is never attacker-controlled in production (Claude mints it,
  // or it's an existing session's own id), but this proves the composition is
  // safe regardless: shellQuote is applied to the id AND to the whole wrapper
  // string, and nested POSIX '\'' escaping must compose correctly under that
  // double-quoting for the real command to survive.
  const INJECTION_SID = "a'b; touch /tmp/PWNED-reconnect-test; #";

  test.skipIf(!runsBash)('argv round-trips through bash -lc even for a session id needing quoting — no injection', () => {
    const res = execFileSync('bash', ['-c', argvShim + reattachRemoteCommand(INJECTION_SID)], { encoding: 'utf8' });
    // No --attach-only: the peer's focus attaches a live pane or RESUMES a dead
    // one (RUSH-2085), so a reattach after the pane died never dead-ends.
    expect(res.trimEnd().split('\n')).toEqual(['sessions', 'focus', INJECTION_SID, '--local']);
  });

  test.skipIf(!runsBash)('a 255 from the wrapped `agents` command comes back as REMOTE_EXIT_255_REMAPPED (254) — exercised end-to-end through reattachRemoteCommand, not just the wrapRemoteExitCode primitive', () => {
    // Before this fix: refuseFallback's remote branch (or a nested remote-tmux
    // hop) exiting 255 for its own reasons rode back up through `sshStream` as
    // SSH_CONN_FAILURE — indistinguishable from the ssh transport itself
    // dropping — and kept refilling the reconnect loop's retry budget forever.
    let status: number | undefined;
    try {
      execFileSync('bash', ['-c', exit255Shim + reattachRemoteCommand(SID)]);
      status = 0;
    } catch (e) {
      status = (e as { status?: number }).status;
    }
    expect(status).toBe(REMOTE_EXIT_255_REMAPPED);
    expect(REMOTE_EXIT_255_REMAPPED).not.toBe(SSH_CONN_FAILURE);
    expect(reconnectStep(initialReconnectState(), { code: REMOTE_EXIT_255_REMAPPED, connected: true })).toEqual({
      action: 'stop',
      code: REMOTE_EXIT_255_REMAPPED,
    });
  });

  test("the plain string, no shell needed: wraps in bash -lc around the peer's own recovery verb (attach-else-resume, no --attach-only)", () => {
    expect(reattachRemoteCommand(SID)).toBe(
      `bash -lc 'agents sessions focus ${SID} --local; rc=$?; [ "$rc" = "255" ] && rc=254; exit "$rc"'`,
    );
  });
});

describe('remoteExitNotice — human readable', () => {
  test('names the host and short id, and reads as "not a network drop"', () => {
    const s = remoteExitNotice(SID, 'zion');
    expect(s).toContain('zion');
    expect(s).toContain('94c75686');
    expect(s).toContain('not a network drop');
  });
});

describe('notices — human readable', () => {
  test('reconnect notice names the host, the short id, the wait, and the attempt', () => {
    const s = reconnectNotice(SID, 'zion', 2, 4_000);
    expect(s).toContain('zion');
    expect(s).toContain('94c75686');
    expect(s).toContain('in 4 seconds');
    expect(s).toContain(`attempt 2/${MAX_ATTEMPTS}`);
  });

  test('exhausted notice hands back the manual reconnect command', () => {
    expect(exhaustedNotice(SID, 'zion')).toContain('agents reconnect 94c75686');
  });
});

describe('reconnectInteractiveSession — the loop over the real state machine', () => {
  const noWait = async () => {};

  test('reattaches after a drop, then returns 0 when the user detaches cleanly', async () => {
    const seq: ReconnectOutcome[] = [{ code: 0, connected: true }]; // reattach → clean detach
    const writes: string[] = [];
    const rc = await reconnectInteractiveSession({
      host: HOST,
      sessionId: SID,
      initialExit: SSH_CONN_FAILURE,
      reattach: () => seq.shift()!,
      wait: noWait,
      write: (s) => writes.push(s),
    });
    expect(rc).toBe(0);
    expect(writes.some((w) => w.includes('attempt 1/'))).toBe(true);
    expect(writes.some((w) => w.includes("Couldn't reconnect"))).toBe(false);
  });

  test('a SUSTAINED outage (every reattach fails to connect) gives up after MAX_ATTEMPTS with the manual hint', async () => {
    // This is the boundary prix flagged: failed connects (connected:false) must NOT
    // refill the budget, so the loop terminates instead of retrying forever.
    let calls = 0;
    const writes: string[] = [];
    const rc = await reconnectInteractiveSession({
      host: HOST,
      sessionId: SID,
      initialExit: SSH_CONN_FAILURE,
      reattach: () => {
        calls++;
        return { code: SSH_CONN_FAILURE, connected: false }; // host unreachable every time
      },
      wait: noWait,
      write: (s) => writes.push(s),
    });
    expect(rc).toBe(SSH_CONN_FAILURE);
    expect(calls).toBe(MAX_ATTEMPTS); // exactly the budget, no infinite loop
    expect(writes.some((w) => w.includes('agents reconnect 94c75686'))).toBe(true);
  });

  test('a mid-run second drop after a genuine reconnection keeps reconnecting', async () => {
    // drop → reattach connects and holds, then drops again → reattach → clean exit.
    const seq: ReconnectOutcome[] = [
      { code: SSH_CONN_FAILURE, connected: true }, // reconnected, then dropped
      { code: 0, connected: true }, // reconnected, clean detach
    ];
    const rc = await reconnectInteractiveSession({
      host: HOST,
      sessionId: SID,
      initialExit: SSH_CONN_FAILURE,
      reattach: () => seq.shift()!,
      wait: noWait,
      write: () => {},
    });
    expect(rc).toBe(0);
  });

  test('a few failed connects then a successful reconnection resets the budget', async () => {
    // 3 unreachable attempts, then a connect that holds and cleanly exits — the
    // failed attempts alone are under MAX_ATTEMPTS, and the connect refills anyway.
    const seq: ReconnectOutcome[] = [
      dropped(false),
      dropped(false),
      dropped(false),
      { code: 0, connected: true },
    ];
    const rc = await reconnectInteractiveSession({
      host: HOST,
      sessionId: SID,
      initialExit: SSH_CONN_FAILURE,
      reattach: () => seq.shift()!,
      wait: noWait,
      write: () => {},
    });
    expect(rc).toBe(0);
  });
});
