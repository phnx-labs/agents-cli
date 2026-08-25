/**
 * MonitorEngine lifecycle as a `DaemonService` (RUSH-3193 P2).
 *
 * Wraps the `MonitorEngine` (event-triggered watchers) under the
 * `ServiceSupervisor` contract. This is a lifecycle-only service — the engine
 * runs its own internal event loop; the supervisor just calls `start()` at
 * boot and `stop()` at shutdown.
 *
 * `getEngine()` exposes the underlying `MonitorEngine` so `daemon.ts`'s
 * SIGHUP handler can call `engine.reload()` when needed.
 */

import { BaseDaemonService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { MonitorEngine } from '../monitors/engine.js';

export class MonitorEngineService extends BaseDaemonService {
  readonly id: DaemonServiceId = 'monitors';

  private engine: MonitorEngine | null = null;

  /** Returns the live engine after `start()`, or `null` before/after. */
  getEngine(): MonitorEngine | null {
    return this.engine;
  }

  protected async onStart(ctx: DaemonContext): Promise<void> {
    this.engine = new MonitorEngine((level, message) => ctx.log(level, message));
    this.engine.start();
  }

  protected async onStop(): Promise<void> {
    this.engine?.stop();
    this.engine = null;
  }
}
