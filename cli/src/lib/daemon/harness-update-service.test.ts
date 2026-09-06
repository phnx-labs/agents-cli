/**
 * The daemon harness-update tick (PHNX-3940). `runHarnessUpdateTick` is the
 * shared decision/logging logic between the periodic service and any future
 * on-demand trigger; it is exercised here through the same `deps` injection
 * seam `self-update-service.test.ts` uses for its own tick, so the boundary
 * that actually shells out (`defaultHarnessUpdateDeps`, a real bounded
 * `execFile` of `agents update --auto --json`) is the only thing swapped —
 * everything else (logging, outcome shape) is real.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DaemonContext } from './service.js';
import { runHarnessUpdateTick, type HarnessUpdateDeps } from './harness-update-service.js';

function fakeCtx(): { ctx: DaemonContext; logs: Array<{ level: string; message: string }> } {
  const logs: Array<{ level: string; message: string }> = [];
  return { ctx: { log: (level, message) => logs.push({ level, message }) }, logs };
}

describe('runHarnessUpdateTick', () => {
  it('a clean pass (exit 0) logs INFO and reports ran:true', async () => {
    const { ctx, logs } = fakeCtx();
    const deps: HarnessUpdateDeps = {
      runAutoUpdatePass: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '{"plan":[],"outcomes":[]}' }),
    };

    const outcome = await runHarnessUpdateTick(ctx, new AbortController().signal, deps);

    expect(outcome).toEqual({ ran: true, exitCode: 0, stdout: '{"plan":[],"outcomes":[]}' });
    expect(logs.some((l) => l.level === 'INFO')).toBe(true);
    expect(logs.some((l) => l.level === 'ERROR' || l.level === 'WARN')).toBe(false);
  });

  it('a pass with per-installation errors (non-zero exit) logs WARN but still reports ran:true — it is not a service failure', async () => {
    const { ctx, logs } = fakeCtx();
    const deps: HarnessUpdateDeps = {
      runAutoUpdatePass: vi.fn().mockResolvedValue({ exitCode: 1, stdout: 'claude@2.0.65: npm install timed out' }),
    };

    const outcome = await runHarnessUpdateTick(ctx, new AbortController().signal, deps);

    expect(outcome.ran).toBe(true);
    expect(outcome.exitCode).toBe(1);
    expect(logs.some((l) => l.level === 'WARN' && l.message.includes('npm install timed out'))).toBe(true);
  });

  it('a genuine failure to run the pass at all (spawn error, abort, timeout) logs ERROR and reports ran:false, never throws', async () => {
    const { ctx, logs } = fakeCtx();
    const deps: HarnessUpdateDeps = {
      runAutoUpdatePass: vi.fn().mockRejectedValue(new Error('spawn agents ENOENT')),
    };

    const outcome = await runHarnessUpdateTick(ctx, new AbortController().signal, deps);

    expect(outcome).toEqual({ ran: false, reason: 'spawn agents ENOENT' });
    expect(logs.some((l) => l.level === 'ERROR' && l.message.includes('spawn agents ENOENT'))).toBe(true);
  });

  it('threads the supervisor-provided AbortSignal into the pass — the tick must be abortable, not fire-and-forget', async () => {
    const { ctx } = fakeCtx();
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const deps: HarnessUpdateDeps = {
      runAutoUpdatePass: vi.fn((signal: AbortSignal) => {
        observedSignal = signal;
        return Promise.resolve({ exitCode: 0, stdout: '' });
      }),
    };

    await runHarnessUpdateTick(ctx, controller.signal, deps);

    expect(observedSignal).toBe(controller.signal);
  });
});
