import { afterEach, describe, expect, it } from 'vitest';
import { notifyOverdue, type OverdueJob } from './overdue.js';

function overdueJob(partial: Partial<OverdueJob> = {}): OverdueJob {
  return {
    name: 'demo-overdue',
    expectedAt: new Date(Date.now() - 3_600_000),
    lastRanAt: null,
    ...partial,
  };
}

describe('notifyOverdue — missing desktop notifier must not crash the daemon', () => {
  const origPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = origPath;
  });

  // Regression: the desktop notifier (`osascript` on macOS, `notify-send` on
  // Linux) is absent on headless boxes. spawn() reports that as an ASYNC 'error'
  // event, not a synchronous throw — so the surrounding try/catch never saw it,
  // Node re-threw it as an uncaught exception, and the daemon died on every
  // overdue routine (systemd then restart-looped it, tearing down the browser
  // IPC socket). Emptying PATH guarantees ENOENT on every platform, so this
  // exercises the real spawn path. If the 'error' listener is removed, the async
  // ENOENT crashes this test process instead of being swallowed.
  it('swallows the notifier ENOENT and lets the process survive', async () => {
    process.env.PATH = '';

    notifyOverdue([overdueJob()]);
    // Let the async spawn 'error' event fire on the next libuv turn.
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Reaching this line means the async ENOENT did not abort the process.
    expect(true).toBe(true);
  });

  it('is a no-op for an empty job list (no spawn attempted)', () => {
    process.env.PATH = '';
    expect(() => notifyOverdue([])).not.toThrow();
  });
});
