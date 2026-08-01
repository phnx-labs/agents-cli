import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobScheduler } from './scheduler.js';
import { writeJob, deleteJob, type JobConfig } from './routines.js';

/**
 * RUSH-1980: the daemon's scheduler froze each routine's device pin at load
 * (loadAll). `agents repo pull` rewrites the routine YAML on disk — including a
 * moved device pin — but without a reload the scheduler keeps firing the old
 * pin, so a routine re-pinned to another host still fires here too (a phantom
 * double-fire across the fleet). reloadAll() must re-read the YAML so pins
 * refresh. This drives the real reloadAll -> loadAll -> listJobs ->
 * jobRunsOnThisDevice path against a routine rewritten on disk.
 */
describe('JobScheduler.reloadAll — device-pin refresh (RUSH-1980)', () => {
  const name = 'rush1980-scheduler-test';
  const SELF = 'rush1980-self';
  let prevMachineId: string | undefined;

  beforeEach(() => {
    prevMachineId = process.env.AGENTS_SYNC_MACHINE_ID;
    // Deterministic self-id so the pin comparison never depends on the CI host.
    process.env.AGENTS_SYNC_MACHINE_ID = SELF;
  });

  afterEach(() => {
    if (prevMachineId === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = prevMachineId;
    try { deleteJob(name); } catch { /* best effort */ }
  });

  function pinnedJob(devices: string[]): JobConfig {
    return {
      name,
      agent: 'claude',
      prompt: 'do it',
      schedule: '0 9 * * 1-5',
      mode: 'plan',
      effort: 'auto',
      timeout: '10m',
      enabled: true,
      devices,
    } as JobConfig;
  }

  it('picks up an on-disk re-pin on reload, so a routine moved to another host stops firing here', () => {
    // Initially pinned to THIS device — the scheduler loads and schedules it.
    writeJob(pinnedJob([SELF]));
    const scheduler = new JobScheduler(async () => {});
    scheduler.loadAll();
    expect(scheduler.listScheduled().some((j) => j.name === name)).toBe(true);

    // A pull rewrites the YAML, re-pinning the routine to another host. Before the
    // fix the frozen in-memory pin kept this host firing it (the double-fire).
    writeJob(pinnedJob(['rush1980-other-host']));
    scheduler.reloadAll();
    expect(scheduler.listScheduled().some((j) => j.name === name)).toBe(false);

    // And the reverse refreshes too: re-pinned back here, reload re-schedules it.
    writeJob(pinnedJob([SELF]));
    scheduler.reloadAll();
    expect(scheduler.listScheduled().some((j) => j.name === name)).toBe(true);

    scheduler.stopAll();
  });
});
