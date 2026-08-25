import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
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

/**
 * detectOverdueJobs walked a fixed one-week window looking for the most recent
 * expected fire. Any cron whose gap exceeds that returned null and was skipped
 * entirely — never flagged overdue on any device, never caught up, no record.
 * `slack-link-rotate` (`0 9 1,13,25 * *`, 12-day gaps) was live in that class.
 */
describe('detectOverdueJobs — schedules sparser than the old one-week lookback', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    prevHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-overdue-sparse-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    fs.mkdirSync(path.join(home, '.agents', 'routines'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents: {}\n');
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const write = (job: Record<string, unknown>): void => {
    fs.writeFileSync(
      path.join(home, '.agents', 'routines', `${job.name}.yml`),
      yaml.stringify(job),
    );
  };

  const base = {
    agent: 'claude', mode: 'auto', effort: 'auto', timeout: '10m',
    enabled: true, prompt: 'noop', timezone: 'UTC',
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('flags a semi-monthly routine whose missed slot is older than a week', async () => {
    const { detectOverdueJobs } = await import('./overdue.js');
    // Fires the 1st, 13th and 25th. "Now" is the 22nd: the missed 13th is nine
    // days back, outside the old window, and the next fire (25th) is ahead.
    write({ ...base, name: 'semi-monthly', schedule: '0 9 1,13,25 * *' });
    const overdue = detectOverdueJobs(new Date('2026-01-22T10:00:00.000Z'));
    expect(overdue.map((o) => o.name)).toContain('semi-monthly');
  });

  it('flags a monthly routine', async () => {
    const { detectOverdueJobs } = await import('./overdue.js');
    write({ ...base, name: 'monthly', schedule: '0 9 1 * *' });
    const overdue = detectOverdueJobs(new Date('2026-01-20T10:00:00.000Z'));
    expect(overdue.map((o) => o.name)).toContain('monthly');
  });

  it('still leaves a routine that ran on schedule alone', async () => {
    const { detectOverdueJobs } = await import('./overdue.js');
    write({ ...base, name: 'ran-fine', schedule: '0 9 1,13,25 * *' });
    const runId = '2026-01-13T09-00-00-000Z';
    const dir = path.join(home, '.agents', '.history', 'runs', 'ran-fine', runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      jobName: 'ran-fine', runId, pid: null, status: 'completed',
      startedAt: '2026-01-13T09:00:00.000Z', completedAt: '2026-01-13T09:01:00.000Z', exitCode: 0,
    }));
    expect(detectOverdueJobs(new Date('2026-01-22T10:00:00.000Z')).map((o) => o.name))
      .not.toContain('ran-fine');
  });

  it('does not resurrect a routine past its endAt', async () => {
    const { detectOverdueJobs } = await import('./overdue.js');
    write({ ...base, name: 'retired', schedule: '0 9 * * *', endAt: '2026-01-10T00:00:00Z' });
    expect(detectOverdueJobs(new Date('2026-01-22T10:00:00.000Z')).map((o) => o.name))
      .not.toContain('retired');
  });

  it('does not replay a one-shot-like schedule that never carried runOnce', async () => {
    const { detectOverdueJobs } = await import('./overdue.js');
    // Fixed minute/hour/day/month: one-shot by shape, no runOnce flag.
    write({ ...base, name: 'one-shot-like', schedule: '0 9 5 1 *' });
    expect(detectOverdueJobs(new Date('2026-01-22T10:00:00.000Z')).map((o) => o.name))
      .not.toContain('one-shot-like');
  });

  it('clamps a future createdAt so the routine is not masked forever', async () => {
    const { routineEffectiveStart } = await import('./overdue.js');
    const now = new Date('2026-01-22T10:00:00.000Z');
    const start = routineEffectiveStart(
      { name: 'skewed', createdAt: '2027-01-01T00:00:00.000Z' } as never,
      now,
    );
    expect(start?.getTime()).toBe(now.getTime());
  });
});
