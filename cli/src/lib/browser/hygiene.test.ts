import { describe, it, expect } from 'vitest';
import { reapAbandonedTasks, type ReapableService, type ReapDeps } from './hygiene.js';
import type { Task } from './types.js';

/**
 * Unit-level coverage for `reapAbandonedTasks` against the bare
 * `ReapableService` interface — no CDP, no profile files, no daemon. The
 * session-dead/idle decision logic and the launchId/recording nuances are
 * already exercised end-to-end against a real `BrowserService` in
 * `service.test.ts`; this file covers what changed here (RUSH-2622): the
 * `idleMs: null` "idle reaping is off" signal the daemon tick and `gc`
 * IPC/config path rely on.
 */

function makeTask(name: string, overrides: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: name,
    name,
    profile: 'p',
    tabs: { tab1: 'cdp-1' },
    createdAt: now,
    lastActionAt: now,
    pid: 0,
    ...overrides,
  };
}

function stubService(initial: Task[]): ReapableService & { readonly stopped: string[] } {
  const tasks = [...initial];
  const stopped: string[] = [];
  return {
    get stopped() {
      return stopped;
    },
    listTasks: () => tasks.map((task) => ({ profile: task.profile, task })),
    recordStatus: async () => ({ recording: false }),
    stop: async (taskName: string) => {
      const idx = tasks.findIndex((t) => t.name === taskName);
      if (idx === -1) return { ok: false };
      const [removed] = tasks.splice(idx, 1);
      stopped.push(taskName);
      return { ok: true, profile: removed.profile };
    },
  };
}

// No live entries at all, so any task carrying a sessionId reads as gone —
// resolveLiveIdentities/taskOwnerIsGone are unit-tested elsewhere; this just
// keeps the process table out of these tests.
const NO_LIVE_IDENTITIES: ReapDeps = {
  listEntries: () => [],
  sessionLiveOnProcessTable: async () => false,
};

describe('reapAbandonedTasks — idleMs: null disables idle reaping only (RUSH-2622)', () => {
  it('leaves an hour-idle task alone under idleMs: null, but still reaps a session-dead one', async () => {
    const now = Date.now();
    const idleOnly = makeTask('idle-only', { lastActionAt: now - 60 * 60_000 });
    const sessionDead = makeTask('session-dead', {
      sessionId: '22222222-2222-4222-8222-222222222222',
      lastActionAt: now,
    });
    const service = stubService([idleOnly, sessionDead]);

    const result = await reapAbandonedTasks(service, { idleMs: null, now, deps: NO_LIVE_IDENTITIES });

    expect(result.closed).toEqual([{ task: 'session-dead', profile: 'p', reason: 'session-dead' }]);
    expect(result.skipped).toBe(1);
    expect(service.stopped).toEqual(['session-dead']);
  });

  it('a numeric 0 still throws — null is the only explicit "disable idle" signal', async () => {
    const service = stubService([makeTask('t')]);
    await expect(reapAbandonedTasks(service, { idleMs: 0 })).rejects.toThrow(/positive number/);
    expect(service.stopped).toEqual([]);
  });

  it('omitting idleMs still applies the default 30-minute window', async () => {
    const now = Date.now();
    const stale = makeTask('stale', { lastActionAt: now - 31 * 60_000 });
    const service = stubService([stale]);

    const result = await reapAbandonedTasks(service, { now, deps: NO_LIVE_IDENTITIES });

    expect(result.closed).toEqual([{ task: 'stale', profile: 'p', reason: 'idle' }]);
  });

  it('a positive idleMs still applies its own window, unaffected by the null path', async () => {
    const now = Date.now();
    const recent = makeTask('recent', { lastActionAt: now - 5 * 60_000 });
    const service = stubService([recent]);

    const result = await reapAbandonedTasks(service, { idleMs: 10 * 60_000, now, deps: NO_LIVE_IDENTITIES });

    expect(result.closed).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it('dryRun with idleMs: null reports the session-dead task without closing it', async () => {
    const now = Date.now();
    const sessionDead = makeTask('dead', {
      sessionId: '22222222-2222-4222-8222-222222222222',
      lastActionAt: now,
    });
    const service = stubService([sessionDead]);

    const result = await reapAbandonedTasks(service, { idleMs: null, dryRun: true, now, deps: NO_LIVE_IDENTITIES });

    expect(result.closed).toEqual([{ task: 'dead', profile: 'p', reason: 'session-dead' }]);
    expect(service.stopped).toEqual([]);
  });
});
