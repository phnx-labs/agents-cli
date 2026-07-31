/**
 * Tests for the watchdog-as-a-routine wiring.
 *
 * The pure builder is checked against the real routine validator (the scheduler's
 * gate), and the disk path is exercised against the real routines dir — with a
 * save/restore guard so a developer's actual `watchdog` routine is never clobbered.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateJob, readJob, writeJob, deleteJob, type JobConfig } from '../routines.js';
import {
  buildWatchdogRoutine,
  ensureWatchdogRoutine,
  isWatchdogRoutineEnabled,
  watchdogRoutineExists,
  WATCHDOG_ROUTINE_NAME,
  WATCHDOG_ROUTINE_COMMAND,
  WATCHDOG_ROUTINE_SCHEDULE,
} from './routine.js';

describe('buildWatchdogRoutine (pure)', () => {
  it('produces a command routine the scheduler accepts (validateJob is the gate)', () => {
    const job = buildWatchdogRoutine(false);
    expect(validateJob(job)).toEqual([]);
    expect(job.command).toBe(WATCHDOG_ROUTINE_COMMAND);
    expect(job.schedule).toBe(WATCHDOG_ROUTINE_SCHEDULE);
    // A command routine — never an agent/workflow run (deterministic, no LLM).
    expect(job.agent).toBeUndefined();
    expect(job.workflow).toBeUndefined();
  });

  it('ships disabled by default (opt-in), matching the old sentinel default', () => {
    expect(buildWatchdogRoutine(false).enabled).toBe(false);
    expect(buildWatchdogRoutine(true).enabled).toBe(true);
  });

  it('fires every 2 minutes — inside the 5m stall threshold', () => {
    expect(WATCHDOG_ROUTINE_SCHEDULE).toBe('*/2 * * * *');
  });
});

describe('ensureWatchdogRoutine (disk, idempotent)', () => {
  // Preserve any real user `watchdog` routine so the test never clobbers it.
  let saved: JobConfig | null = null;
  beforeEach(() => {
    saved = readJob(WATCHDOG_ROUTINE_NAME);
    deleteJob(WATCHDOG_ROUTINE_NAME);
  });
  afterEach(() => {
    deleteJob(WATCHDOG_ROUTINE_NAME);
    if (saved) writeJob(saved);
  });

  it('creates the routine (disabled) when absent', () => {
    expect(watchdogRoutineExists()).toBe(false);
    ensureWatchdogRoutine(false);
    expect(watchdogRoutineExists()).toBe(true);
    expect(isWatchdogRoutineEnabled()).toBe(false);
  });

  it('enables then disables idempotently', () => {
    ensureWatchdogRoutine(true);
    expect(isWatchdogRoutineEnabled()).toBe(true);
    ensureWatchdogRoutine(true); // no-op second call
    expect(isWatchdogRoutineEnabled()).toBe(true);
    ensureWatchdogRoutine(false);
    expect(isWatchdogRoutineEnabled()).toBe(false);
  });

  it('preserves a user-tuned schedule when only toggling enabled', () => {
    writeJob({ ...buildWatchdogRoutine(false), schedule: '*/5 * * * *' });
    ensureWatchdogRoutine(true);
    const job = readJob(WATCHDOG_ROUTINE_NAME);
    expect(job?.schedule).toBe('*/5 * * * *'); // not reset to the default
    expect(job?.enabled).toBe(true);
  });
});
