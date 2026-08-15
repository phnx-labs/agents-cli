import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobScheduler } from './scheduler.js';
import { writeJob, deleteJob, type JobConfig } from './routines.js';
import * as activation from './routine-activation.js';
import { getUserAgentsDir } from './state.js';

/**
 * reloadAll() must re-read device activation after a manifest change so the
 * daemon does not keep firing a routine that was disabled on this host.
 */
describe('JobScheduler.reloadAll — device activation refresh', () => {
  const name = 'rush1980-scheduler-test';
  const SELF = 'rush1980-self';
  let prevMachineId: string | undefined;
  let active = true;

  beforeEach(() => {
    prevMachineId = process.env.AGENTS_SYNC_MACHINE_ID;
    // Deterministic self-id so the pin comparison never depends on the CI host.
    process.env.AGENTS_SYNC_MACHINE_ID = SELF;
    active = true;
    vi.spyOn(activation, 'routineEnabledOnThisDevice').mockImplementation(() => active);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { deleteJob(name); } catch { /* best effort */ }
    // deleteJob drops the routine but not the device dir that writing it
    // created, and this suite runs against the developer's REAL ~/.agents (no
    // HOME redirect), so `devices/rush1980-self/` was left behind on every box
    // that ever ran the suite. Harmless while `devices/` was gitignored;
    // once it is tracked, every such box stages the SAME path — which is
    // exactly the two-writers-one-path wedge that tracking it is meant to
    // avoid. Remove our own artifact while the id is still in scope. (Same
    // class as RUSH-2639: tests writing into the real user dir.)
    try {
      fs.rmSync(path.join(getUserAgentsDir(), 'devices', SELF), { recursive: true, force: true });
    } catch { /* best effort */ }
    if (prevMachineId === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = prevMachineId;
  });

  function routine(): JobConfig {
    return {
      name,
      agent: 'claude',
      prompt: 'do it',
      schedule: '0 9 * * 1-5',
      mode: 'plan',
      effort: 'auto',
      timeout: '10m',
      enabled: true,
    } as JobConfig;
  }

  it('picks up enable and disable changes from this device manifest', () => {
    writeJob(routine());
    const scheduler = new JobScheduler(async () => {});
    scheduler.loadAll();
    expect(scheduler.listScheduled().some((j) => j.name === name)).toBe(true);

    active = false;
    scheduler.reloadAll();
    expect(scheduler.listScheduled().some((j) => j.name === name)).toBe(false);

    active = true;
    scheduler.reloadAll();
    expect(scheduler.listScheduled().some((j) => j.name === name)).toBe(true);

    scheduler.stopAll();
  });
});
