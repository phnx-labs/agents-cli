import { describe, expect, it } from 'vitest';

import { startAccountStateService } from './account-state-service.js';

describe('startAccountStateService', () => {
  it('runs both collectors immediately and tears down both timers', async () => {
    const callbacks: Array<() => void> = [];
    const cleared: unknown[] = [];
    const calls: string[] = [];
    const handles = [{ unref() {} }, { unref() {} }];
    const service = startAccountStateService({
      refreshUsage: async () => { calls.push('usage'); },
      refreshAuth: async () => { calls.push('auth'); },
      setInterval: ((callback: () => void) => {
        callbacks.push(callback);
        return handles[callbacks.length - 1];
      }) as unknown as typeof globalThis.setInterval,
      clearInterval: ((handle: unknown) => { cleared.push(handle); }) as typeof globalThis.clearInterval,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls.sort()).toEqual(['auth', 'usage']);
    expect(callbacks).toHaveLength(2);
    service.stop();
    expect(cleared).toEqual(handles);
  });

  it('does not overlap a slow usage refresh', async () => {
    const callbacks: Array<() => void> = [];
    let finish!: () => void;
    let calls = 0;
    const service = startAccountStateService({
      refreshUsage: async () => {
        calls += 1;
        await new Promise<void>((resolve) => { finish = resolve; });
      },
      refreshAuth: async () => {},
      setInterval: ((callback: () => void) => {
        callbacks.push(callback);
        return { unref() {} };
      }) as unknown as typeof globalThis.setInterval,
      clearInterval: (() => {}) as typeof globalThis.clearInterval,
    });
    await new Promise((resolve) => setImmediate(resolve));
    callbacks[0]();
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);
    finish();
    service.stop();
  });
});
