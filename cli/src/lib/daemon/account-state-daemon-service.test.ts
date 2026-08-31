/**
 * Account usage/auth services (PHNX-3608): usage and auth refresh now run as TWO
 * independent supervised PeriodicServices — `AccountUsageService` (`account-state`)
 * and `AccountAuthService` (`account-auth`) — each with its own per-tick deadline,
 * AbortSignal, and circuit breaker, replacing the old un-deadlined dual-`setInterval`
 * loop whose `usageRunning` latch could hang forever (the 12h usage-dark root cause).
 * Independent breakers mean a run of usage failures parks ONLY usage and never
 * starves the slower auth refresh. Driven through the real ServiceSupervisor so the
 * deadline/abort/circuit-breaker path is exercised, not stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ServiceSupervisor } from './supervisor.js';
import {
  AccountUsageService,
  AccountAuthService,
  AUTH_STATE_TICK_MS,
  USAGE_STATE_TICK_MS,
} from './account-state-daemon-service.js';
import type { DaemonContext } from './service.js';

let testDaemonDir = '';
const originalDaemonDir = process.env.AGENTS_DAEMON_DIR;

beforeEach(() => {
  testDaemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-acctstate-'));
  process.env.AGENTS_DAEMON_DIR = testDaemonDir;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  if (originalDaemonDir === undefined) delete process.env.AGENTS_DAEMON_DIR;
  else process.env.AGENTS_DAEMON_DIR = originalDaemonDir;
  fs.rmSync(testDaemonDir, { recursive: true, force: true });
});

function makeCtx(): DaemonContext {
  return { log: () => {} };
}

describe('AccountUsageService / AccountAuthService', () => {
  it('usage ticks on its interval; auth ticks on its slower interval', async () => {
    const usage = vi.fn(async () => {});
    const auth = vi.fn(async () => {});
    const supervisor = new ServiceSupervisor();
    supervisor.register(new AccountUsageService(usage));
    supervisor.register(new AccountAuthService(auth));

    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0); // immediate first tick for both
    expect(usage).toHaveBeenCalledTimes(1);
    expect(auth).toHaveBeenCalledTimes(1);

    // One usage interval later: usage ticks again, auth does not (slower cadence).
    await vi.advanceTimersByTimeAsync(USAGE_STATE_TICK_MS);
    expect(usage).toHaveBeenCalledTimes(2);
    expect(auth).toHaveBeenCalledTimes(1);

    // Reach the auth interval: auth ticks again.
    await vi.advanceTimersByTimeAsync(AUTH_STATE_TICK_MS - USAGE_STATE_TICK_MS);
    expect(auth).toHaveBeenCalledTimes(2);

    await supervisor.stopAll();
  });

  it('each service passes its tick an AbortSignal', async () => {
    let usageSignal: AbortSignal | undefined;
    let authSignal: AbortSignal | undefined;
    const supervisor = new ServiceSupervisor();
    supervisor.register(new AccountUsageService(async (s) => { usageSignal = s; }));
    supervisor.register(new AccountAuthService(async (s) => { authSignal = s; }));

    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0);
    expect(usageSignal).toBeInstanceOf(AbortSignal);
    expect(authSignal).toBeInstanceOf(AbortSignal);

    await supervisor.stopAll();
  });

  it('a run of usage failures parks ONLY usage — auth keeps its independent breaker running', async () => {
    const usage = vi.fn(async () => { throw new Error('usage boom'); });
    const auth = vi.fn(async () => {});
    const supervisor = new ServiceSupervisor({ parkAfterFailures: 3, backoffBaseMs: 60_000 });
    supervisor.register(new AccountUsageService(usage));
    supervisor.register(new AccountAuthService(auth));

    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0); // tick #1
    await vi.advanceTimersByTimeAsync(USAGE_STATE_TICK_MS); // #2
    await vi.advanceTimersByTimeAsync(USAGE_STATE_TICK_MS); // #3 -> parks usage

    const health = supervisor.health();
    expect(health['account-state'].state).toBe('parked');
    expect(health['account-state'].lastError).toMatch(/usage boom/);
    // Auth's breaker is untouched by usage's failures — the whole point of the split.
    expect(health['account-auth'].state).toBe('running');
    expect(auth).toHaveBeenCalled();

    await supervisor.stopAll();
  });

  it('a hung usage refresh is abandoned at the deadline and recovers on backoff (12h usage-dark fix)', async () => {
    let hang = true;
    const usage = vi.fn(async (signal: AbortSignal) => {
      if (!hang) return;
      // Model a well-behaved provider fetch bound to the signal: unwinds on abort.
      await new Promise<void>((resolve) => {
        if (signal.aborted) { resolve(); return; }
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    const supervisor = new ServiceSupervisor({ backoffBaseMs: 5_000 });
    supervisor.register(new AccountUsageService(usage));

    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0); // first tick — usage hangs
    expect(usage).toHaveBeenCalledTimes(1);

    // The 2-minute deadline elapses -> parked, not latched forever.
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(supervisor.health()['account-state'].state).toBe('parked');

    // Heal + let the backoff restart fire: the service runs again.
    hang = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(supervisor.health()['account-state'].state).toBe('running');
    expect(usage.mock.calls.length).toBeGreaterThanOrEqual(2);

    await supervisor.stopAll();
  });
});
