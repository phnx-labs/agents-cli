/**
 * Browser IPC server lifecycle as a `DaemonService` (RUSH-3193 P2).
 *
 * Wraps `BrowserIPCServer` (backed by a `BrowserService`) under the
 * `ServiceSupervisor` contract. `onStart()` runs the orphan-process reap
 * that must happen before the BrowserService comes up (same as the comment
 * at daemon.ts:1303 — reaps browser/tunnel processes from prior daemons so
 * the new session doesn't hijack stale tunnels or fail to bind claimed ports).
 *
 * `getBrowserService()` exposes the underlying `BrowserService` so daemon.ts's
 * browser-task-reap interval can pass it to `runBrowserTaskReap`.
 */

import { BaseDaemonService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { BrowserService } from '../browser/service.js';
import { BrowserIPCServer } from '../browser/ipc.js';

export class BrowserIPCService extends BaseDaemonService {
  readonly id: DaemonServiceId = 'browser-ipc';

  private readonly browserSvc: BrowserService;
  private ipc: BrowserIPCServer | null = null;

  constructor(browserService: BrowserService) {
    super();
    this.browserSvc = browserService;
  }

  /** Returns the underlying `BrowserService` (available after construction, before/after start). */
  getBrowserService(): BrowserService {
    return this.browserSvc;
  }

  protected async onStart(ctx: DaemonContext): Promise<void> {
    // Reap browser/tunnel orphans from prior daemons before the IPC server
    // binds. A hard-crashed daemon may leave processes that either hijack a
    // stale CDP profile or hold ports the new socket would need.
    try {
      const { reapOrphanedProcesses } = await import('../browser/runtime-state.js');
      const result = reapOrphanedProcesses();
      if (result.reaped > 0) {
        ctx.log('INFO', `Reaped ${result.reaped} orphan process(es) from prior daemon(s)`);
        for (const d of result.details) ctx.log('INFO', `  ${d}`);
      }
    } catch (err) {
      ctx.log('ERROR', `Orphan reaper failed: ${(err as Error).message}`);
    }

    this.ipc = new BrowserIPCServer(this.browserSvc);
    await this.ipc.start();
    ctx.log('INFO', 'Browser IPC server started');
  }

  protected async onStop(): Promise<void> {
    if (this.ipc) {
      await this.ipc.stop();
      this.ipc = null;
    }
  }
}
