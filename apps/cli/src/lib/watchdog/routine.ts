/**
 * The watchdog, expressed as a routine.
 *
 * The always-on watchdog is not a bespoke subsystem — it is a plain `command`
 * routine the daemon's existing scheduler fires: `agents watchdog --nudge`, once
 * every couple of minutes. Enabling / disabling the watchdog is enabling /
 * disabling that routine, so there is ONE durable, inspectable concept
 * (`agents routines list` shows it; the scheduler catches it up if the daemon was
 * down) instead of a private sentinel file and a hand-rolled `--watch` loop.
 *
 * A `command` routine — not `agent`/`workflow` — because the tick is deterministic
 * housekeeping: no LLM, no auth, no sandbox. Each fire runs ONE bounded tick (the
 * cron is the loop), so the daemon's per-fire model fits without a long-lived
 * process.
 */
import { readJob, writeJob, setJobEnabled, type JobConfig } from '../routines.js';

/** The routine name. `agents routines list` / `readJob` key on this. */
export const WATCHDOG_ROUTINE_NAME = 'watchdog';

/**
 * Fire every 2 minutes. Mirrors the extension's 120s tick, and is well inside the
 * 5m stall threshold and 20m nudge cooldown, so a stall is noticed promptly
 * without the daemon spawning a tick more often than the cooldown can matter.
 */
export const WATCHDOG_ROUTINE_SCHEDULE = '*/2 * * * *';

/** The plain shell each fire runs: one bounded, deterministic nudge tick. */
export const WATCHDOG_ROUTINE_COMMAND = 'agents watchdog --nudge';

/**
 * Build the watchdog routine config. Pure — touches no disk. `mode`/`effort`/
 * `timeout` are required by JobConfig but ignored for `command` routines;
 * writeJob() drops the default ('auto'/'10m') values so the on-disk file stays
 * to the point (name + schedule + command + enabled).
 */
export function buildWatchdogRoutine(enabled: boolean): JobConfig {
  return {
    name: WATCHDOG_ROUTINE_NAME,
    schedule: WATCHDOG_ROUTINE_SCHEDULE,
    command: WATCHDOG_ROUTINE_COMMAND,
    enabled,
    mode: 'auto',
    effort: 'auto',
    timeout: '10m',
    prompt: '',
  };
}

/** Is the watchdog routine present on disk (user or system layer)? */
export function watchdogRoutineExists(): boolean {
  return readJob(WATCHDOG_ROUTINE_NAME) !== null;
}

/** Is the watchdog routine present AND enabled? */
export function isWatchdogRoutineEnabled(): boolean {
  const job = readJob(WATCHDOG_ROUTINE_NAME);
  return job !== null && job.enabled === true;
}

/**
 * Ensure the watchdog routine exists with the requested enabled state, preserving
 * any user edits. Absent → create it; present → only flip `enabled` (never clobber
 * a schedule or command the user tuned). Idempotent: calling it twice with the
 * same state is a no-op after the first.
 */
export function ensureWatchdogRoutine(enabled: boolean): void {
  const existing = readJob(WATCHDOG_ROUTINE_NAME);
  if (existing === null) {
    writeJob(buildWatchdogRoutine(enabled));
    return;
  }
  if (existing.enabled !== enabled) {
    setJobEnabled(WATCHDOG_ROUTINE_NAME, enabled);
  }
}
