/**
 * Fleet usage-snapshot sync as a `PeriodicService` (PHNX-3392 usage-sync).
 *
 * On a headed box (personal/desktop) each tick pushes the local identity-keyed
 * Claude usage rows to worker peers that cannot read usage themselves. A no-op on
 * a worker/unmarked box or when the local cache is empty — the driver
 * ({@link syncFleetUsageSnapshots}) gates on the self role, so this service is
 * safe to register everywhere. Single-executor per destination: each daemon only
 * writes the DESTINATION's own cache, and the merge is newest-wins + idempotent.
 */
import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';

const USAGE_SYNC_TICK_MS = 15 * 60_000;
const USAGE_SYNC_DEADLINE_MS = 2 * 60_000;
const USAGE_SYNC_KICKOFF_MS = 90_000;

export class UsageSyncService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'usage-sync';
  readonly intervalMs = USAGE_SYNC_TICK_MS;
  readonly deadlineMs = USAGE_SYNC_DEADLINE_MS;
  readonly startupDelayMs = USAGE_SYNC_KICKOFF_MS;

  protected async onStart(_ctx: DaemonContext): Promise<void> {
    // No connections to open — each tick re-reads the local cache + registry.
  }

  protected async onStop(): Promise<void> {
    // Nothing to release — the supervisor's timer teardown is the only cleanup.
  }

  protected async onTick(ctx: DaemonContext): Promise<void> {
    const { syncFleetUsageSnapshots } = await import('../accounting/usage-sync.js');
    const result = syncFleetUsageSnapshots();
    if (result.pushed.length > 0) {
      ctx.log('INFO', `usage-sync: pushed usage to ${result.pushed.join(', ')}`);
    }
    for (const err of result.errors) {
      ctx.log('WARN', `usage-sync: ${err.device}: ${err.message}`);
    }
  }
}
