/**
 * Daemon housekeeping ticks — one-shot bodies invoked by daemon-owned routines.
 *
 * RUSH-2353: these were ~15 hardcoded `setInterval` timers inside
 * `runDaemon()` (daemon.ts) — a parallel, inferior reimplementation of the
 * routines system (no declaration, no run history, no pause/disable, no
 * device pin). Each function here is one migrated tick's *body*, unchanged in
 * behavior, invoked as a detached one-shot process by a routine's `command:`
 * (via the `agents __daemon-tick <name>` entrypoint in index.ts) instead of an
 * in-process interval closure.
 *
 * RUSH-2465: the routine DEFINITIONS that drive these bodies moved out of the
 * `.agents-system` config repo and into daemon code (`builtin-routines.ts`),
 * injected as the lowest layer of `listJobs()`. The bodies here are unchanged
 * and still fired via `agents __daemon-tick <name>`; only the home of the
 * definition moved. `DAEMON_TICK_ROUTINE_NAMES` below is the single source of
 * truth the built-in registry is tested against for drift.
 *
 * Overlap protection that used to live in daemon.ts as a per-tick boolean
 * flag (`watchdogInFlight`, `probingDevices`, ...) is now provided by the
 * routine runner's launch claim (`withRoutineLaunchClaim` in runner.ts) — two
 * fires of the same routine name never run concurrently.
 *
 * Output goes to `console.log`/`console.error`: each tick runs as a spawned
 * child of `executeCommandJobDetached`, which redirects the child's stdout to
 * the run's `stdout.log` — so this doubles as the run's log, readable via
 * `agents routines runs <name>`.
 */

import { getConfigValue } from './device-config.js';
import type { FleetStatusRow } from './fleet-status.js';

/** ~every 3 min. Mirrors the old WATCHDOG_TICK_MS. */
export async function runWatchdogTick(): Promise<void> {
  if (getConfigValue('watchdog.enabled').value !== true) {
    console.log('watchdog: disabled (watchdog.enabled != true) — skipping');
    return;
  }
  const { runWatchdogPass } = await import('./watchdog/service.js');
  const result = await runWatchdogPass({ nudge: true });
  console.log(`watchdog: ${result.counts.total} live, ${result.counts.stalled} stalled, ${result.counts.nudged} nudged`);
}

/**
 * Device probe: refresh registered devices' reachability and detect newly
 * appeared tailnet nodes, dropping a sentinel per pending device so the
 * menu-bar helper can surface "NEW DEVICES -> Register / Ignore". Refresh
 * mode never auto-registers a newcomer. A machine without tailscale is a
 * clean no-op. ~every 3 min.
 */
export async function runDeviceProbeTick(): Promise<void> {
  const { runDeviceSync } = await import('./devices/sync.js');
  const { reconcilePendingSentinels } = await import('./devices/pending.js');
  const dev = await runDeviceSync({ soft: true, mode: 'refresh' });
  if (!dev.ok) {
    console.log('device probe: sync not ok — skipping sentinel reconcile');
    return;
  }
  reconcilePendingSentinels(dev.pending);
  if (dev.pending.length) {
    console.log(`devices: ${dev.pending.length} new pending (${dev.pending.map((p) => p.name).join(', ')})`);
  } else {
    console.log('device probe: no new pending devices');
  }
}

/**
 * tmux hook reconcile: retrofit the guarded `pane-died` hook onto managed
 * `agents run` sessions a pre-fix binary left with the old unconditional
 * hook. Non-destructive: set-hook only, never a kill or detach. ~every 5 min.
 */
export async function runTmuxReconcileTick(): Promise<void> {
  const { isTmuxInstalled } = await import('./tmux/binary.js');
  if (!isTmuxInstalled()) {
    console.log('tmux reconcile: tmux not installed — skipping');
    return;
  }
  const { reconcileSessionHooks } = await import('./tmux/session.js');
  const r = await reconcileSessionHooks();
  console.log(`tmux: retrofitted pane-died hook on ${r.reconciled} session(s)`);
}

/**
 * Launch-health self-heal: probe that each agent's DEFAULT version actually
 * LAUNCHES, and repair a gutted install. Never repoints the global default
 * (allowDefaultSwitch: false) — a background default switch would be a
 * silent logout. ~every 6h.
 */
