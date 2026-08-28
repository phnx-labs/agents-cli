/**
 * Fleet usage-snapshot sync as a `PeriodicService` (PHNX-3392 usage-sync).
 *
 * On a headed box (personal/desktop) each tick pushes the local identity-keyed
 * Claude usage rows to worker peers that cannot read usage themselves. On a
 * worker whose cache is empty or stale, the same tick pulls those rows from the
 * primary headed device. Both drivers gate on the self role, so this service is
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
    const { pullUsageFromPrimary, syncFleetUsageSnapshots } = await import('../accounting/usage-sync.js');
    const pushResult = syncFleetUsageSnapshots();
    if (pushResult.pushed.length > 0) {
      ctx.log('INFO', `usage-sync: pushed usage to ${pushResult.pushed.join(', ')}`);
    }
    for (const err of pushResult.errors) {
      ctx.log('WARN', `usage-sync: ${err.device}: ${err.message}`);
    }
    const pullResult = pullUsageFromPrimary();
    if (pullResult.pulledFrom) {
      ctx.log('INFO', `usage-sync: pulled usage from ${pullResult.pulledFrom}; merged ${pullResult.merged} row(s)`);
    }
    if (pullResult.error) ctx.log('WARN', `usage-sync: pull: ${pullResult.error}`);
  }
}
