/**
 * Account-state service lifecycle as a `DaemonService` (RUSH-3193 P2).
 *
 * Wraps `startAccountStateService()` under the `ServiceSupervisor` contract
 * so the supervisor owns start/stop and reports health through the uniform
 * path. The account-state service owns its own internal intervals for usage
 * and auth refreshes; the supervisor just starts and stops it.
 */

import { BaseDaemonService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { startAccountStateService, type AccountStateService } from '../account-state-service.js';
import { runUsageRefreshTick, runFleetCacheWarmTick } from '../daemon-ticks.js';

export class AccountStateDaemonService extends BaseDaemonService {
  readonly id: DaemonServiceId = 'account-state';

  private service: AccountStateService | null = null;

  protected async onStart(ctx: DaemonContext): Promise<void> {
    this.service = startAccountStateService({
      refreshUsage: runUsageRefreshTick,
      refreshAuth: runFleetCacheWarmTick,
      onError: (area, error) =>
        ctx.log('WARN', `${area} state refresh failed: ${(error as Error).message}`),
    });
  }

  protected async onStop(): Promise<void> {
    this.service?.stop();
    this.service = null;
  }
}