export async function runLaunchHealthTick(): Promise<void> {
  const { healBrokenDefaultLaunches } = await import('./versions.js');
  const { repaired, unhealed } = await healBrokenDefaultLaunches(
    (m) => console.log(`launch-health: ${m}`),
    { allowDefaultSwitch: false },
  );
  if (repaired.length) console.log(`launch-health: repaired ${repaired.join(', ')}`);
  if (unhealed.length) {
    console.log(`launch-health: ${unhealed.join(', ')} won't launch and will not be auto-switched — choose a version with \`agents use <agent> <version>\` or \`agents add <agent>@latest\``);
  }
  if (!repaired.length && !unhealed.length) console.log('launch-health: all default launches healthy');
}

/**
 * Fleet cache warm: publish THIS host's row for the caches `agents fleet
 * status` / `agents devices list` read (PUBLISH-OWN / READ-UNION, RUSH-2061).
 * ~every 3 min.
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
    // During mixed-version rollout the former system routine may still fire.
    // A recent daemon publication is the completed result, not a reason to
    // probe every provider a second time.
    isCompleted: (value) => value.row.capturedAt >= minimumCapturedAt,
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
 * Session-status cache warm (RUSH-2062): publish THIS host's local active
 * sessions so menubar / Factory / watchdog / CLI share one warm snapshot.
 * Publish-own only (no cross-host SSH). ~every 3 min.
 */
export async function runSessionCacheWarmTick(): Promise<void> {
  const { publishLocalActiveSessions } = await import('./session/session-cache.js');
  const r = await publishLocalActiveSessions();
  console.log(`session cache warm: ${r.sessions.length} local session(s)`);
}

/**
 * Usage refresh: keep the usage cache the `agents run` router reads
 * (RUSH-2061, readOnly hot path) fresh, WITHOUT the hot path ever fetching.
 * This host is the sole writer for its own local accounts. ~every 60s
 * (USAGE_REFRESH_TICK_MS in usage-refresh.ts — keep in sync).
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

/**
 * Auto-dispatch: for any managed project that has opted in (autoDispatch:true
 * + maxAgents>0 in ~/.agents/factory/projects.json), pick up Linear tickets
 * delegated to an agent and still in Todo, and dispatch each through
 * agents-cli's own cloud-provider layer. OFF unless a project opts in; no
 * opted-in project or no LINEAR_API_KEY is a clean no-op. ~every 3 min.
 *
 * Migrated to a routine (RUSH-2353) so it inherits the `devices:` allowlist —
 * pin with `agents routines devices auto-dispatch --set <one>` to fix the
 * shared-input double-fire problem this job had hardcoded (every daemon on
 * the fleet polled the same Linear queue with no coordination).
 */
export async function runAutoDispatchTick(): Promise<void> {
  const { readAutoDispatchProjects, isEligible, autoDispatchTick } = await import('./auto-dispatch.js');
  const projects = readAutoDispatchProjects();
  if (!projects.some(isEligible)) {
    console.log('auto-dispatch: no opted-in project — skipping');
    return;
  }
  const { createLinearGateway } = await import('./auto-dispatch-linear.js');
  const linear = createLinearGateway();
  if (!linear) {
    console.log('auto-dispatch: no LINEAR_API_KEY configured — skipping');
    return;
  }
  const { createProviderDispatcher } = await import('./auto-dispatch-provider.js');
  const dispatcher = createProviderDispatcher();
  const dispatched = await autoDispatchTick({
    projects,
    linear,
    dispatcher,
    log: (lvl, m) => (lvl === 'ERROR' ? console.error(m) : console.log(m)),
  });
  if (dispatched.length) {
    console.log(`auto-dispatch: started ${dispatched.length} delegated ticket(s): ${dispatched.map((d) => d.identifier).join(', ')}`);
  } else {
    console.log('auto-dispatch: no delegated tickets to dispatch');
  }
}

/** Registry: routine-facing name -> tick body. Keys match the shipped routine YAML names. */
export const DAEMON_TICKS: Record<string, () => Promise<void>> = {
  watchdog: runWatchdogTick,
  'device-probe': runDeviceProbeTick,
  'tmux-reconcile': runTmuxReconcileTick,
  'launch-health': runLaunchHealthTick,
  'fleet-cache-warm': runFleetCacheWarmTick,
  'session-cache-warm': runSessionCacheWarmTick,
  'usage-refresh': runUsageRefreshTick,
  'auto-dispatch': runAutoDispatchTick,
};

export const DAEMON_TICK_ROUTINE_NAMES = Object.freeze(Object.keys(DAEMON_TICKS));

/** Run one named tick, or throw for an unknown name (fails the routine run loud). */
export async function runDaemonTick(name: string): Promise<void> {
  const fn = DAEMON_TICKS[name];
  if (!fn) {
    throw new Error(`Unknown daemon tick '${name}'. Known: ${Object.keys(DAEMON_TICKS).join(', ')}`);
  }
  await fn();
}
