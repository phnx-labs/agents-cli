import { describe, test, expect } from 'bun:test';
import { FloorPoll } from './floorPoll';

// Deterministic fake timer: start() registers a callback, tick() fires it,
// stop() unregisters. Lets us assert the poll actually pauses/resumes without
// wall-clock waits or Electron.
function fakeTimers() {
  const cbs = new Map<number, () => void>();
  let nextId = 1;
  return {
    deps: {
      setInterval: (fn: () => void) => {
        const id = nextId++;
        cbs.set(id, fn);
        return id as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: (handle: ReturnType<typeof setInterval>) => {
        cbs.delete(handle as unknown as number);
      },
    },
    tickAll: () => cbs.forEach((fn) => fn()),
    active: () => cbs.size,
  };
}

describe('FloorPoll', () => {
  test('start() begins ticking; stop() pauses it', () => {
    const timers = fakeTimers();
    let ticks = 0;
    const poll = new FloorPoll(5000, () => ticks++, timers.deps);

    expect(poll.running).toBe(false);
    poll.start();
    expect(poll.running).toBe(true);

    timers.tickAll();
    timers.tickAll();
    expect(ticks).toBe(2);

    poll.stop();
    expect(poll.running).toBe(false);
    expect(timers.active()).toBe(0);

    // After stop, no timer remains, so ticks stay frozen — the poll is paused.
    timers.tickAll();
    expect(ticks).toBe(2);
  });

  test('start() is idempotent — no double interval', () => {
    const timers = fakeTimers();
    let ticks = 0;
    const poll = new FloorPoll(5000, () => ticks++, timers.deps);

    poll.start();
    poll.start();
    expect(timers.active()).toBe(1);

    timers.tickAll();
    expect(ticks).toBe(1);
  });

  test('stop() is a no-op when not running', () => {
    const timers = fakeTimers();
    const poll = new FloorPoll(5000, () => {}, timers.deps);
    expect(() => poll.stop()).not.toThrow();
    expect(poll.running).toBe(false);
  });

  test('can resume after stop', () => {
    const timers = fakeTimers();
    let ticks = 0;
    const poll = new FloorPoll(5000, () => ticks++, timers.deps);

    poll.start();
    poll.stop();
    poll.start();
    expect(poll.running).toBe(true);
    expect(timers.active()).toBe(1);

    timers.tickAll();
    expect(ticks).toBe(1);
  });
});
