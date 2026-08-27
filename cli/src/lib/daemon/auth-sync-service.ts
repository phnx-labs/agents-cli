/**
 * Reserved `auth` bundle fleet sync as a `PeriodicService` (PHNX-2371).
 *
 * Each daemon that has a local file-backed `auth` bundle pushes it to pinned
 * fleet devices that do not yet have it. The destination auto-provisions its
 * own machine-local key; no passphrase is forwarded. Single-executor per
 * destination: this process only writes the remote's own store.
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
    const { syncReservedAuthBundle } = await import('../secrets/reserved-sync.js');
    const result = syncReservedAuthBundle();
    if (result.pushed.length > 0) {
      ctx.log('INFO', `auth-sync: pushed auth to ${result.pushed.join(', ')}`);
    }
    for (const err of result.errors) {
      ctx.log('WARN', `auth-sync: ${err.device}: ${err.message}`);
    }
  }
}
