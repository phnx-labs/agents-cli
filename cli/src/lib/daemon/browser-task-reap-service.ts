/** Abandoned browser-task cleanup under supervision. */

import { BrowserService } from '../browser/service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { resolveBrowserTaskIdleMs } from '../device-config.js';
import { BasePeriodicService, type DaemonContext } from './service.js';

const BROWSER_TASK_REAP_TICK_MS = 5 * 60_000;
const BROWSER_TASK_REAP_DEADLINE_MS = 2 * 60_000;

export class BrowserTaskReapService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'browser-task-reap';
  readonly intervalMs = BROWSER_TASK_REAP_TICK_MS;
  readonly deadlineMs = BROWSER_TASK_REAP_DEADLINE_MS;

  constructor(private readonly browserService: BrowserService) {
    super();
  }

  protected async onStart(_ctx: DaemonContext): Promise<void> {}
  protected async onStop(): Promise<void> {}

  protected async onTick(ctx: DaemonContext): Promise<void> {
    const result = await this.browserService.reapAbandoned({ idleMs: resolveBrowserTaskIdleMs() });
    if (result.closed.length > 0) {
      ctx.log('INFO', `Browser-task reaper: closed ${result.closed.length} task(s)`);
      for (const closed of result.closed) {
        ctx.log('INFO', `  ${closed.task} (${closed.reason}, profile ${closed.profile})`);
      }
    }
  }
}
