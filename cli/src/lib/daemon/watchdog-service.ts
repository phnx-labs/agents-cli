/**
 * Watchdog tick as a `PeriodicService` (RUSH-3193 P3).
 *
 * Nudges this host's own stalled agent sessions. Gated on the `watchdog.enabled`
 * device-config flag (`agents watchdog enable`), so the timer always fires but
 * only does work when the user opted in — the check happens inside the tick
 * itself, not the enable/disable registration gate, matching the pre-migration
 * inline behavior (daemon.ts previously `WATCHDOG_TICK_MS`-interval closure).
 */

import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { getConfigValue } from '../device-config.js';
import { emit } from '../feed/events.js';

/** Matches the historical inline interval (daemon.ts WATCHDOG_TICK_MS). */
const WATCHDOG_TICK_MS = 3 * 60_000;
/** Hard cap per tick — `runWatchdogPass` is host-local (adds no SSH fan-out of its own, `watchdog/runner.ts:580`); short enough that a hang never freezes the service for long. */
const WATCHDOG_DEADLINE_MS = 120_000;

export class WatchdogService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'watchdog';
  readonly intervalMs = WATCHDOG_TICK_MS;
  readonly deadlineMs = WATCHDOG_DEADLINE_MS;

  protected async onStart(_ctx: DaemonContext): Promise<void> {
    // No connections/handles to open — each tick re-reads the enable flag.
  }

  protected async onStop(): Promise<void> {
    // Nothing to release — the supervisor's timer teardown is the only cleanup needed.
  }

  protected async onTick(ctx: DaemonContext): Promise<void> {
    if (getConfigValue('watchdog.enabled').value !== true) return;
    const { runWatchdogPass } = await import('../watchdog/service.js');
    const result = await runWatchdogPass({ nudge: true });
    ctx.log('INFO', `watchdog: ${result.counts.total} live, ${result.counts.stalled} stalled, ${result.counts.nudged} nudged`);
    emit('watchdog.action', {
      module: 'watchdog',
      total: result.counts.total,
      stalled: result.counts.stalled,
      nudged: result.counts.nudged,
    });
  }
}
