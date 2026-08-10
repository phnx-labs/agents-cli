/**
 * Daemon account-state tick bodies.
 *
 * These two bodies are the `refreshUsage` / `refreshAuth` implementations the
 * daemon's `account-state-service.ts` timers call directly, in-process, on a
 * plain `setInterval` (usage every 60s, auth every ~3 min). They are NOT
 * routines and are never fired through the scheduler — the daemon owns usage and
 * authentication health as first-party device state (RUSH-2451).
 *
 * `refreshLocalFleetAuthState` is also called by `agents fleet`/`ssh` surfaces
 * that need a fresh local auth snapshot on demand; provider-level work is guarded
 * by the cross-process refresh lease so an explicit CLI refresh and the daemon
 * timer converge on the same published result.
 */

import type { FleetStatusRow } from './fleet-status.js';
import type { AuthProbeRow } from './auth-health.js';

export function isFreshFleetAuthSnapshot(
  value: { row: FleetStatusRow; authRows: AuthProbeRow[] },
  minimumCapturedAt: number,
): boolean {
  return value.row.capturedAt >= minimumCapturedAt
    && value.authRows.length > 0
    && value.authRows.every(authRow => authRow.health.checkedAt >= minimumCapturedAt);
}

/**
 * Fleet cache warm: publish THIS host's row for the caches `agents fleet
 * status` / `agents devices list` read (PUBLISH-OWN / READ-UNION, RUSH-2061).
 */
export async function refreshLocalFleetAuthState(): Promise<{ row: FleetStatusRow; authRows: import('./auth-health.js').AuthProbeRow[] }> {
  const { machineId } = await import('./machine-id.js');
  const { probeLocalFleetAuth, readFleetAuthRows, writeFleetAuthRows } = await import('./auth-health.js');
  const { getCliVersion } = await import('./version.js');
  const self = machineId();
  const requestedAt = Date.now();
  const minimumCapturedAt = requestedAt - 2 * 60_000;
  const { withRefreshLease } = await import('./refresh-coordinator.js');
  const { readFleetStatus, publishLocalFleetStatus } = await import('./fleet-status.js');
  return withRefreshLease({
    scope: 'auth',
    key: self,
    readCompleted: () => {
      const row = readFleetStatus()[self];
      if (!row) return null;
      return { row, authRows: readFleetAuthRows(self) };
    },
    // A recent daemon publication is the completed result, not a reason to probe
    // every provider a second time.
    isCompleted: (value) => isFreshFleetAuthSnapshot(value, minimumCapturedAt),
    refresh: async () => {
      const authRows = await probeLocalFleetAuth({ cliVersion: getCliVersion() });
      writeFleetAuthRows(self, authRows);
      const row = await publishLocalFleetStatus(self);
      return { row, authRows };
    },
  });
}

export async function runFleetCacheWarmTick(): Promise<void> {
  const result = await refreshLocalFleetAuthState();
  // A waiter receives the already-published fleet row. The auth-row count is
  // available only to the process that performed the provider probes.
  const row = result.row;
  const authCount = result.authRows.length;
  console.log(`fleet cache warm: ${authCount} auth row(s) refreshed, ${row.agents.running} running agent(s) on ${row.host}`);
}

/**
 * Usage refresh: keep the usage cache the `agents run` router reads
 * (RUSH-2061, readOnly hot path) fresh, WITHOUT the hot path ever fetching.
 * This host is the sole writer for its own local accounts.
 */
export async function runUsageRefreshTick(): Promise<void> {
  const { runUsageRefresh, buildLocalUsageAccounts } = await import('./usage-refresh.js');
  const { writeClaudeUsageCache } = await import('./usage.js');
  const { usageRateLimitedUntil } = await import('./usage-backoff.js');
  const r = await runUsageRefresh({
    listAccounts: buildLocalUsageAccounts,
    writeUsageCache: writeClaudeUsageCache,
    backoffUntil: usageRateLimitedUntil,
  });
  const { listProfiles } = await import('./profiles.js');
  const { refreshDueByokUsage } = await import('./byok-usage.js');
  const byok = await refreshDueByokUsage(listProfiles());
  console.log(
    `usage refresh: ${r.refreshed} refreshed, ${r.failed} failed, ${r.skippedNotDue} not-due, ${r.skippedBackoff} backed-off, ${r.skippedCap} capped; BYOK ${byok.refreshed} refreshed, ${byok.skipped} not-due`,
  );
}
