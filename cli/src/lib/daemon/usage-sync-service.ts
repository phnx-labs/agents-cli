/**
 * Fleet usage-snapshot sync as a `PeriodicService` (PHNX-3392 usage-sync).
 *
 * A headed box publishes its local identity-keyed Claude usage rows into its
 * owned file in the fleet-synced user repo. The tick then runs one serialized,
 * timeout-bounded git exchange; a worker reads the delivered peer snapshots
 * and merges newest-wins. No tick opens a device-to-device SSH mesh.
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
    const { consumeUsageSnapshotsFromSharedStore, publishUsageSnapshotToSharedStore } = await import('../accounting/usage-sync.js');
    const published = publishUsageSnapshotToSharedStore();
    if (published.changed) ctx.log('INFO', `usage-sync: published usage snapshot to ${published.path}`);
    if (published.error) ctx.log('WARN', `usage-sync: publish: ${published.error}`);
    const { syncFleetSharedStateRepo } = await import('../fleet-shared-repo-sync.js');
    const transport = await syncFleetSharedStateRepo();
    if (transport.skipped) ctx.log('WARN', `usage-sync: ${transport.skipped}`);
    if (transport.error) ctx.log('WARN', `usage-sync: shared-store transport: ${transport.error}`);
    if (!transport.success) return;
    const consumed = consumeUsageSnapshotsFromSharedStore();
    if (consumed.merged > 0) {
      ctx.log('INFO', `usage-sync: merged ${consumed.merged} row(s) from ${consumed.sources.join(', ')}`);
    }
    for (const err of consumed.errors) ctx.log('WARN', `usage-sync: ${err.device}: ${err.message}`);
  }
}
