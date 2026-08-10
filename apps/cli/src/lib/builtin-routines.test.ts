import { describe, it, expect } from 'vitest';
import {
  BUILTIN_ROUTINE_NAMES,
  builtinRoutineJobs,
  builtinRoutineJob,
  isBuiltinRoutine,
} from './builtin-routines.js';
import { DAEMON_TICK_ROUTINE_NAMES } from './daemon-ticks.js';

describe('builtin daemon-owned routines (RUSH-2465)', () => {
  it('registry names set-equal the daemon tick registry — the two never drift', () => {
    // Every built-in routine must have a tick body, and every tick body must
    // have a built-in routine to schedule it. A drift either way would leave a
    // routine that fires `agents __daemon-tick <name>` with no body (loud
    // failure) or a tick body no clock ever fires (silent dead code).
    expect([...BUILTIN_ROUTINE_NAMES].sort()).toEqual([...DAEMON_TICK_ROUTINE_NAMES].sort());
  });

  it('does NOT include check-updates — that stays a user-facing system routine', () => {
    // check-updates (`agents repo pull system`) is genuine config sync, not
    // daemon housekeeping; it is the ONE routine `.agents-system` keeps.
    expect(BUILTIN_ROUTINE_NAMES).not.toContain('check-updates');
    expect(builtinRoutineJob('check-updates')).toBeNull();
    expect(isBuiltinRoutine('check-updates')).toBe(false);
  });

  it('every built-in is a well-formed command routine firing its own tick', () => {
    for (const job of builtinRoutineJobs()) {
      // Fires the existing tick entrypoint — the body is unchanged (RUSH-2465).
      expect(job.command).toBe(`agents __daemon-tick ${job.name}`);
      // A command routine carries no agent/workflow.
      expect(job.agent).toBeUndefined();
      expect(job.workflow).toBeUndefined();
      // Cron-scheduled, enabled-by-default, marked daemon-owned.
      expect(job.schedule && job.schedule.length).toBeTruthy();
      expect(job.enabled).toBe(true);
      expect(job.builtin).toBe(true);
      expect(job.timeout).toMatch(/^\d+m$/);
      // Command routines have no prompt.
      expect(job.prompt).toBe('');
      expect(isBuiltinRoutine(job.name)).toBe(true);
    }
  });

  it('schedules mirror the .agents-system YAML they replace', () => {
    const byName = Object.fromEntries(builtinRoutineJobs().map((j) => [j.name, j]));
    // These clocks are copied verbatim from routines/*.yml (RUSH-2353/2451).
    expect(byName['usage-refresh'].schedule).toBe('*/5 * * * *');
    expect(byName['fleet-cache-warm'].schedule).toBe('*/3 * * * *');
    expect(byName['session-cache-warm'].schedule).toBe('*/3 * * * *');
    expect(byName['device-probe'].schedule).toBe('*/3 * * * *');
    expect(byName['auto-dispatch'].schedule).toBe('*/3 * * * *');
    expect(byName['watchdog'].schedule).toBe('*/3 * * * *');
    expect(byName['tmux-reconcile'].schedule).toBe('*/5 * * * *');
    expect(byName['launch-health'].schedule).toBe('0 */6 * * *');
  });

  it('returns a fresh array each call — callers may mutate it', () => {
    const a = builtinRoutineJobs();
    const b = builtinRoutineJobs();
    expect(a).not.toBe(b);
    a[0].enabled = false;
    expect(b[0].enabled).toBe(true); // untouched
  });
});
