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
  LIVE_SESSION_MS,
  type ReconnectOutcome,
} from './reconnect.js';

const HOST = { name: 'zion' } as Host;
const SID = '94c75686-145c-465d-b3f8-a9c0d3a0387c';

describe('reconnectStep — the pure retry decision', () => {
  test('a clean detach (exit 0) stops and surfaces 0 — never reconnects', () => {
    const d = reconnectStep(initialReconnectState(), { code: 0, durationMs: 60_000 });
    expect(d).toEqual({ action: 'stop', code: 0 });
  });

  test('a real remote exit code (agent ended, non-255) stops and surfaces it', () => {
    expect(reconnectStep({ attempt: 0 }, { code: 1, durationMs: 5_000 })).toEqual({ action: 'stop', code: 1 });
    expect(reconnectStep({ attempt: 3 }, { code: 130, durationMs: 5_000 })).toEqual({ action: 'stop', code: 130 });
  });

  test('a 255 drop retries with exponential backoff and advances the attempt', () => {
    const d = reconnectStep({ attempt: 0 }, { code: SSH_CONN_FAILURE, durationMs: 500 });
    expect(d).toEqual({ action: 'retry', waitMs: 2_000, state: { attempt: 1 } });
    const d2 = reconnectStep({ attempt: 1 }, { code: SSH_CONN_FAILURE, durationMs: 500 });
    expect(d2).toEqual({ action: 'retry', waitMs: 4_000, state: { attempt: 2 } });
  });

  test('the retry budget is bounded: attempt === MAX_ATTEMPTS on a fast drop stops at 255', () => {
    const d = reconnectStep({ attempt: MAX_ATTEMPTS }, { code: SSH_CONN_FAILURE, durationMs: 500 });
    expect(d).toEqual({ action: 'stop', code: SSH_CONN_FAILURE });
  });

  test('a drop AFTER a genuinely live session refills the budget (does not burn attempts)', () => {
    // attempt is already maxed, but the session held past the live threshold, so a
    // fresh drop should reconnect again rather than give up.
    const d = reconnectStep({ attempt: MAX_ATTEMPTS }, { code: SSH_CONN_FAILURE, durationMs: LIVE_SESSION_MS + 1 });
    expect(d).toEqual({ action: 'retry', waitMs: backoffMs(0), state: { attempt: 1 } });
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
    const s = exhaustedNotice(SID, 'zion');
    expect(s).toContain('agents sessions focus 94c75686');
  });
});

describe('reconnectInteractiveSession — the loop over the real state machine', () => {
  const noWait = async () => {};

  test('reattaches after a drop, then returns 0 when the user detaches cleanly', async () => {
    const codes: ReconnectOutcome[] = [{ code: 0, durationMs: 30_000 }]; // reattach → clean detach
    const writes: string[] = [];
    const rc = await reconnectInteractiveSession({
      host: HOST,
      sessionId: SID,
      initialExit: SSH_CONN_FAILURE,
      initialDurationMs: 500,
      reattach: () => codes.shift()!,
      wait: noWait,
      write: (s) => writes.push(s),
    });
    expect(rc).toBe(0);
    expect(writes.some((w) => w.includes('attempt 1/'))).toBe(true);
    expect(writes.some((w) => w.includes("Couldn't reconnect"))).toBe(false);
  });

  test('gives up after MAX_ATTEMPTS fast failures and returns 255 with the manual hint', async () => {
    let calls = 0;
    const writes: string[] = [];
    const rc = await reconnectInteractiveSession({
      host: HOST,
      sessionId: SID,
      initialExit: SSH_CONN_FAILURE,
      initialDurationMs: 500,
      reattach: () => {
        calls++;
        return { code: SSH_CONN_FAILURE, durationMs: 200 }; // always fails fast
      },
      wait: noWait,
      write: (s) => writes.push(s),
    });
    expect(rc).toBe(SSH_CONN_FAILURE);
    expect(calls).toBe(MAX_ATTEMPTS); // exactly the budget, no more
    expect(writes.some((w) => w.includes('agents sessions focus 94c75686'))).toBe(true);
  });

  test('a mid-run second drop after a live reconnection keeps reconnecting', async () => {
    // drop → reattach holds a long live session → drops again → reattach → clean exit.
    const seq: ReconnectOutcome[] = [
      { code: SSH_CONN_FAILURE, durationMs: LIVE_SESSION_MS + 5_000 }, // lived, then dropped
      { code: 0, durationMs: 20_000 }, // reattached, clean detach
    ];
    const rc = await reconnectInteractiveSession({
      host: HOST,
      sessionId: SID,
      initialExit: SSH_CONN_FAILURE,
      initialDurationMs: 500,
      reattach: () => seq.shift()!,
      wait: noWait,
      write: () => {},
    });
    expect(rc).toBe(0);
  });
});
