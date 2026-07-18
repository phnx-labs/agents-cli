/**
 * Daemon lifecycle management for the routines scheduler.
 *
 * The daemon is a long-running process that holds a JobScheduler and
 * triggers jobs on their cron schedules. It can be managed via launchd
 * (macOS), systemd (Linux), or as a plain detached process. PID tracking,
 * log output, reload (SIGHUP), and graceful shutdown are handled here.
 */

import { spawn, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getDaemonDir as getDaemonDirRoot } from './state.js';
import { isAlive, killTree, backgroundSpawnOptions } from './platform/index.js';
import { listJobs as listAllJobs } from './routines.js';
import { JobScheduler } from './scheduler.js';
import { MonitorEngine } from './monitors/engine.js';
import { executeJobDetached, monitorRunningJobs } from './runner.js';
import { detectOverdueJobs, notifyOverdue } from './overdue.js';
import { BrowserService } from './browser/service.js';
import { BrowserIPCServer } from './browser/ipc.js';
import { readAndResolveBundleEnv } from './secrets/bundles.js';
import { redactSecrets } from './redact.js';
import { getAgentsBinPath, getCliLaunch, BUN_VIRTUAL_ROOT } from './cli-entry.js';

const PID_FILE = 'daemon.pid';
const LOCK_FILE = 'daemon.lock';
const LOG_FILE = 'logs.jsonl';
const HEARTBEAT_FILE = 'heartbeat.json';
const LOG_MAX_SIZE = 5 * 1024 * 1024; // 5 MB
const LOG_ROTATE_COUNT = 3;
const PLIST_NAME = 'com.phnx-labs.agents-daemon';
const SYSTEMD_UNIT = 'agents-daemon.service';
const MONITOR_TICK_MS = 60_000;
const WEDGE_THRESHOLD_TICKS = 3;

// A long-lived `claude setup-token` value stored in this secrets bundle/key is
// baked into the daemon's service-manager environment so headless routine runs
// authenticate without depending on the short-lived interactive Keychain OAuth
// session (which expires between runs and produces intermittent 401s).
const DAEMON_OAUTH_BUNDLE = 'claude';
const DAEMON_OAUTH_KEY = 'CLAUDE_CODE_OAUTH_TOKEN';

function getDaemonDir(): string {
  const dir = getDaemonDirRoot();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getPidPath(): string {
  return path.join(getDaemonDir(), PID_FILE);
}

function getLockPath(): string {
  return path.join(getDaemonDir(), LOCK_FILE);
}

/**
 * Acquire an exclusive start lock. Returns a release function on success,
 * or null if another process already holds the lock. Uses O_EXCL to
 * atomically create the file — no TOCTOU window.
 */
function acquireStartLock(): (() => void) | null {
  const lockPath = getLockPath();
  try {
    const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return () => {
      try { fs.unlinkSync(lockPath); } catch { /* already removed */ }
    };
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      // Lock file exists — check if the holder is still alive (stale lock recovery)
      try {
        const holderPid = parseInt(fs.readFileSync(lockPath, 'utf-8').trim(), 10);
        if (!isNaN(holderPid)) {
          try {
            process.kill(holderPid, 0);
            return null; // holder is alive, lock is valid
          } catch {
            // holder is dead, remove stale lock and retry once
            fs.unlinkSync(lockPath);
            return acquireStartLock();
          }
        }
      } catch { /* can't read lock file — treat as held */ }
      return null;
    }
    throw err;
  }
}

function getLogPath(): string {
  return path.join(getDaemonDir(), LOG_FILE);
}

function getLaunchdPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_NAME}.plist`);
}

function getSystemdUnitPath(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', `${SYSTEMD_UNIT}`);
}

/** Read the stored daemon PID from disk. Returns null if not present or invalid. */
export function readDaemonPid(): number | null {
  const pidPath = getPidPath();
  if (!fs.existsSync(pidPath)) return null;
  try {
    const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/** Write the daemon PID to the pid file. */
export function writeDaemonPid(pid: number): void {
  fs.writeFileSync(getPidPath(), String(pid), 'utf-8');
}

/** Remove the daemon PID file. */
export function removeDaemonPid(): void {
  const pidPath = getPidPath();
  if (fs.existsSync(pidPath)) {
    fs.unlinkSync(pidPath);
  }
}

export interface DaemonHeartbeat {
  lastTick: string;
  pid: number;
}

function getHeartbeatPath(): string {
  return path.join(getDaemonDir(), HEARTBEAT_FILE);
}

export function writeHeartbeat(pid: number = process.pid): void {
  const hb: DaemonHeartbeat = { lastTick: new Date().toISOString(), pid };
  try {
    fs.writeFileSync(getHeartbeatPath(), JSON.stringify(hb), 'utf-8');
  } catch { /* best effort */ }
}

export function readHeartbeat(): DaemonHeartbeat | null {
  try {
    const raw = fs.readFileSync(getHeartbeatPath(), 'utf-8');
    const hb = JSON.parse(raw) as DaemonHeartbeat;
    if (!hb.lastTick || !hb.pid) return null;
    return hb;
  } catch {
    return null;
  }
}

export function removeHeartbeat(): void {
  try { fs.unlinkSync(getHeartbeatPath()); } catch { /* already removed */ }
}

export function isDaemonWedged(): boolean {
  const pid = readDaemonPid();
  if (!pid) return false;
  if (!isAlive(pid)) return false;
  const hb = readHeartbeat();
  if (!hb) return false;
  if (hb.pid !== pid) return false;
  const elapsed = Date.now() - Date.parse(hb.lastTick);
  return elapsed > WEDGE_THRESHOLD_TICKS * MONITOR_TICK_MS;
}

/** Check if the daemon process is alive by sending signal 0 to the stored PID. */
export function isDaemonRunning(): boolean {
  const pid = readDaemonPid();
  if (!pid) return false;
  if (isAlive(pid)) return true;
  removeDaemonPid();
  return false;
}

/**
 * Single-instance claim for the daemon `_run` entrypoint.
 *
 * `agents daemon _run` is reachable directly — a manual invocation, or a
 * service-manager restart that races a still-alive predecessor — bypassing the
 * start lock in startDaemon(). Without this guard runDaemon() would call
 * writeDaemonPid() unconditionally, clobber a live daemon's recorded PID, and
 * run a second JobScheduler concurrently, so every cron routine fires twice.
 *
 * Returns true and records our PID when no other live daemon owns the pid file;
 * returns false when a live daemon already holds it (the caller must exit
 * without touching any further state). The read-decide-write is serialized
 * behind the same O_EXCL start lock startDaemon() uses, so two _run processes
 * can't both claim in the window between the liveness check and the write.
 */
export function claimDaemonInstance(): boolean {
  const release = acquireStartLock();
  try {
    const existing = readDaemonPid();
    if (existing !== null && existing !== process.pid && isAlive(existing)) {
      return false; // another live daemon already owns the pid file
    }
    writeDaemonPid(process.pid);
    return true;
  } finally {
    release?.();
  }
}

/**
 * Reap stray duplicate daemon processes — a `daemon _run` of THIS install that
 * isn't this process and isn't the pid-file owner. Mirrors the browser orphan
 * reaper (below): a predecessor that was SIGKILLed/OOM-ed without cleaning up,
 * or a duplicate that lost the pid-file write race, would otherwise keep a
 * second scheduler alive and double-fire jobs even after claimDaemonInstance()
 * hands the pid file to the survivor.
 *
 * Scoped to our own launch entry (process.argv[1]) so it only ever targets
 * daemons of the same installation — a daemon from a different install / home
 * (e.g. a side-by-side dev build, or a test fixture) is a legitimately separate
 * instance and is left untouched. POSIX-only (uses `ps`); a no-op on Windows.
 */
export function reapStrayDaemons(keepPid: number = process.pid): { reaped: number; details: string[] } {
  const details: string[] = [];
  let reaped = 0;
  if (process.platform === 'win32') return { reaped, details };

  const selfEntry = process.argv[1];
  if (!selfEntry) return { reaped, details };

  let out: string;
  try {
    out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return { reaped, details }; // no `ps` — best effort
  }

  const ownerPid = readDaemonPid();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const args = m[2];
    if (isNaN(pid) || pid === keepPid || pid === process.pid || pid === ownerPid) continue;
    // Same install (same launch entry) AND a `daemon _run` command line.
    if (!args.includes(selfEntry)) continue;
    if (!/\bdaemon\b.*\b_run\b/.test(args)) continue;
    try {
      process.kill(pid, 'SIGTERM');
      reaped++;
      details.push(`reaped stray daemon pid ${pid}`);
    } catch { /* already gone */ }
  }
  return { reaped, details };
}

function rotateLogsIfNeeded(logPath: string): void {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size < LOG_MAX_SIZE) return;
    for (let i = LOG_ROTATE_COUNT - 1; i >= 1; i--) {
      const older = `${logPath}.${i}`;
      const newer = i === 1 ? logPath : `${logPath}.${i - 1}`;
      if (fs.existsSync(newer)) fs.renameSync(newer, older);
    }
    if (fs.existsSync(logPath)) fs.renameSync(logPath, `${logPath}.1`);
  } catch {}
}

/** Append a JSONL log entry to the daemon log file (owner-only permissions). */
export function log(level: string, message: string): void {
  const logPath = getLogPath();
  rotateLogsIfNeeded(logPath);
  const entry = { ts: new Date().toISOString(), level: level.toUpperCase(), message: redactSecrets(message) };
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
  try { fs.chmodSync(logPath, 0o600); } catch { /* best effort */ }
}

/** Main daemon loop: load jobs, schedule crons, monitor runs, and handle signals. */
export async function runDaemon(): Promise<void> {
  // Single-instance guard: a direct `agents daemon _run` (manual, or a
  // service-manager restart racing a live predecessor) must not clobber a
  // running daemon's pid file and start a second scheduler.
  if (!claimDaemonInstance()) {
    const owner = readDaemonPid();
    log('WARN', `Another daemon already owns the pid file (PID: ${owner}); this instance (PID ${process.pid}) is exiting`);
    // Exit cleanly (0) so a service manager treats it as an orderly no-op
    // rather than a failure to restart-flap on.
    process.exit(0);
  }
  log('INFO', `Daemon started (PID: ${process.pid})`);

  // RUSH-1759: the launchd plist / systemd unit no longer bake the Claude OAuth
  // token onto disk. Obtain it here from the secure `claude` secrets bundle and
  // inject into this process's env so every routine run this daemon spawns still
  // receives it (via the sandbox allowlist), without the token ever being
  // persisted in the service manifest. A read from a file-backed store (Linux)
  // needs no prompt; on macOS it resolves broker-only from an unlocked
  // secrets-agent and is otherwise absent (leaving the daemon on its existing
  // interactive OAuth session), matching the detached-start path. Never blocks.
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    const oauthToken = readDaemonClaudeOAuthToken();
    if (oauthToken) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
      log('INFO', 'Loaded Claude OAuth token from secrets bundle for routine runs');
    }
  }

  // Reap any stray duplicate daemon of this install that slipped past the start
  // lock or was orphaned by a hard-crash — before it can double-fire jobs.
  try {
    const strays = reapStrayDaemons();
    if (strays.reaped > 0) {
      log('WARN', `Reaped ${strays.reaped} stray daemon process(es)`);
      for (const d of strays.details) log('WARN', `  ${d}`);
    }
  } catch (err) {
    log('ERROR', `Stray daemon reaper failed: ${(err as Error).message}`);
  }

  // #416: host the secrets broker socket-first — before the scheduler and the
  // heavy browser/session-sync services — so `agents secrets` resolves within
  // ms of daemon start. Only host when no broker is already reachable, so we
  // never orphan a live standalone broker's clients (that broker stays the
  // server until it idle-exits or the daemon restarts). Best-effort: a failure
  // here must not stop the daemon. Retiring the standalone launchd service is
  // the follow-on (#416 step 2 / #417).
  let hostedBroker: { close(): void } | null = null;
  try {
    const { agentPing, startHostedBroker } = await import('./secrets/agent.js');
    if ((await agentPing()).reachable) {
      log('INFO', 'Secrets broker already running (standalone); daemon not hosting it');
    } else {
      hostedBroker = await startHostedBroker();
      if (hostedBroker) log('INFO', 'Secrets broker hosted in daemon (socket-first)');
    }
  } catch (err) {
    log('WARN', `Secrets broker host skipped: ${(err as Error).message}`);
  }

  const scheduler = new JobScheduler(async (config) => {
    const jobLabel = config.command
      ? 'command'
      : config.workflow
        ? `workflow: ${config.workflow}`
        : `agent: ${config.agent}`;
    log('INFO', `Triggering job '${config.name}' (${jobLabel})`);
    try {
      const meta = await executeJobDetached(config);
      log('INFO', `Job '${config.name}' spawned (run: ${meta.runId}, PID: ${meta.pid})`);
    } catch (err) {
      log('ERROR', `Job '${config.name}' failed to spawn: ${(err as Error).message}`);
    }
  });

  scheduler.loadAll();
  const scheduled = scheduler.listScheduled();
  log('INFO', `Loaded ${scheduled.length} jobs`);
  for (const job of scheduled) {
    log('INFO', `  ${job.name} -> next: ${job.nextRun?.toISOString() || 'unknown'}`);
  }

  // Monitor engine: event-triggered watchers, beside the cron scheduler. Same
  // daemon, same dispatch seam — a monitor is a routine whose trigger is a
  // watched source instead of a clock. Reloads on SIGHUP alongside the scheduler.
  const monitorEngine = new MonitorEngine((level, message) => log(level, message));
  try {
    monitorEngine.start();
  } catch (err) {
    log('ERROR', `Monitor engine failed to start: ${(err as Error).message}`);
  }

  // Backlog detection: any enabled recurring job whose most-recent expected
  // fire is older than its most-recent recorded run is overdue. Happens when
  // the laptop was off or the daemon crashed through a scheduled fire.
  // We log it and pop a native notification — the user can review with
  // `agents routines list` and run them with `agents routines catchup`.
  try {
    const overdue = detectOverdueJobs();
    if (overdue.length > 0) {
      log('WARN', `${overdue.length} routine(s) overdue:`);
      for (const job of overdue) {
        const last = job.lastRanAt ? job.lastRanAt.toISOString() : 'never';
        log('WARN', `  ${job.name} -- expected ${job.expectedAt.toISOString()}, last ran ${last}`);
      }
      notifyOverdue(overdue);
    }
  } catch (err) {
    log('ERROR', `Overdue detection failed: ${(err as Error).message}`);
  }

  // Before the BrowserService comes up, reap browser + tunnel processes
  // spawned by previous daemons that are no longer alive. Without this,
  // a daemon hard-crash (SIGKILL, OOM) would leak every browser and SSH
  // tunnel it had open — and the next session would either hijack those
  // (cdp:// profile silently driven via stale ssh tunnel) or fail to
  // bind because the ports are still claimed.
  try {
    const { reapOrphanedProcesses } = await import('./browser/runtime-state.js');
    const result = reapOrphanedProcesses();
    if (result.reaped > 0) {
      log('INFO', `Reaped ${result.reaped} orphan process(es) from prior daemon(s)`);
      for (const d of result.details) log('INFO', `  ${d}`);
    }
  } catch (err) {
    log('ERROR', `Orphan reaper failed: ${(err as Error).message}`);
  }

  const browserService = new BrowserService();
  const browserIPC = new BrowserIPCServer(browserService);
  try {
    await browserIPC.start();
    log('INFO', 'Browser IPC server started');
  } catch (err) {
    log('ERROR', `Browser IPC failed to start: ${(err as Error).message}`);
  }

  writeHeartbeat();
  const monitorInterval = setInterval(() => {
    writeHeartbeat();
    monitorRunningJobs();
  }, MONITOR_TICK_MS);

  // Cross-machine session sync: push this machine's transcripts to R2 and pull
  // every other machine's, ~every 90s. Skipped silently when the r2.backups
  // bundle is absent. An overlap guard prevents a slow cycle from stacking.
  let syncing = false;
  const runSessionSync = async () => {
    if (syncing) return;
    syncing = true;
    try {
      const { isBetaEnabled } = await import('./beta.js');
      // Off by default: session sync is an opt-in beta feature. Check the beta
      // flag FIRST so a machine that hasn't opted in skips the keychain read
      // (isSyncConfigured) entirely, not just the network cycle.
      if (!isBetaEnabled('session-sync')) return;
      const { isSyncConfigured } = await import('./session/sync/config.js');
      if (!isSyncConfigured()) return;
      const { syncSessions } = await import('./session/sync/sync.js');
      const r = await syncSessions();
      if (r.pushed || r.pulled || r.errors.length) {
        log('INFO', `sessions sync: pushed ${r.pushed}, pulled ${r.pulled}, merged ${r.merged}` +
          (r.errors.length ? `, ${r.errors.length} error(s): ${r.errors[0]}` : ''));
      }
      if (r.warnings.length) log('WARN', `sessions sync: ${r.warnings[0]}`);
    } catch (err) {
      log('ERROR', `sessions sync failed: ${(err as Error).message}`);
    } finally {
      syncing = false;
    }
  };
  const syncInterval = setInterval(() => { void runSessionSync(); }, 90_000);
  void runSessionSync(); // kick once at startup

  // Resource safety check: heal gaps between what DotAgents repos define and
  // what's actually installed in each agent home — the slow rot that nothing
  // else catches (a non-default version left stale, a Claude-invalid plugin
  // manifest silently rejecting a whole plugin). Conservative 'safe' mode: it
  // fills missing resources, repairs invalid manifests, and fast-forwards
  // provably-unmodified stale plugins, but never overwrites hand-edited content
  // or a plugin it can't prove is pristine — those it reports for `doctor --fix`.
  // Runs ~every 6h plus once ~30s after startup (staggered so launch isn't busy).
  let healing = false;
  const runHealCheck = async () => {
    if (healing) return;
    healing = true;
    try {
      const { runSelfHeal, selfHealChangedAnything, selfHealNeedsAttention, summarizeSelfHeal } =
        await import('./self-heal/registry.js');
      // Background heal is conservative (mode: 'safe'): fixes low-risk drift (shims,
      // symlink adoption, PATH, missing resources) and only reports risky ones. The
      // 30s kickoff means shims/PATH settle shortly after the daemon starts. No
      // desktop toast here — background heal is silent by design; the log is the record.
      const report = await runSelfHeal({ mode: 'safe' });
      if (selfHealChangedAnything(report) || selfHealNeedsAttention(report)) {
        log('INFO', `self-heal: ${summarizeSelfHeal(report)}`);
      }
    } catch (err) {
      log('ERROR', `self-heal check failed: ${(err as Error).message}`);
    } finally {
      healing = false;
    }
  };
  const healInterval = setInterval(() => { void runHealCheck(); }, 6 * 60 * 60_000);
  const healKickoff = setTimeout(() => { void runHealCheck(); }, 30_000);

  // Auto-dispatch: for any managed project that has opted in (autoDispatch:true +
  // maxAgents>0 in ~/.agents/factory/projects.json), pick up Linear tickets that
  // are delegated to an agent and still in Todo, and DISPATCH each through
  // agents-cli's own cloud-provider layer (resolveProvider().dispatch(), same as
  // `agents cloud run`) — then mark it Doing so it isn't re-picked. Capped at
  // maxAgents concurrent per project. No hidden Prix dependency: Rush is one
  // provider among rush/codex/factory, pinned per-project via `provider`. OFF
  // unless a project opts in; no opted-in project or no LINEAR_API_KEY is a clean
  // no-op. Overlap-guarded like the probes above. ~every 3 min.
  let autoDispatching = false;
  const runAutoDispatch = async () => {
    if (autoDispatching) return;
    autoDispatching = true;
    try {
      const { readAutoDispatchProjects, isEligible, autoDispatchTick } = await import('./auto-dispatch.js');
      const projects = readAutoDispatchProjects();
      if (!projects.some(isEligible)) return; // opt-in: nothing enabled → skip
      const { createLinearGateway } = await import('./auto-dispatch-linear.js');
      const linear = createLinearGateway();
      if (!linear) return; // no LINEAR_API_KEY configured → skip
      const { createProviderDispatcher } = await import('./auto-dispatch-provider.js');
      const dispatcher = createProviderDispatcher();
      const dispatched = await autoDispatchTick({ projects, linear, dispatcher, log: (lvl, m) => log(lvl, m) });
      if (dispatched.length) {
        log('INFO', `auto-dispatch: started ${dispatched.length} delegated ticket(s): ${dispatched.map((d) => d.identifier).join(', ')}`);
      }
    } catch (err) {
      log('ERROR', `auto-dispatch failed: ${(err as Error).message}`);
    } finally {
      autoDispatching = false;
    }
  };
  const autoDispatchInterval = setInterval(() => { void runAutoDispatch(); }, 3 * 60_000);
  const autoDispatchKickoff = setTimeout(() => { void runAutoDispatch(); }, 45_000);

  // Device probe: refresh registered devices' reachability and detect newly
  // appeared tailnet nodes, dropping a sentinel per pending device so the
  // menu-bar helper can surface "NEW DEVICES → Register / Ignore". Refresh mode
  // never auto-registers a newcomer. Soft + overlap-guarded like session sync;
  // a machine without tailscale is a clean no-op. ~every 3 min.
  let probingDevices = false;
  const runDeviceProbe = async () => {
    if (probingDevices) return;
    probingDevices = true;
    try {
      const { runDeviceSync } = await import('./devices/sync.js');
      const { reconcilePendingSentinels } = await import('./devices/pending.js');
      const dev = await runDeviceSync({ soft: true, mode: 'refresh' });
      if (dev.ok) {
        reconcilePendingSentinels(dev.pending);
        if (dev.pending.length) {
          log('INFO', `devices: ${dev.pending.length} new pending (${dev.pending.map((p) => p.name).join(', ')})`);
        }
      }
    } catch (err) {
      log('ERROR', `device probe failed: ${(err as Error).message}`);
    } finally {
      probingDevices = false;
    }
  };
  const deviceProbeInterval = setInterval(() => { void runDeviceProbe(); }, 3 * 60_000);
  const deviceProbeKickoff = setTimeout(() => { void runDeviceProbe(); }, 15_000);

  // tmux hook reconcile: retrofit the guarded `pane-died` hook onto managed
  // `agents run` sessions a pre-fix binary left with the old unconditional hook
  // (which detached the whole client — kicking the user out of the view — when
  // they exited a split they'd opened). Non-destructive: set-hook only, never a
  // kill or detach. A per-session schema marker makes steady-state a no-op, so
  // this stays cheap at ~every 5 min, plus once ~20s after startup so a
  // just-upgraded daemon heals still-running sessions without waiting for them to
  // cycle or the shared server to be recycled.
  let reconcilingTmux = false;
  const runTmuxReconcile = async () => {
    if (reconcilingTmux) return;
    reconcilingTmux = true;
    try {
      const { isTmuxInstalled } = await import('./tmux/binary.js');
      if (!isTmuxInstalled()) return;
      const { reconcileSessionHooks } = await import('./tmux/session.js');
      const r = await reconcileSessionHooks();
      if (r.reconciled > 0) log('INFO', `tmux: retrofitted pane-died hook on ${r.reconciled} session(s)`);
    } catch (err) {
      log('ERROR', `tmux reconcile failed: ${(err as Error).message}`);
    } finally {
      reconcilingTmux = false;
    }
  };
  const tmuxReconcileInterval = setInterval(() => { void runTmuxReconcile(); }, 5 * 60_000);
  const tmuxReconcileKickoff = setTimeout(() => { void runTmuxReconcile(); }, 20_000);

  // Launch-health self-heal: probe that each agent's DEFAULT version actually
  // LAUNCHES (not just that its files exist), and repair a gutted install — the
  // JS wrapper present but its native binary renamed/missing (a vendor
  // auto-update that never landed its replacement, or a partially-extracted
  // tarball) — BEFORE the user's next `agents run` dies with a raw ENOENT. This
  // is the proactive companion to the run-time heal (ensureAgentRunnable), which
  // only fires once a run is already starting. Cheap steady-state: one
  // `--version` probe per default version; a clean reinstall runs only on a real
  // launch failure. ~every 6h, plus once ~90s after startup (staggered off launch).
  let checkingLaunchHealth = false;
  const runLaunchHealthCheck = async () => {
    if (checkingLaunchHealth) return;
    checkingLaunchHealth = true;
    try {
      const { healBrokenDefaultLaunches } = await import('./versions.js');
      const repaired = await healBrokenDefaultLaunches((m) => log('INFO', `launch-health: ${m}`));
      if (repaired.length) log('INFO', `launch-health: repaired ${repaired.join(', ')}`);
    } catch (err) {
      log('ERROR', `launch-health check failed: ${(err as Error).message}`);
    } finally {
      checkingLaunchHealth = false;
    }
  };
  const launchHealthInterval = setInterval(() => { void runLaunchHealthCheck(); }, 6 * 60 * 60_000);
  const launchHealthKickoff = setTimeout(() => { void runLaunchHealthCheck(); }, 90_000);

  const handleReload = () => {
    log('INFO', 'Reloading jobs (SIGHUP)');
    scheduler.reloadAll();
    const reloaded = scheduler.listScheduled();
    log('INFO', `Reloaded ${reloaded.length} jobs`);
    try {
      monitorEngine.reload();
    } catch (err) {
      log('ERROR', `Monitor engine reload failed: ${(err as Error).message}`);
    }
    // Drop the memoized R2 config so rotated/added sync credentials are re-read
    // on the next cycle instead of waiting for a restart.
    void import('./session/sync/config.js').then(m => m.clearR2ConfigCache());
  };

  const handleShutdown = async () => {
    log('INFO', 'Daemon shutting down');
    scheduler.stopAll();
    monitorEngine.stop();
    await browserIPC.stop();
    clearInterval(monitorInterval);
    clearInterval(syncInterval);
    clearInterval(healInterval);
    clearTimeout(healKickoff);
    clearInterval(autoDispatchInterval);
    clearTimeout(autoDispatchKickoff);
    clearInterval(deviceProbeInterval);
    clearTimeout(deviceProbeKickoff);
    clearInterval(tmuxReconcileInterval);
    clearTimeout(tmuxReconcileKickoff);
    clearInterval(launchHealthInterval);
    clearTimeout(launchHealthKickoff);
    hostedBroker?.close();
    removeDaemonPid();
    removeHeartbeat();
    process.exit(0);
  };

  process.on('SIGHUP', handleReload);
  process.on('SIGTERM', () => handleShutdown());
  process.on('SIGINT', () => handleShutdown());

  await new Promise(() => {});
}

/**
 * Read the long-lived Claude OAuth token (from `claude setup-token`) that the
 * user stored under the `claude` secrets bundle. Resolves the bundle the same
 * way `agents run --secrets` does. Interactive starts may prompt Keychain;
 * headless auto-starts are broker-only and return null unless the user already
 * unlocked the bundle in the secrets agent. That keeps a background browser
 * command from hanging on an unseen biometric prompt. Never throws: an absent
 * token leaves the daemon on its existing interactive OAuth session.
 */
export function readDaemonClaudeOAuthToken(
  opts: { allowPrompt?: boolean } = {},
): string | null {
  try {
    const allowPrompt = opts.allowPrompt ?? Boolean(process.stdin.isTTY);
    const { env } = readAndResolveBundleEnv(DAEMON_OAUTH_BUNDLE, {
      caller: 'daemon',
      agentOnly: !allowPrompt,
    });
    const token = (env[DAEMON_OAUTH_KEY] ?? '').trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** Escape a string for safe inclusion in an XML <string> node. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Write a launchd plist or systemd unit with owner-only permissions atomically.
 *
 * `writeFileSync`'s `mode` is honored only when the file is *created*, so we
 * unlink any pre-existing manifest first. That guarantees every write is a
 * fresh 0600 create — closing the TOCTOU window on new files AND re-locking a
 * stale world-readable manifest left by an older install — since these files
 * embed long-lived credentials.
 */
export function writeOwnerOnlyServiceManifest(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.rmSync(filePath, { force: true });
  fs.writeFileSync(filePath, content, { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Generate a macOS launchd plist for auto-starting the daemon.
 *
 * The plist never embeds the Claude OAuth token (RUSH-1759): a persisted service
 * manifest is a plaintext credential on disk even at 0600. The daemon instead
 * obtains the token at startup from the `claude` secrets bundle
 * (readDaemonClaudeOAuthToken, injected in runDaemon), so it stays in the
 * Keychain-backed secure store and never touches the unit file.
 */
export function generateLaunchdPlist(
  agentsBin: string = getAgentsBinPath(),
): string {
  const launch = getDaemonLaunch(agentsBin);
  const logPath = getLogPath();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
${[launch.command, ...launch.args].map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${daemonNodeBinDir()}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:${os.homedir()}/.bun/bin</string>
  </dict>
</dict>
</plist>`;
}

