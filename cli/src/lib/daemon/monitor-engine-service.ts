/**
 * MonitorEngine lifecycle as a `DaemonService` (RUSH-3193 P2).
 *
 * Wraps the `MonitorEngine` (event-triggered watchers) under the
 * `ServiceSupervisor` contract. The engine can own a timer when embedded by a
 * foreground caller, but the daemon starts it in external-scheduler mode so
 * every evaluation cycle receives the supervisor's deadline, health, and
 * circuit-breaker semantics.
 *
 * `getEngine()` exposes the underlying `MonitorEngine` so `daemon.ts`'s
 * SIGHUP handler can call `engine.reload()` when needed.
 */

import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { MONITOR_ENGINE_TICK_MS, MonitorEngine } from '../monitors/engine.js';

export class MonitorEngineService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'monitors';
  readonly intervalMs = MONITOR_ENGINE_TICK_MS;
  readonly deadlineMs = 2 * 60_000;

  private engine: MonitorEngine | null = null;

  /** Returns the live engine after `start()`, or `null` before/after. */
  getEngine(): MonitorEngine | null {
    return this.engine;
  }

  protected async onStart(ctx: DaemonContext): Promise<void> {
    this.engine = new MonitorEngine((level, message) => ctx.log(level, message));
    this.engine.start({ externalScheduler: true });
  }

  protected async onStop(): Promise<void> {
    this.engine?.stop();
    this.engine = null;
  }

  protected async onTick(_ctx: DaemonContext): Promise<void> {
    if (!this.engine) throw new Error('monitor engine tick requested before start');
    await this.engine.tick();
  }
}
