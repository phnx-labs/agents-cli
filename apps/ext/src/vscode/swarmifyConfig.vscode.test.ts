import { describe, test, expect, mock } from 'bun:test';

// swarmifyConfig.vscode imports 'vscode' at module load; the scheduler under
// test does not touch it, so an empty stub is enough to satisfy the import.
mock.module('vscode', () => ({}));

const { createCoalescingScheduler } = await import('./swarmifyConfig.vscode');

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

describe('createCoalescingScheduler', () => {
  test('coalesces a burst per key into one trailing invocation with the latest value', async () => {
    const calls: string[] = [];
    const scheduler = createCoalescingScheduler<string>(50, v => calls.push(v));

    scheduler.schedule('a', 'a1');
    scheduler.schedule('a', 'a2');
    scheduler.schedule('a', 'a3');
    scheduler.schedule('b', 'b1');

    // Nothing fires before the debounce window elapses.
    await sleep(20);
    expect(calls).toEqual([]);

    await sleep(60);
    expect(calls.sort()).toEqual(['a3', 'b1']);

    scheduler.dispose();
  });

  test('dispose cancels pending invocations', async () => {
    const calls: string[] = [];
    const scheduler = createCoalescingScheduler<string>(50, v => calls.push(v));

    scheduler.schedule('a', 'a1');
    scheduler.dispose();

    await sleep(80);
    expect(calls).toEqual([]);
  });
});