/** Quote one systemd ExecStart argument without delegating parsing to a shell. */
function systemdExecArg(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Generate a Linux systemd user unit for auto-starting the daemon.
 *
 * The unit never embeds the Claude OAuth token (RUSH-1759): a persisted service
 * manifest is a plaintext credential on disk even at 0600. The daemon instead
 * obtains the token at startup from the `claude` secrets bundle
 * (readDaemonClaudeOAuthToken, injected in runDaemon), so it stays in the secure
 * store and never touches the unit file.
 */
export function generateSystemdUnit(
  agentsBin: string = getAgentsBinPath(),
): string {
  const launch = getDaemonLaunch(agentsBin);
  const execStart = [launch.command, ...launch.args].map(systemdExecArg).join(' ');

  return `[Unit]
Description=Agents Daemon - Scheduled Job Runner
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=always
RestartSec=10
Environment=PATH=${daemonNodeBinDir()}:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target`;
}

// Binary-resolution helpers (getAgentsBinPath / isNodeScriptEntry / getCliLaunch)
// live in ./cli-entry.js — a leaf module the secrets broker also imports without
// forming a cycle. Re-exported so existing `from './daemon.js'` importers of
// getAgentsBinPath keep resolving.
export { getAgentsBinPath };

/**
 * Ask the service manager for the daemon's live PID. Used as a fallback when
 * the daemon hasn't yet written its pid file but launchd/systemd already report
 * it running — so a start never has to surface a null PID for a daemon that is
 * in fact up. Returns null when the service isn't running or the query fails.
 */
function readServiceManagerPid(platform: NodeJS.Platform = os.platform()): number | null {
  try {
    if (platform === 'linux') {
      const out = execFileSync('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', SYSTEMD_UNIT],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const pid = parseInt(out, 10);
      return !isNaN(pid) && pid > 0 ? pid : null;
    }
    if (platform === 'darwin') {
      const out = execFileSync('launchctl', ['list', PLIST_NAME],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.match(/"PID"\s*=\s*(\d+)/);
      if (m) {
        const pid = parseInt(m[1], 10);
        return pid > 0 ? pid : null;
      }
    }
  } catch { /* not running / manager unavailable */ }
  return null;
}

/** Start the daemon via launchd, systemd, or as a detached process. */
export function startDaemon(agentsBin?: string): { pid: number | null; method: string } {
  if (isDaemonRunning()) {
    const pid = readDaemonPid();
    return { pid, method: 'already-running' };
  }

  const releaseLock = acquireStartLock();
  if (!releaseLock) {
    // Another process is already starting the daemon
    const pid = waitForPid(3000);
    return { pid, method: 'already-starting' };
  }

  try {
    return startDaemonLocked(agentsBin ?? getAgentsBinPath());
  } finally {
    releaseLock();
  }
}

/**
 * Bring the always-on daemon up as a side effect of a background-adjacent
 * command (secrets unlock, browser start, ...), not only from `routines add`.
 *
 * Delegates to the single `startDaemon` entrypoint, so it honors the
 * single-instance start lock and is a no-op when a daemon is already running
 * (returns `already-running`). Best-effort: any failure is swallowed and null
 * returned, so ensuring the daemon can never break the foreground command that
 * happened to bring it up. See issue #415.
 */
export function ensureDaemonStarted(): { pid: number | null; method: string } | null {
  try {
    return startDaemon();
  } catch {
    return null;
  }
}

function startDaemonLocked(agentsBin: string): { pid: number | null; method: string } {
  const platform = os.platform();

  if (platform === 'darwin') {
    try {
      const plistPath = getLaunchdPlistPath();
      const plistDir = path.dirname(plistPath);
      if (!fs.existsSync(plistDir)) {
        fs.mkdirSync(plistDir, { recursive: true });
      }
      // The plist carries no credential (RUSH-1759 — the daemon reads the OAuth
      // token itself at startup); still create owner-only atomically to match the
      // detached path and keep the log/PATH surface owner-private.
      writeOwnerOnlyServiceManifest(plistPath, generateLaunchdPlist(agentsBin));

      try {
        execFileSync('launchctl', ['unload', plistPath], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch { /* not loaded, expected */ }
      // launchctl prints `Load failed:` and exits 0 when the label is in a
      // stuck state from a prior session — so a zero exit code isn't proof
      // of success. If no pid materializes within the window, give up on
      // launchd and fall through to a plain detached spawn.
      execFileSync('launchctl', ['load', plistPath], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      const pid = waitForPid(3000) ?? readServiceManagerPid();
      if (pid) return { pid, method: 'launchd' };
      // launchctl claimed success but nothing ran. Fall through.
    } catch {
      // load threw — fall through to detached spawn
    }
    return startDetached({ agentsBin });
  }

  if (platform === 'linux') {
    try {
      const unitPath = getSystemdUnitPath();
      const unitDir = path.dirname(unitPath);
      if (!fs.existsSync(unitDir)) {
        fs.mkdirSync(unitDir, { recursive: true });
      }
      // Carries no credential (RUSH-1759 — the daemon reads the OAuth token
      // itself at startup); owner-only to keep the PATH/log surface private.
      writeOwnerOnlyServiceManifest(unitPath, generateSystemdUnit(agentsBin));

      execFileSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf-8' });
      execFileSync('systemctl', ['--user', 'enable', SYSTEMD_UNIT], { encoding: 'utf-8' });
      execFileSync('systemctl', ['--user', 'start', SYSTEMD_UNIT], { encoding: 'utf-8' });

      const pid = waitForPid(3000) ?? readServiceManagerPid();
      if (pid) return { pid, method: 'systemd' };
      // systemctl returned success but no PID surfaced — fall through to a
      // plain detached spawn rather than reporting a null PID.
    } catch {
      // start threw — fall through to detached spawn
    }
    return startDetached({ agentsBin });
  }

  return startDetached({ agentsBin });
}

/**
 * Environment for the detached daemon fallback. The launchd/systemd paths
 * deliver the long-lived OAuth token via the service manifest's environment;
 * the detached path has no manifest, so inject it here. Read happens during an
 * interactive `routines start`, so a Keychain Touch ID prompt can be satisfied;
 * the daemon then passes it to every routine run it spawns. An already-set
 * value (e.g. inherited from launchd) is left untouched.
 */
export function buildDetachedDaemonEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  oauthToken: string | null = readDaemonClaudeOAuthToken(),
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
    if (oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  }
  return env;
}

/**
 * Resolve how to launch the daemon: `node <entry> daemon _run`, matching the
 * exact form that works under a direct `daemon _run`.
 *
 * We spawn the Node runtime (`process.execPath`) with the CLI entry as an
 * argument rather than executing the entry path directly. Executing the `.js`
 * path relies on its shebang on POSIX, and on Windows CreateProcess can't run a
 * `.js`/shim directly at all — it gets launched through a transient
 * console-owning wrapper (cmd.exe / the npm shim). When that wrapper exits it
 * closes its console, and the detached daemon sharing that console receives a
 * console-close event that trips its shutdown handler — the daemon comes up,
 * binds the browser IPC socket, then tears itself down ~36ms later (#556).
 * Going through `process.execPath` means a real PE/binary is spawned with
 * `detached: true` and no console, so nothing signals the daemon after launch.
 *
 * When the entry isn't a Node script (e.g. a native compiled launcher), run it
 * directly — it owns its own runtime resolution.
 */
export function getDaemonLaunch(agentsBin: string = getAgentsBinPath()): { command: string; args: string[] } {
  const { warnings } = validateDaemonBinary(agentsBin);
  for (const w of warnings) process.stderr.write(`[agents] ${w}\n`);
  return getCliLaunch(['daemon', '_run'], agentsBin);
}

/**
 * The directory of the Node runtime that generated this service manifest, kept
 * first on the daemon's PATH. Both the shim's shebang and any child routine
 * process then resolve the exact Node that installed the service — never an
 * ancient system node or a pruned nvm version. Replaces the old hardcoded
 * `~/.nvm/versions/node/v24.0.0/bin`, which went stale the moment that patch
 * release was upgraded away and bricked the daemon fleet-wide.
 */
function daemonNodeBinDir(): string {
  return path.dirname(process.execPath);
}

/**
 * Build the argv to relaunch the `agents` CLI with the given subcommand args.
 *
 * Resolves the real on-disk binary via getAgentsBinPath(), then dispatches: a
 * `.js` entry runs under node (`node <entry> …`), a native/compiled binary runs
 * directly (`<bin> …`).
 *
 * Callers MUST route self-spawns through this rather than hand-rolling
 * `[process.execPath, process.argv[1], …]`: under the compiled standalone binary
 * (#315) `process.argv[1]` is the bun virtual entry `/$bunfs/root/agents`, so the
 * hand-rolled form becomes `agents /$bunfs/root/agents …` → the CLI receives the
 * bunfs path as a subcommand and dies with "unknown command '/$bunfs/root/agents'".
 * getAgentsBinPath() resolves that virtual entry to the physical process.execPath.
 */
export function getAgentsInvocation(
  subArgs: string[],
  agentsBin: string = getAgentsBinPath(),
): { command: string; args: string[] } {
  return getCliLaunch(subArgs, agentsBin);
}

export function validateDaemonBinary(binPath: string): { warnings: string[] } {
  const warnings: string[] = [];
  if (BUN_VIRTUAL_ROOT.test(binPath)) {
    throw new Error(
      `Refusing to supervise daemon: resolved binary is a bun virtual path (${binPath}). ` +
      `Install agents globally (npm i -g @phnx-labs/agents-cli) and restart.`,
    );
  }
  if (/[/\\]\.agents[/\\]worktrees[/\\]/.test(binPath)) {
    warnings.push(
      `Warning: daemon binary is inside a git worktree (${binPath}). ` +
      `A worktree deletion will wedge the daemon. Use the globally installed binary instead.`,
    );
  }
  if (!fs.existsSync(binPath) && !/\.(c|m)?js$/.test(binPath)) {
    warnings.push(`Warning: daemon binary does not exist on disk (${binPath}).`);
  }
  return { warnings };
}

interface StartDetachedOptions {
  /** CLI entry to launch (defaults to the running binary). Injectable for tests. */
  agentsBin?: string;
  /** Log file the daemon's stdio is redirected to (defaults to the daemon log). */
  logPath?: string;
  /** Environment for the child (defaults to the OAuth-augmented detached env). */
  env?: NodeJS.ProcessEnv;
}

export function startDetached(opts: StartDetachedOptions = {}): { pid: number | null; method: string } {
  const agentsBin = opts.agentsBin ?? getAgentsBinPath();
  const logPath = opts.logPath ?? getLogPath();
  const logFd = fs.openSync(logPath, 'a');

  const { command, args } = getDaemonLaunch(agentsBin);
  // fdStdio: the log-file fds make windowsHide inert (libuv skips
  // CREATE_NO_WINDOW when a stdio fd is inherited), so on Windows the daemon
  // must DETACH to own no console — otherwise it shares the launcher's console
  // and a console-close event tears it down when the launcher exits (#556).
  const child = spawn(command, args, {
    stdio: ['ignore', logFd, logFd],
    ...backgroundSpawnOptions({ fdStdio: true }),
    env: opts.env ?? buildDetachedDaemonEnv(),
  });

  // A failed spawn (ENOENT/EACCES) emits 'error' asynchronously; without a
  // listener that would crash the parent as an unhandled EventEmitter error.
  // The synchronous `!child.pid` guard below is what reports the failure loudly.
  child.on('error', () => { /* reported synchronously via the pid guard below */ });

  child.unref();
  fs.closeSync(logFd);

  // `spawn` leaves `pid` undefined only when the process could not be created.
  // Returning null here (the old `child.pid || null`) let callers report
  // "PID: null" as if the daemon had started — a start with no PID is a failed
  // start, so fail loudly instead of manufacturing a phantom success.
  if (!child.pid) {
    throw new Error(`Failed to start daemon: spawning '${command}' produced no PID (binary missing or not executable?)`);
  }
  return { pid: child.pid, method: 'detached' };
}

function waitForPid(timeoutMs: number): number | null {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pid = readDaemonPid();
    if (pid) return pid;
    const waitUntil = Date.now() + 200;
    while (Date.now() < waitUntil) {}
  }
  return readDaemonPid();
}

/** Stop the daemon, unloading it from launchd/systemd if applicable. */
export function stopDaemon(): boolean {
  const platform = os.platform();

  if (platform === 'darwin') {
    const plistPath = getLaunchdPlistPath();
    if (fs.existsSync(plistPath)) {
      try {
        execFileSync('launchctl', ['unload', plistPath], { encoding: 'utf-8' });
        fs.unlinkSync(plistPath);
      } catch (err: any) {
        if (process.env.AGENTS_DEBUG) {
          console.error(`[debug] launchctl unload failed: ${err.message}`);
        }
      }
    }
  }

  if (platform === 'linux') {
    try {
      execFileSync('systemctl', ['--user', 'stop', SYSTEMD_UNIT], { encoding: 'utf-8' });
      execFileSync('systemctl', ['--user', 'disable', SYSTEMD_UNIT], { encoding: 'utf-8' });
    } catch (err: any) {
      if (process.env.AGENTS_DEBUG) {
        console.error(`[debug] systemctl stop failed: ${err.message}`);
      }
    }
    const unitPath = getSystemdUnitPath();
    if (fs.existsSync(unitPath)) {
      try { fs.unlinkSync(unitPath); } catch { /* unit file already removed */ }
    }
  }

  const pid = readDaemonPid();
  if (pid) {
    if (process.platform === 'win32') {
      // Windows has no graceful termination signal — terminate the daemon and
      // its job/browser child tree in one shot (taskkill /T), so stop doesn't
      // report success while children keep running.
      killTree(pid);
    } else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch { /* process already exited */ }

      // Escalate to a hard tree-kill if it ignored SIGTERM after the grace period.
      setTimeout(() => {
        if (isAlive(pid)) killTree(pid);
      }, 5000);
    }
  }

  removeDaemonPid();
  return true;
}

/** Get current daemon status including running state, PID, and enabled job count. */
export function getDaemonStatus(): {
  state: 'running' | 'wedged' | 'stopped';
  running: boolean;
  pid: number | null;
  jobCount: number;
  logPath: string;
  binaryPath: string | null;
  heartbeat: DaemonHeartbeat | null;
} {
  const running = isDaemonRunning();
  const wedged = running && isDaemonWedged();
  const pid = readDaemonPid();

  let jobCount = 0;
  try {
    jobCount = listAllJobs().filter((j) => j.enabled).length;
  } catch { /* job listing failed */ }

  let binaryPath: string | null = null;
  try {
    binaryPath = getAgentsBinPath();
  } catch { /* resolution failed */ }

  return {
    state: wedged ? 'wedged' : running ? 'running' : 'stopped',
    running,
    pid,
    jobCount,
    logPath: getLogPath(),
    binaryPath,
    heartbeat: readHeartbeat(),
  };
}

/** Read the daemon log, optionally limited to the last N lines. */
export function readDaemonLog(lines?: number): string {
  const logPath = getLogPath();
  if (!fs.existsSync(logPath)) return '(no log file)';

  const content = fs.readFileSync(logPath, 'utf-8');
  if (!lines) return content;

  const allLines = content.split('\n');
  return allLines.slice(-lines).join('\n');
}

/** Send SIGHUP to the daemon to trigger a job reload. */
export function signalDaemonReload(): boolean {
  const pid = readDaemonPid();
  if (!pid) return false;
  if (process.platform === 'win32') {
    // Windows has no SIGHUP, so signal-based live reload isn't available. Sending
    // it would throw; instead report "not reloaded" so callers tell the user to
    // restart the daemon to pick up job changes.
    return false;
  }
  try {
    process.kill(pid, 'SIGHUP');
    return true;
  } catch {
    return false;
  }
}
