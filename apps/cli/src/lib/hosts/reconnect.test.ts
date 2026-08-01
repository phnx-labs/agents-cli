/**
 * Tests for the interactive-session auto-reconnect policy. The load-bearing logic
 * is the pure state machine `reconnectStep` + `backoffMs` — exercised directly with
 * real inputs, no mocks. `reconnectInteractiveSession` is driven through that same
 * real state machine; only the two genuinely-external effects (the SSH re-attach and
 * the wall-clock wait) are supplied as deterministic sequences, because SSH cannot
 * run in CI. No production code path is stubbed.
 */
import { describe, expect, test } from 'vitest';
import type { Host } from './types.js';
import {
  reconnectStep,
  backoffMs,
  reconnectNotice,
  exhaustedNotice,
  reconnectInteractiveSession,
  initialReconnectState,
  SSH_CONN_FAILURE,
  MAX_ATTEMPTS,
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

describe('notices — human readable', () => {
  test('reconnect notice names the host, the short id, the wait, and the attempt', () => {
    const s = reconnectNotice(SID, 'zion', 2, 4_000);
    expect(s).toContain('zion');
    expect(s).toContain('94c75686');
    expect(s).toContain('in 4 seconds');
    expect(s).toContain(`attempt 2/${MAX_ATTEMPTS}`);
  });

  test('exhausted notice hands back the manual command', () => {
    expect(exhaustedNotice(SID, 'zion')).toContain('agents sessions focus 94c75686');
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
    expect(writes.some((w) => w.includes('agents sessions focus 94c75686'))).toBe(true);
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
