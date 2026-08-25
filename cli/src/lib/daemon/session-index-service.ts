/**
 * Session-index warm service (RUSH-2682), migrated onto `ServiceSupervisor`
 * (RUSH-3193 P1) as the proof-of-concept periodic service.
 *
 * Incrementally scans this host's transcript dirs into the local index so a
 * locally-started session is discoverable within seconds, not on the next
 * unrelated `agents sessions*` call. Single-flight via the DB scan claim in
 * `scanSessionsIncremental` — a concurrent foreground scan is a skip, not a
 * failure. Previously a bare `setInterval` in `runDaemon()`
 * (daemon.ts:1118-1137); the supervisor now owns its timer, error boundary,
 * and deadline instead.
 */

import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { runSessionIndexWarmTick } from '../daemon-ticks.js';

/** Matches the historical inline interval (daemon.ts SESSION_INDEX_WARM_TICK_MS). */
const SESSION_INDEX_WARM_TICK_MS = 20_000;
/** Hard cap per tick — well above a healthy incremental scan, short enough that a hang never freezes the service for long. */
const SESSION_INDEX_WARM_DEADLINE_MS = 60_000;

export class SessionIndexService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'session-index';
  readonly intervalMs = SESSION_INDEX_WARM_TICK_MS;
  readonly deadlineMs = SESSION_INDEX_WARM_DEADLINE_MS;

  protected async onStart(_ctx: DaemonContext): Promise<void> {
    // No connections/handles to open — the scan claim itself is per-tick state.
  }

  protected async onStop(): Promise<void> {
    // Nothing to release — the supervisor's timer teardown is the only cleanup needed.
  }

  protected async onTick(ctx: DaemonContext): Promise<void> {
    const { indexed, claimed } = await runSessionIndexWarmTick();
    // Log only when the tick did something. A silent tick is what let it
    // report 0 forever unnoticed (RUSH-2691); a line on every idle 20s tick
    // would drown the log, so the steady state (claimed, nothing changed)
    // stays quiet and both interesting outcomes are visible.
    if (!claimed) ctx.log('INFO', 'session-index warm: skipped, another process holds the scan claim');
    else if (indexed > 0) ctx.log('INFO', `session-index warm: indexed ${indexed} transcript(s)`);
  }
}
