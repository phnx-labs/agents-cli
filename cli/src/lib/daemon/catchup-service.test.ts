/**
 * CatchupService (PHNX-3608): catch-up recovery under the ServiceSupervisor with
 * a real per-tick deadline + AbortSignal + circuit breaker, replacing the bare
 * `setInterval` the daemon used to boot/stop alongside the scheduler. Driven
 * through the real supervisor so the deadline/abort/park path is exercised.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ServiceSupervisor } from './supervisor.js';
import { CatchupService } from './catchup-service.js';
import type { DaemonContext } from './service.js';

let testDaemonDir = '';
const originalDaemonDir = process.env.AGENTS_DAEMON_DIR;

beforeEach(() => {
  testDaemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-catchup-'));
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

describe('CatchupService', () => {
  it('no-ops while the scheduler is not booted, and runs the pass once it is', async () => {
    let booted = false;
    const runPass = vi.fn(async () => {});
    const supervisor = new ServiceSupervisor();
    supervisor.register(new CatchupService({ isSchedulerBooted: () => booted, runPass }));

    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0); // immediate first tick — scheduler off, so no pass
    expect(runPass).not.toHaveBeenCalled();

    // Scheduler boots: the next supervised tick runs the pass.
    booted = true;
    await vi.advanceTimersByTimeAsync(5 * 60_000); // CATCHUP_TICK_MS
    expect(runPass).toHaveBeenCalledTimes(1);

    await supervisor.stopAll();
  });

  it('a hung pass is abandoned at the deadline and restarted on backoff (PHNX-3608)', async () => {
    let hang = true;
    const runPass = vi.fn(async () => { if (hang) return new Promise<void>(() => {}); });
    const supervisor = new ServiceSupervisor({ backoffBaseMs: 5_000 });
    supervisor.register(new CatchupService({ isSchedulerBooted: () => true, runPass }));

    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0); // first pass hangs
    expect(runPass).toHaveBeenCalledTimes(1);

    // The 4-minute deadline elapses -> parked, not latched forever.
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(supervisor.health()['catchup'].state).toBe('parked');

    // Heal and let the backoff restart fire: the pass runs again.
    hang = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(supervisor.health()['catchup'].state).toBe('running');
    expect(runPass.mock.calls.length).toBeGreaterThanOrEqual(2);

    await supervisor.stopAll();
  });

  it('passes an AbortSignal that aborts at the deadline', async () => {
    let seen: AbortSignal | undefined;
    const runPass = vi.fn(async (signal: AbortSignal) => {
      seen = signal;
      await new Promise<void>((resolve) => {
        if (signal.aborted) { resolve(); return; }
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    const supervisor = new ServiceSupervisor({ backoffBaseMs: 60_000 });
    supervisor.register(new CatchupService({ isSchedulerBooted: () => true, runPass }));

    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toBeDefined();
    expect(seen!.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(4 * 60_000); // deadline aborts the tick's signal
    expect(seen!.aborted).toBe(true);

    await supervisor.stopAll();
  });
});
