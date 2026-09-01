/**
 * Keychain orphan reaper tick as a `PeriodicService` (RUSH-3193 P3).
 *
 * Kills stuck keychain helper and `agents` processes whose keychain call
 * never returned (RUSH-2232). Single-executor: only the daemon runs this, so
 * no cross-device race.
 */

import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';

/** Matches the historical inline interval (daemon.ts KEYCHAIN_REAP_TICK_MS). */
const KEYCHAIN_REAP_TICK_MS = 5 * 60_000;
/** Hard cap per tick — a process-table scan + targeted kills, short enough a hang never freezes the service for long. */
const KEYCHAIN_REAP_DEADLINE_MS = 30_000;

export class KeychainReapService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'keychain-reap';
  readonly intervalMs = KEYCHAIN_REAP_TICK_MS;
  readonly deadlineMs = KEYCHAIN_REAP_DEADLINE_MS;

  protected async onStart(_ctx: DaemonContext): Promise<void> {
    // No connections/handles to open — each tick performs a fresh process scan.
  }

  protected async onStop(): Promise<void> {
    // Nothing to release — the supervisor's timer teardown is the only cleanup needed.
  }

  protected async onTick(ctx: DaemonContext): Promise<void> {
    const { reapOrphanedKeychainProcesses } = await import('../secrets/reaper.js');
    const result = await reapOrphanedKeychainProcesses();
    if (result.reaped > 0) {
      ctx.log('WARN', `Reaped ${result.reaped} keychain orphan/stuck process(es)`);
      for (const d of result.details) ctx.log('WARN', `  ${d}`);
    }
  }
}
