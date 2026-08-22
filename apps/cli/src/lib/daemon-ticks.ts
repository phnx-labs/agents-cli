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
  // Only the usage-primary host fires the live provider probe. A subscriber
  // probing `/oauth/usage` on every 3-minute tick multiplied the fleet's
  // request rate against one per-account quota until the endpoint 429'd every
  // account and the shared backoff froze the usage cache (RUSH-2998). Mirror the
  // usage-refresh publisher/subscriber split so exactly one box hits the endpoint.
  const { resolveUsagePrimaryHost } = await import('./device-config.js');
  const { usageRefreshRole } = await import('./usage-fleet.js');
  const liveProbe = usageRefreshRole(resolveUsagePrimaryHost() ?? undefined, self) === 'publisher';
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
      const authRows = await probeLocalFleetAuth({ cliVersion: getCliVersion(), liveProbe });
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
 * The configured primary host is the fleet's sole provider-facing writer;
 * subscribers import its token-free derived cache.
 */
export async function runUsageRefreshTick(): Promise<void> {
  const { resolveUsagePrimaryHost } = await import('./device-config.js');
  const { machineId } = await import('./machine-id.js');
  // usage.primary-host, else interactive.host, else null (standalone local refresh)
  const primaryHost = resolveUsagePrimaryHost() ?? undefined;

  const self = machineId();
  const { importUsageFleetFromHost, usageRefreshRole } = await import('./usage-fleet.js');
  if (usageRefreshRole(primaryHost, self) === 'subscriber') {
    const imported = await importUsageFleetFromHost(primaryHost!);
    console.log(`usage refresh: imported ${Object.keys(imported.usage).length} account(s) from primary host ${primaryHost}`);
    return;
  }

  const { runUsageRefresh, buildLocalUsageAccounts } = await import('./usage-refresh.js');
  const { writeClaudeUsageCache } = await import('./accounting/usage.js');
  const { usageRateLimitedUntil } = await import('./usage-backoff.js');
  const r = await runUsageRefresh({
    listAccounts: buildLocalUsageAccounts,
    writeUsageCache: writeClaudeUsageCache,
    backoffUntil: usageRateLimitedUntil,
  });
  const { listProfiles } = await import('./profiles.js');
  const { refreshDueByokUsage } = await import('./byok-usage.js');
  const byok = await refreshDueByokUsage(listProfiles());
  const { exportUsageFleet } = await import('./usage-fleet.js');
  const published = exportUsageFleet();
  console.log(
    `usage refresh: ${r.refreshed} refreshed, ${r.failed} failed, ${r.skippedNotDue} not-due, ${r.skippedBackoff} backed-off, ${r.skippedCap} capped; BYOK ${byok.refreshed} refreshed, ${byok.skipped} not-due; published ${Object.keys(published.usage).length} account(s)`,
  );
}

/**
 * Active-sessions warm (RUSH-2062 / RUSH-2484): publish THIS host's live session
 * rows so `agents sessions watch` (and the extension that tails it) receive
 * journal deltas. Publish-own only — no cross-host SSH.
 *
 * Cadence matches {@link DEFAULT_ACTIVE_CACHE_MAX_AGE_MS} so one-shot readers and
 * long-lived watchers share one writer. Without this tick the journal has no
 * continuous producer and Factory freezes after the initial cache snapshot.
 */
export async function runActiveSessionsWarmTick(
  opts: { gather?: () => Promise<import('./session/active.js').ActiveSession[]> } = {},
): Promise<{ sessions: number }> {
  const { publishLocalActiveSessions } = await import('./session/session-cache.js');
  const r = await publishLocalActiveSessions({ gather: opts.gather });
  console.log(`active-sessions warm: ${r.sessions.length} session(s) published`);
  return { sessions: r.sessions.length };
}

/**
 * Session-index warm (RUSH-2682): incrementally scan THIS host's transcript dirs
 * into the local SQLite index on a timer, so a session started HERE reaches this
 * box's index within seconds instead of on the next unrelated `agents sessions*`
 * call. Indexing was otherwise lazy — only `discoverSessions` writes the index,
 * and nothing scheduled it — which inverted freshness: a peer's session arrived
 * via sync in ~0s while a locally-started one sat unindexed for minutes.
 *
 * The scan is incremental (only files whose mtime/size changed) and single-flight
 * across processes via the DB scan claim, so a foreground `agents sessions*` and
 * this tick never double-scan. The daemon is the single scheduled executor,
 * consistent with the one-scheduler rule.
 *
 * Calls `scanSessionsIncremental`, NOT `discoverSessions` (RUSH-2691). A bare
 * `discoverSessions()` ends in a listing query that defaults its cwd filter to
 * `process.cwd()` — the daemon's, i.e. `$HOME` — and caps at 50, so its row count
 * described "sessions whose cwd is exactly $HOME", which is 0 on a normal box no
 * matter how much the scan indexed. The tick reported that 0 every 20s while
 * still paying for the query's existence check and Linear fetch. Scanning
 * directly reports what was actually parsed and skips the query entirely.
 */
export async function runSessionIndexWarmTick(): Promise<{ indexed: number; claimed: boolean }> {
  const { scanSessionsIncremental } = await import('./session/discover.js');
  const { claimed, scanned } = await scanSessionsIncremental();
  // A skipped claim is not a failure — a foreground `agents sessions*` is
  // scanning right now and this tick would be a duplicate.
  if (!claimed) return { indexed: 0, claimed: false };
  return { indexed: scanned, claimed: true };
}
