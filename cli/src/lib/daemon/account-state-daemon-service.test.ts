/**
 * AccountStateDaemonService (PHNX-3608): the usage/auth refresh now runs as a
 * supervised PeriodicService with a real deadline + AbortSignal, replacing the
 * old un-deadlined dual-`setInterval` loop whose `usageRunning` latch could hang
 * forever (the 12h usage-dark root cause). These drive the service through the
 * real ServiceSupervisor so the deadline/abort/circuit-breaker path is exercised,
 * not stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ServiceSupervisor } from './supervisor.js';
import { AccountStateDaemonService, AUTH_STATE_TICK_MS, USAGE_STATE_TICK_MS } from './account-state-daemon-service.js';
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

describe('AccountStateDaemonService', () => {
  it('runs usage every tick and auth only on its slower cadence', async () => {
    let clock = 1_000_000;
    const usage = vi.fn(async () => {});
    const auth = vi.fn(async () => {});
    const supervisor = new ServiceSupervisor();
    supervisor.register(new AccountStateDaemonService({ refreshUsage: usage, refreshAuth: auth, now: () => clock }));

    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0); // immediate first tick
    // First tick: both areas run (auth is due because lastAuthMs starts at 0).
    expect(usage).toHaveBeenCalledTimes(1);
    expect(auth).toHaveBeenCalledTimes(1);

    // Next usage tick, but auth is NOT due yet (< AUTH_STATE_TICK_MS elapsed).
    clock += USAGE_STATE_TICK_MS;
    await vi.advanceTimersByTimeAsync(USAGE_STATE_TICK_MS);
    expect(usage).toHaveBeenCalledTimes(2);
    expect(auth).toHaveBeenCalledTimes(1);

    // Advance far enough that auth becomes due again.
    clock += AUTH_STATE_TICK_MS;
    await vi.advanceTimersByTimeAsync(USAGE_STATE_TICK_MS);
    expect(usage).toHaveBeenCalledTimes(3);
    expect(auth).toHaveBeenCalledTimes(2);

    await supervisor.stopAll();
  });

  it('a usage-refresh failure does not skip the auth refresh (they run concurrently)', async () => {
    const usage = vi.fn(async () => { throw new Error('usage boom'); });
    const auth = vi.fn(async () => {});
    const supervisor = new ServiceSupervisor({ parkAfterFailures: 100 });
    supervisor.register(new AccountStateDaemonService({ refreshUsage: usage, refreshAuth: auth, now: () => 0 }));

    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0);

    // Auth still got its attempt even though usage threw...
    expect(auth).toHaveBeenCalledTimes(1);
    // ...and the failure is surfaced to the supervisor as a failed tick.
    const health = supervisor.health();
    expect(health['account-state'].consecutiveFailures).toBeGreaterThanOrEqual(1);
    expect(health['account-state'].lastError).toMatch(/usage boom/);

    await supervisor.stopAll();
  });

  it('a hung usage refresh is abandoned at the deadline and the service recovers on backoff (12h usage-dark fix)', async () => {
    let hang = true;
    const usage = vi.fn(async () => { if (hang) return new Promise<void>(() => {}); });
    const auth = vi.fn(async () => {});
    const supervisor = new ServiceSupervisor({ backoffBaseMs: 5_000 });
    supervisor.register(new AccountStateDaemonService({ refreshUsage: usage, refreshAuth: auth, now: () => 0 }));

    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0); // first tick — usage hangs
    expect(usage).toHaveBeenCalledTimes(1);

    // The service deadline (2min) elapses -> parked, not latched forever.
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(supervisor.health()['account-state'].state).toBe('parked');

    // Heal the dependency, then let the backoff restart fire: the service runs
    // again instead of freezing the usage cache for the daemon's life.
    hang = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(supervisor.health()['account-state'].state).toBe('running');
    expect(usage.mock.calls.length).toBeGreaterThanOrEqual(2);

    await supervisor.stopAll();
  });
});
