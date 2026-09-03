/**
 * Reserved `auth` bundle fleet sync as a `PeriodicService` (PHNX-2371).
 *
 * Each daemon publishes a safe readiness verdict to the fleet-shared user repo,
 * then runs the same serialized, timeout-bounded git exchange as usage sync.
 * One deterministic ready device asynchronously provisions peers whose delivered
 * verdict says `missing`; the secret never enters Git.
 */
import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';

const AUTH_SYNC_TICK_MS = 15 * 60_000;
const AUTH_SYNC_DEADLINE_MS = 2 * 60_000;
const AUTH_SYNC_KICKOFF_MS = 60_000;

export class AuthSyncService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'auth-sync';
  readonly intervalMs = AUTH_SYNC_TICK_MS;
  readonly deadlineMs = AUTH_SYNC_DEADLINE_MS;
  readonly startupDelayMs = AUTH_SYNC_KICKOFF_MS;

  protected async onStart(_ctx: DaemonContext): Promise<void> {
    // No connections to open — each tick re-reads the local bundle + registry.
  }

  protected async onStop(): Promise<void> {
    // Nothing to release — the supervisor's timer teardown is the only cleanup.
  }

  protected async onTick(ctx: DaemonContext): Promise<void> {
    const { publishReservedAuthVerdict, syncReservedAuthBundle } = await import('../secrets/reserved-sync.js');
    const published = await publishReservedAuthVerdict();
    if (published.error) ctx.log('WARN', `auth-sync: verdict: ${published.error}`);
    const { syncFleetSharedStateRepo } = await import('../fleet-shared-repo-sync.js');
    const transport = await syncFleetSharedStateRepo();
    if (transport.skipped) ctx.log('WARN', `auth-sync: ${transport.skipped}`);
    if (transport.error) ctx.log('WARN', `auth-sync: shared-store transport: ${transport.error}`);
    if (transport.untrackedBackedUp?.length) {
      ctx.log('WARN', `auth-sync: backed up ${transport.untrackedBackedUp.length} untracked shared-store collision(s) to ${transport.untrackedBackupDir}: ${transport.untrackedBackedUp.join(', ')}`);
    }
    if (!transport.success) return;
    const result = await syncReservedAuthBundle();
    if (result.pushed.length > 0) {
      ctx.log('INFO', `auth-sync: pushed auth to ${result.pushed.join(', ')}`);
    }
    for (const err of result.errors) {
      ctx.log('WARN', `auth-sync: ${err.device}: ${err.message}`);
    }
  }
}
