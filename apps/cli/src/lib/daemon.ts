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
import { isAlive, killTree, backgroundSpawnOptions, waitForExit } from './platform/index.js';
import { listJobs as listAllJobs, type JobConfig } from './routines.js';
import { syncAllProjectRoutines } from './routines-project.js';
import { JobScheduler } from './scheduler.js';
import { MonitorEngine } from './monitors/engine.js';
import { executeJobDetached, monitorRunningJobs, listLiveRoutineChildren } from './runner.js';
import { detectOverdueJobs, notifyOverdue } from './overdue.js';
import { runCatchup } from './catchup.js';
import { notifyRoutineStart, notifyRoutineFinish, notifyRoutineStartFailed } from './routine-notify.js';
import { notifyOwnerRoutineFinish, notifyOwnerRoutineStartFailed } from './routine-notify-owner.js';
import { BrowserService } from './browser/service.js';
import { BrowserIPCServer, getSocketPath as getBrowserIpcSocketPath } from './browser/ipc.js';
import { secretsBrokerSocketPath, brokerPidAlive } from './secrets/agent.js';
import { redactSecrets } from './redact.js';
import { getAgentsBinPath, getCliLaunch, BUN_VIRTUAL_ROOT } from './cli-entry.js';
import { isSchedulerEnabled, assertSchedulerEnabled, isDaemonEnabled } from './device-config.js';
import { reapTerminalRoutineProcesses } from './routine-process-cleanup.js';
import { recordSubsystemOk, recordSubsystemError, readSubsystemHealth, SUBSYSTEM_SECRETS_BROKER, SUBSYSTEM_BROWSER_IPC, SUBSYSTEM_DAEMON_START } from './daemon-health.js';

const PID_FILE = 'daemon.pid';
const LIFETIME_FILE = 'daemon.lifetime';
const LOCK_FILE = 'daemon.lock';
const LOG_FILE = 'logs.jsonl';
const HEARTBEAT_FILE = 'heartbeat.json';
const LOG_MAX_SIZE = 5 * 1024 * 1024; // 5 MB
const LOG_ROTATE_COUNT = 3;
const PLIST_NAME = 'com.phnx-labs.agents-daemon';
const SYSTEMD_UNIT = 'agents-daemon.service';
const MONITOR_TICK_MS = 60_000;
/**
 * How often to re-scan for missed fires. Deliberately slower than the monitor
 * tick: detection walks a week of cron occurrences per routine
 * (`previousExpectedFire`), and a fire that was already missed is not urgent to
 * the second — five minutes bounds the cost while still recovering from a
 * wedge or an OS suspend the process survived.
 */
const CATCHUP_TICK_MS = 5 * 60_000;
const WEDGE_THRESHOLD_TICKS = 3;

/**
 * Crash-loop prevention (RUSH-2418). Three layers, because none of them alone
 * bounds a daemon that dies during startup:
 *
 * 1. **The OS supervisor paces the respawn.** `KeepAlive` with no
 *    `ThrottleInterval` lets launchd relaunch on its ~10s default, so a daemon
 *    that dies while booting is restarted six times a minute forever — the exact
 *    failure the menu-bar helper hit (`menubar/install-menubar.ts`: 38 orphaned
 *    `agents doctor` children, load average 490). systemd's `Restart=always`
 *    with no `StartLimit*` is the same uncapped loop.
 * 2. **`StartLimitBurst` gives systemd a real cap** — after this many starts
 *    inside the interval the unit is put in `failed` and stops respawning, so a
 *    genuinely broken install stops burning the box and `systemctl --user status`
 *    names it. launchd has no burst equivalent; the throttle is its whole answer.
 * 3. **The application-level circuit breaker** below stops *auto*-starts from
 *    re-entering the loop from the other direction — a foreground command that
 *    calls `ensureDaemonStarted()` on every invocation.
 */
const DAEMON_THROTTLE_SECONDS = 30;
const DAEMON_START_LIMIT_INTERVAL_SECONDS = 300;
const DAEMON_START_LIMIT_BURST = 5;

/**
 * How many consecutive failed daemon starts disable the *implicit* auto-start
 * (`ensureDaemonStarted`). Matches `DAEMON_START_LIMIT_BURST` so the two layers
 * give up together rather than one silently masking the other. `agents daemon
 * start` is the deliberate override and is never gated by this.
 */
export const DAEMON_AUTOSTART_FAILURE_LIMIT = 5;

/**
 * RUSH-1817: decide whether the daemon should (re)take over hosting the secrets
 * broker. The startup host decision is one-shot; this drives the periodic
 * self-heal re-check. Take over ONLY when the daemon is not already hosting AND
 * no healthy broker answers a ping — i.e. a standalone the daemon deferred to at
 * start has since died or crash-looped. Never take over while our in-process
 * broker is hosting, and never clobber a reachable (healthy) broker.
 */
export function shouldTakeOverBroker(isHosting: boolean, brokerReachable: boolean): boolean {
  return !isHosting && !brokerReachable;
}

/**
 * What a gate re-evaluation must do with the routines scheduler. The daemon
 * re-evaluates `scheduler.enabled` on every SIGHUP reload so flipping the key
 * takes effect without a daemon restart (and `routines add`'s reload signal on
 * a re-enabled box boots the scheduler — the reload is truthful, not a no-op).
 *
 *   running + enabled   → reload (the normal SIGHUP path)
 *   running + !enabled  → stop  (gate flipped off since boot)
 *   !running + enabled  → boot  (gate flipped on since boot)
 *   !running + !enabled → none  (stay dark)
 */
export type SchedulerGateTransition = 'reload' | 'stop' | 'boot' | 'none';

export function schedulerGateTransition(running: boolean, enabled: boolean): SchedulerGateTransition {
  if (running) return enabled ? 'reload' : 'stop';
  return enabled ? 'boot' : 'none';
}

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

/**
 * A heartbeat is "fresh" when its last tick falls inside the wedge window — the
 * same threshold isDaemonWedged() uses to decide a still-present daemon has gone
 * unresponsive. A fresh heartbeat whose pid is alive is proof of a live, ticking
 * daemon even when the pid file has been lost.
 */
function isHeartbeatFresh(hb: DaemonHeartbeat): boolean {
  const elapsed = Date.now() - Date.parse(hb.lastTick);
  return elapsed <= WEDGE_THRESHOLD_TICKS * MONITOR_TICK_MS;
}

export function isDaemonWedged(): boolean {
  const pid = readDaemonPid();
  if (!pid) return false;
  if (!isAlive(pid)) return false;
  const hb = readHeartbeat();
  if (!hb) return false;
  if (hb.pid !== pid) return false;
  return !isHeartbeatFresh(hb);
}

/** How long stopDaemon waits for a SIGTERMed daemon to exit before escalating. */
const STOP_GRACE_MS = 5000;
/** How long it waits after the hard tree-kill before giving up. */
const STOP_KILL_GRACE_MS = 2000;

/**
 * Resolve the PID of the live daemon, tolerant of a pid-file/heartbeat desync.
 *
 * The daemon writes the pid file once (on claim/start) but rewrites the
 * heartbeat every tick. If the pid file is lost while the daemon keeps ticking
 * — e.g. an earlier isDaemonRunning() found a stale/reused/dead pid and cleared
 * the file, or it was removed out from under a live daemon — the pid file reads
 * empty even though a daemon is genuinely alive and firing jobs. Reading only
 * the pid file then reports "stopped" for a running scheduler, and (worse) lets
 * claimDaemonInstance() start a SECOND daemon that double-fires every routine.
 *
 * So: trust the pid file when its pid is alive; otherwise trust a FRESH
 * heartbeat whose pid is alive, and re-adopt the pid file so the desync heals.
 * Returns null only when neither points at a live process (clearing a stale pid
 * file on the way out).
 */
function resolveLiveDaemonPid(): number | null {
  const pid = readDaemonPid();
  if (pid !== null && isAlive(pid)) return pid;
  const hb = readHeartbeat();
  if (hb && isAlive(hb.pid) && isHeartbeatFresh(hb)) {
    if (pid !== hb.pid) writeDaemonPid(hb.pid); // heal the pid-file/heartbeat desync
    return hb.pid;
  }
  if (pid !== null) removeDaemonPid();
  return null;
}

/**
 * Check whether a daemon is alive — via the pid file, or a fresh heartbeat when
 * the pid file has been lost (see resolveLiveDaemonPid). Heals the pid file as a
 * side effect so a subsequent read is consistent.
 */
export function isDaemonRunning(): boolean {
  return resolveLiveDaemonPid() !== null;
}

/**
 * Single-instance claim for the daemon foreground entrypoint.
 *
 * `agents __daemon-run` is reachable directly — a manual invocation, or a
 * service-manager restart that races a still-alive predecessor — bypassing the
 * start lock in startDaemon(). Without this guard runDaemon() would call
 * writeDaemonPid() unconditionally, clobber a live daemon's recorded PID, and
 * run a second JobScheduler concurrently, so every cron routine fires twice.
 *
 * LAST-WINS takeover (SING-11, RUSH-2352): when a live daemon already owns the
 * pid file, this does NOT defer to it — it evicts the incumbent and becomes the
 * survivor, so a second install can never leave two daemons running. Returns true
 * and records our PID once the incumbent is provably dead (its resources
 * released). Returns false ONLY when another `__daemon-run` currently holds the
 * O_EXCL start lock — i.e. a concurrent claimer is mid-takeover and will be the
 * singleton — in which case the caller must exit without touching further state.
 * The read-evict-write is serialized behind the same start lock startDaemon()
 * uses, so two `_run` processes can't both claim in the window between the
 * liveness check and the write.
 */
export function claimDaemonInstance(): boolean {
  const release = acquireStartLock();
  // acquireStartLock() returns null only when another __daemon-run currently
  // holds the O_EXCL lock — a dead holder's lock is reclaimed and retried inside
  // acquireStartLock, so null means a *live* claimer is mid-claim. Bail rather
  // than run the read-evict-write unlocked: otherwise two first-start processes
  // could each see no pid file (before either writes one) and both claim,
  // running the concurrent JobScheduler this guard exists to prevent. The live
  // claimer we bailed for becomes the singleton, so last-wins still holds.
  if (!release) return false;
  try {
    // resolveLiveDaemonPid() also consults a fresh heartbeat, so a live daemon
    // whose pid file was lost is still found and evicted — otherwise a missing
    // pid file would let both this instance AND the orphaned incumbent run a
    // JobScheduler at once and double-fire every routine.
    const existing = resolveLiveDaemonPid();
    if (existing !== null && existing !== process.pid) {
      // Evict, and WAIT for the incumbent to be provably dead — its graceful
      // handleShutdown releasing the browser IPC binding and the secrets broker
      // socket — before we write our pid and (later, in runDaemon) bind our own.
      // Binding before the release recreates the two-brokers-on-one-socket orphan
      // documented at stopDaemon below, so the pid file is not written until the
      // prior owner is gone.
      evictIncumbentDaemon(existing);
    }
    writeDaemonPid(process.pid);
    return true;
  } finally {
    release();
  }
}

/**
 * SIGTERM a live incumbent daemon and block until it is provably dead, so its
 * graceful handleShutdown has released the browser IPC binding and the secrets
 * broker socket BEFORE the newcomer binds anything of its own (SING-11). Escalates
 * to killTree after the grace window. Passes the POSITIVE pid so the kill reaches
 * only the incumbent daemon — never its detached routine children, which run in
 * their own process groups and must survive takeover (SING-11a); the new daemon
 * re-adopts them via monitorRunningJobs. Synchronous to match claimDaemonInstance's
 * read-evict-write, which runs under the O_EXCL start lock; mirrors stopDaemon's
 * grace-then-escalate shape and constants exactly, because the same
 * proof-of-release requirement applies.
 */
function evictIncumbentDaemon(pid: number): void {
  if (process.platform === 'win32') {
    // No graceful termination signal on Windows — take the incumbent down and
    // still wait for the kill to land before the caller binds anything (mirrors
    // stopDaemon's win32 branch).
    killTree(pid);
    waitForExit(pid, STOP_KILL_GRACE_MS);
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return; // already gone between resolveLiveDaemonPid() and here
  }
  if (waitForExit(pid, STOP_GRACE_MS)) return; // graceful release complete
  killTree(pid); // positive pid: SIGKILL reaches the daemon, not its job children
  waitForExit(pid, STOP_KILL_GRACE_MS);
}

/** Directory that registers every live daemon of THIS device (one per daemon dir). */
function getDaemonInstancesDir(): string {
  return path.join(getDaemonDirRoot(), 'instances');
}

/**
 * Record this daemon in the device's instance registry — a marker file named by
 * pid under `<daemonDir>/instances/`. The registry, not a process scan, is how
 * the reaper enumerates the device singleton: because the dir lives INSIDE the
 * daemon dir (`AGENTS_DAEMON_DIR` ?? `<HOME>/.agents/.cache/helpers/daemon`), every
 * daemon of one device — however it was launched — registers in the same place,
 * while a genuinely separate install/home or a test fixture registers under its
 * own daemon dir and is invisible here. This is what fixes the two-entry pile-up:
 * the compiled `dist/bin/agents` binary and the `node <shim>` JS entry have
 * different `process.argv[1]`, so the old launch-entry-scoped `ps` match never
 * reaped across them and duplicates accumulated (78 observed on one box), every
 * routine double-firing. Best-effort — the reaper self-heals a missing/stale
 * marker, and reading another process's ENV to key on the daemon dir directly is
 * not portable (hardened macOS hides it from `ps`), so identity rides the shared
 * on-disk registry instead. No-op on Windows (POSIX-only reaper).
 */
export function registerDaemonInstance(pid: number = process.pid): void {
  if (process.platform === 'win32') return;
  try {
    const dir = getDaemonInstancesDir();
    fs.mkdirSync(dir, { recursive: true });
    // The command line is stored for diagnostics; the filename (pid) is identity.
    fs.writeFileSync(path.join(dir, String(pid)), process.argv.slice(1).join(' '), 'utf-8');
  } catch { /* best effort — the reaper self-heals a missing marker */ }
}

/** Remove this daemon's registry marker on graceful shutdown. */
export function unregisterDaemonInstance(pid: number = process.pid): void {
  if (process.platform === 'win32') return;
  try { fs.rmSync(path.join(getDaemonInstancesDir(), String(pid)), { force: true }); } catch { /* ignore */ }
}

/**
 * Reap stray duplicate daemons of THIS device — every registrant in the instance
 * registry that is a live `agents __daemon-run` and is neither this process nor
 * the current pid-file owner. A predecessor SIGKILLed/OOM-ed without cleanup, or a
 * duplicate that lost the pid-file write race, would otherwise keep a second
 * scheduler alive and double-fire jobs even after claimDaemonInstance() hands the
 * pid file to the survivor. Also garbage-collects markers whose pid is dead or was
 * reused by an unrelated process. No-op on Windows (POSIX-only).
 */
export function reapStrayDaemons(keepPid: number = process.pid): { reaped: number; details: string[] } {
  const details: string[] = [];
  let reaped = 0;
  if (process.platform === 'win32') return { reaped, details };

  const dir = getDaemonInstancesDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { reaped, details }; // no registry yet — nothing to reap
  }

  const ownerPid = readDaemonPid();
  const dropMarker = (name: string): void => {
    try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* ignore */ }
  };

  for (const name of entries) {
    const pid = parseInt(name, 10);
    if (isNaN(pid) || String(pid) !== name) continue; // not a pid marker
    if (pid === keepPid || pid === process.pid || pid === ownerPid) continue;

    // Dead registrant → stale marker.
    if (!isAlive(pid)) { dropMarker(name); continue; }

    // Live pid, but guard against pid reuse: only a real `__daemon-run` is ours.
    // Process ARGS are readable cross-platform (unlike ENV on hardened macOS).
    if (!isDaemonRunProcess(pid)) { dropMarker(name); continue; }

    try {
      process.kill(pid, 'SIGTERM');
      reaped++;
      details.push(`reaped stray daemon pid ${pid}`);
    } catch { /* already gone between the alive check and the signal */ }
    dropMarker(name);
  }
  return { reaped, details };
}

/**
 * Whether `pid` is a live `agents __daemon-run` process. Reads the process's
 * command line (`ps -p <pid> -o command=`), which — unlike its environment — is
 * visible cross-platform, including on hardened macOS. Guards the reaper against
 * killing an unrelated process that reused a dead registrant's pid.
 */
function isDaemonRunProcess(pid: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /\b__daemon-run\b/.test(out);
  } catch {
    return false;
  }
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
/**
 * Anchor the daemon's working directory to a stable, always-present path.
 *
 * The daemon is long-lived and inherits whatever cwd it was launched from — often
 * a git worktree (e.g. a `.agents/worktrees/<slug>/` a session happened to be in).
 * When that directory is later removed (`git worktree remove`, `rm -rf`), the
 * daemon keeps the deleted inode as its cwd — a process cannot chdir out of a
 * deleted directory on its own — and every job it spawns inherits the dead cwd
 * (`spawnJobAttempt` and command runs pass no explicit `cwd`, so the child uses
 * the parent's). Bun then fails `getcwd()` during startup and every routine crashes
 * at 0 seconds with `ENOENT: Bun could not find a file` before the agent even runs.
 *
 * Re-anchoring to the home directory once, at daemon startup, makes the daemon
 * immune regardless of how it was launched (systemd unit, launchd, or a manual
 * `agents __daemon-run` from any directory). Returns the resolved cwd, or null if
 * anchoring failed (logged, non-fatal).
 */
export function anchorDaemonCwd(): string | null {
  const home = os.homedir();
  try {
    process.chdir(home);
    return home;
  } catch (err) {
    log('WARN', `Could not anchor daemon cwd to ${home}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Surface, at the daemon's OWN startup, that it was launched from an ephemeral
 * root that will wedge it if the directory is removed. This is the runtime
 * companion to the launch-time check in validateDaemonBinary (which only runs
 * when the daemon is *spawned* via getDaemonLaunch): a direct
 * `agents __daemon-run` from a temp or worktree build — e.g. a review/verify
 * checkout under /tmp — never passes through that path, so without this the
 * wedge risk stays invisible until jobs start ENOENT-ing on their dynamic
 * imports. Best-effort and non-fatal; the cwd is already handled by
 * anchorDaemonCwd, but a deleted module root can only be flagged, not repaired.
 *
 * `resolveBin` is injectable (defaults to getAgentsBinPath) so the wiring — the
 * predicate call, the WARN, and the non-fatal guard around a throwing resolver —
 * is testable. Returns the warning message it logged, or null when the launch
 * root is stable (or could not be resolved).
 */
export function warnEphemeralDaemonRoot(resolveBin: () => string = getAgentsBinPath): string | null {
  try {
    const bin = resolveBin();
    const ephemeralRoot = describeEphemeralDaemonRoot(bin);
    if (!ephemeralRoot) return null;
    const message =
      `Daemon launched from ${ephemeralRoot} (${bin}); if that directory is removed, ` +
      `every routine will fail with ENOENT on its module imports. Run the daemon from the ` +
      `globally installed binary instead (npm i -g @phnx-labs/agents-cli), then restart it.`;
    log('WARN', message);
    return message;
  } catch (err) {
    log('WARN', `Could not check daemon launch root: ${(err as Error).message}`);
    return null;
  }
}

export async function runDaemon(): Promise<void> {
  // Single-instance guard (last-wins, SING-11): a direct `agents __daemon-run`
  // (manual, or a service-manager restart racing a live predecessor) EVICTS the
  // incumbent and becomes the survivor. claimDaemonInstance returns false only
  // when a concurrent `__daemon-run` currently holds the start lock — that peer
  // is mid-takeover and will be the singleton, so this instance stands down.
  if (!claimDaemonInstance()) {
    log('WARN', `Another daemon is mid-takeover (holds the start lock); this instance (PID ${process.pid}) is exiting`);
    // Exit cleanly (0) so a service manager treats it as an orderly no-op
    // rather than a failure to restart-flap on.
    process.exit(0);
  }
  // Unlike the pid and heartbeat files, this marker is written exactly once
  // for this daemon lifetime. Status probes deliberately repair those other
  // files, so they cannot prove that the original state tree still exists.
  const lifetimePath = path.join(getDaemonDirRoot(), LIFETIME_FILE);
  const lifetimeToken = `${process.pid}:${Date.now()}`;
  fs.writeFileSync(lifetimePath, lifetimeToken, 'utf-8');
  // RUSH-2418: only a daemon that reached this point — claimed, and about to
  // serve — clears the auto-start failure streak. Recording success at launch
  // time instead would reset the breaker for a process that dies moments later,
  // which is precisely the crash loop it exists to stop.
  recordSubsystemOk(SUBSYSTEM_DAEMON_START);
  log('INFO', `Daemon started (PID: ${process.pid})`);

  anchorDaemonCwd();
  warnEphemeralDaemonRoot();

  // The daemon holds NO Claude credential of its own. Routine runs authenticate
  // exactly like an interactive `agents run`: through the per-account
  // CLAUDE_CONFIG_DIR login on this device (its own auto-refreshing
  // .credentials.json). Claude Code's interactive access token is short-lived but
  // refreshes itself per-device; a routine whose account login has gone dead is
  // skipped up front by the auth-health preflight (runner.ts) with a re-login
  // hint, rather than papered over by an injected fallback token.

  // Register this daemon in the device instance registry, then reap any stray
  // duplicate that slipped past the start lock or was orphaned by a hard-crash —
  // before it can double-fire jobs. Registration comes first so a racing peer's
  // reaper can see this pid, and so this reaper never mistakes itself for a stray.
  registerDaemonInstance();
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
  // heavy browser services — so `agents secrets` resolves within
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
    recordSubsystemOk(SUBSYSTEM_SECRETS_BROKER);
  } catch (err) {
    const message = (err as Error).message;
    log('WARN', `Secrets broker host skipped: ${message}`);
    recordSubsystemError(SUBSYSTEM_SECRETS_BROKER, message);
  }

  // scheduler.enabled=false in this machine's device doc means NO routines fire
  // here — the scheduler and its catchup recovery simply never start, while the
  // daemon keeps its other duties (secrets broker, browser IPC, session sync).
  // The refusal message is the same one the start surfaces
  // (`routines add` auto-start, manual `routines start`) raise. The gate is
  // re-evaluated on every SIGHUP reload (handleReload below) via
  // schedulerGateTransition, so flipping the key never needs a daemon restart.
  const schedulerEnabledAtBoot = isSchedulerEnabled();
  if (!schedulerEnabledAtBoot) {
    try {
      assertSchedulerEnabled();
    } catch (err) {
      log('WARN', (err as Error).message);
    }
  }

  const triggerJob = async (config: JobConfig, ctx?: { scheduledFor?: Date }) => {
    const jobLabel = config.command
      ? 'command'
      : config.workflow
        ? `workflow: ${config.workflow}`
        : `agent: ${config.agent}`;
    log('INFO', `Triggering job '${config.name}' (${jobLabel})`);
    // RUSH-2030: branded desktop notification on start (agent/workflow routines;
    // suppressed for command housekeeping). Finish/output is fired from the
    // onFinish hook below — executeJobDetached finalizes the run in-process, so
    // the monitor tick never sees the live transition. Never let a notification
    // failure break the trigger.
    try { notifyRoutineStart(config); } catch { /* best-effort */ }
    try {
      const meta = await executeJobDetached(config, {
        onFinish: (final) => {
          try { notifyRoutineFinish(final); } catch { /* best-effort */ }
          // RUSH-2288: a failed/timed-out routine also reaches the OWNER's phone
          // (in-process owner channel stack), not just the local desktop. Green
          // runs are silent — the builder returns early. Async + swallowed so a
          // delivery hiccup never blocks the finish path.
          void notifyOwnerRoutineFinish(final)
            .then((r) => {
              if (r.attempts.length && !r.delivered)
                log('WARN', `Owner failure-notify for '${config.name}' reached no channel (tried: ${r.attempts.map((a) => a.channel).join(', ')})`);
            })
            .catch(() => { /* best-effort */ });
        },
      }, { kind: 'schedule', scheduledFor: ctx?.scheduledFor });
      log('INFO', `Job '${config.name}' spawned (run: ${meta.runId}, PID: ${meta.pid})`);
    } catch (err) {
      const message = (err as Error).message;
      log('ERROR', `Job '${config.name}' failed to spawn: ${message}`);
      // RUSH-2030: the START ping already fired unconditionally above. A pre-spawn
      // failure produces no run record and thus no onFinish, so send a synthetic
      // "failed to start" finish here — otherwise the user is left with an orphaned
      // "Routine started" and never told it failed.
      try { notifyRoutineStartFailed(config, message); } catch { /* best-effort */ }
      // RUSH-2288: the pre-spawn failure (e.g. auth_failed) is exactly the one the
      // per-routine `agents notify` prompt can never send — its agent never ran —
      // so the daemon reaches the owner directly.
      void notifyOwnerRoutineStartFailed(config, message)
        .then((r) => {
          if (r.attempts.length && !r.delivered)
            log('WARN', `Owner start-failure notify for '${config.name}' reached no channel (tried: ${r.attempts.map((a) => a.channel).join(', ')})`);
        })
        .catch(() => { /* best-effort */ });
    }
  };

  let scheduler: JobScheduler | null = null;
  let catchupInterval: NodeJS.Timeout | undefined;
  // Catchup overlap guard. Declared up here (not beside catchupPass) because
  // bootScheduler() runs before catchupPass's textual position — a `let` down
  // there would still be in its TDZ at the first call and crash the daemon.
  let catchingUp = false;

  // Boot the scheduler + catchup recovery. Called at daemon start when the gate
  // allows, and again from handleReload when the gate flips on (function
  // declarations hoist — catchupPass below is in scope).
  function bootScheduler(): void {
    scheduler = new JobScheduler(triggerJob);
    scheduler.loadAll();
    const scheduled = scheduler.listScheduled();
    log('INFO', `Loaded ${scheduled.length} jobs`);
    for (const job of scheduled) {
      log('INFO', `  ${job.name} -> next: ${job.nextRun?.toISOString() || 'unknown'}`);
    }
    void catchupPass();
    catchupInterval = setInterval(() => { void catchupPass(); }, CATCHUP_TICK_MS);
  }

  // Stop the scheduler + catchup recovery (gate flipped off on reload).
  function stopScheduler(): void {
    scheduler?.stopAll();
    scheduler = null;
    if (catchupInterval !== undefined) {
      clearInterval(catchupInterval);
      catchupInterval = undefined;
    }
  }

  // Materialise opted-in project routines into the user layer on every start
  // so a fresh daemon picks up project YAML without a separate sync step.
  try {
    const result = syncAllProjectRoutines();
    const n = result.projects.reduce((acc, p) => acc + p.synced.length, 0);
    if (n > 0) log('INFO', `Project routines sync: ${n} job(s) from ${result.projects.length} project(s)`);
  } catch (err) {
    log('WARN', `Project routines sync failed: ${(err as Error).message}`);
  }

  if (schedulerEnabledAtBoot) bootScheduler();

  // watchdog, device-probe, tmux-reconcile, launch-health, fleet-cache-warm,
  // session-cache-warm, usage-refresh, and auto-dispatch used to be hardcoded
  // setInterval ticks here (RUSH-2353). They are now shipped system routines
  // (gh:phnx-labs/.agents-system routines/*.yml), invoked one-shot via
  // `agents __daemon-tick <name>` (see daemon-ticks.ts) and fired by the
  // JobScheduler above like any other routine — declared, listed, run-tracked,
  // pausable, and device-pinnable, instead of a second unowned scheduling path.

  // Monitor engine: event-triggered watchers, beside the cron scheduler. Same
  // daemon, same dispatch seam — a monitor is a routine whose trigger is a
  // watched source instead of a clock. Reloads on SIGHUP alongside the scheduler.
  const monitorEngine = new MonitorEngine((level, message) => log(level, message));
  try {
    monitorEngine.start();
  } catch (err) {
    log('ERROR', `Monitor engine failed to start: ${(err as Error).message}`);
  }

  // Backlog recovery: any enabled recurring job whose most-recent expected fire
  // is older than its most-recent recorded run was missed — the laptop slept,
  // the machine was off, or the daemon crashed through the fire. croner only
  // schedules forward from "now", so nothing replays it on its own.
  //
  // Every miss is RECORDED as a `missed` run and, unless the routine sets
  // `catchup: false`, RUN late. Runs on a timer as well as at startup: a startup
  // pass alone misses a fire lost while the daemon stayed up but its event loop
  // was wedged, or one lost across an OS suspend that the process survived.
  // Overlap guard, same shape as runHealCheck below. A pass
  // awaits executeJobDetached per job and an off-box (host/cloud) dispatch can
  // block for a while, so a slow pass could still be working when the next tick
  // fires. Both passes would then see a job the first has not yet reached as
  // overdue — the miss is recorded before the await, but only for jobs already
  // processed — and spawn it twice. The idempotency of the `missed` record
  // guards across passes, not within one that is mid-flight.
  // Function declaration (hoisted) so bootScheduler() can schedule it. Its
  // guard (`catchingUp`) is declared beside `scheduler` above for TDZ safety.
  async function catchupPass(): Promise<void> {
    if (catchingUp) return;
    catchingUp = true;
    try {
      const overdue = detectOverdueJobs();
      if (overdue.length === 0) return;
      log('WARN', `${overdue.length} routine(s) missed their fire:`);
      for (const job of overdue) {
        const last = job.lastRanAt ? job.lastRanAt.toISOString() : 'never';
        log('WARN', `  ${job.name} -- expected ${job.expectedAt.toISOString()}, last ran ${last}`);
      }
      notifyOverdue(overdue);
      const outcomes = await runCatchup({ overdue });
      for (const o of outcomes) {
        // Every variant handled explicitly: a catch-all else would log the
        // benign 'claimed-elsewhere' (another process legitimately won the
        // claim) as an ERROR with an undefined reason.
        switch (o.result) {
          case 'ran':
            log('INFO', `Caught up '${o.name}' (run: ${o.runId})`);
            break;
          case 'recorded':
            log('INFO', `Recorded missed fire for '${o.name}' (catchup disabled)`);
            break;
          case 'claimed-elsewhere':
            log('INFO', `Missed fire for '${o.name}' already claimed by another catchup`);
            break;
          case 'error':
            log('ERROR', `Catchup for '${o.name}' failed: ${o.error}`);
            break;
          default: {
            // Compile-time exhaustiveness: a new CatchupOutcome variant fails
            // typecheck here rather than silently landing in the wrong log level,
            // which is exactly how 'claimed-elsewhere' was first missed.
            const unhandled: never = o.result;
            log('ERROR', `Catchup for '${o.name}' returned an unhandled result: ${String(unhandled)}`);
          }
        }
      }
    } catch (err) {
      log('ERROR', `Catchup pass failed: ${(err as Error).message}`);
    } finally {
      // finally, not a tail assignment: the no-overdue path returns early, and a
      // throw must not leave the guard latched shut for the daemon's lifetime.
      catchingUp = false;
    }
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
    recordSubsystemOk(SUBSYSTEM_BROWSER_IPC);
  } catch (err) {
    const message = (err as Error).message;
    log('ERROR', `Browser IPC failed to start: ${message}`);
    recordSubsystemError(SUBSYSTEM_BROWSER_IPC, message);
  }

  writeHeartbeat();
  const monitorInterval = setInterval(() => {
    writeHeartbeat();
    monitorRunningJobs();
    const reaped = reapTerminalRoutineProcesses();
    if (reaped.length > 0) log('WARN', `Reaped ${reaped.length} terminal routine process group(s): ${reaped.join(', ')}`);
  }, MONITOR_TICK_MS);

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
    // The daemon's state directory is its liveness boundary. Once that tree is
    // removed, background maintenance must not recreate it while the
    // self-terminate guard is shutting the process down.
    if (!fs.existsSync(getDaemonDirRoot())) return;
    healing = true;
    try {
      const { runSelfHeal, selfHealChangedAnything, selfHealNeedsAttention, summarizeSelfHeal } =
        await import('./self-heal/registry.js');
      if (!fs.existsSync(getDaemonDirRoot())) return;
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

  // RUSH-1817: the startup host decision above is one-shot. If a standalone
  // broker answered agentPing() at daemon start, the daemon declined to host —
  // but should that standalone later die or crash-loop, nothing takes over and
  // every `agents secrets unlock|export|start` fails until a manual restart
  // (this wedged all keychain-backed secrets on zion and blocked a release).
  // Re-probe on a cadence: whenever the daemon is NOT itself hosting AND no
  // healthy broker answers a ping, take over hosting. startHostedBroker binds
  // the socket only when it is free, so a take-over never races a live broker.
  let selfHealingBroker = false;
  const runBrokerSelfHeal = async () => {
    if (selfHealingBroker) return;
    selfHealingBroker = true;
    try {
      const { agentPing, startHostedBroker } = await import('./secrets/agent.js');
      const reachable = (await agentPing()).reachable;
      if (!shouldTakeOverBroker(hostedBroker != null, reachable)) return;
      hostedBroker = await startHostedBroker();
      if (hostedBroker) {
        log('WARN', 'Secrets broker was unreachable; daemon took over hosting (self-heal)');
      }
    } catch (err) {
      log('WARN', `Secrets broker self-heal skipped: ${(err as Error).message}`);
    } finally {
      selfHealingBroker = false;
    }
  };
  const brokerSelfHealInterval = setInterval(() => { void runBrokerSelfHeal(); }, 60_000);

  // RUSH-2232: reap orphaned keychain helpers and `agents` processes stuck on a
  // keychain call. Runs as a 5-min interval in the daemon (the single executor)
  // so no UI surface can race it. The reaper shells `ps` once, plans kills in a
  // pure function, and executes via killTree.
  let reapingKeychain = false;
  const runKeychainReap = async () => {
    if (reapingKeychain) return;
    reapingKeychain = true;
    try {
      const { reapOrphanedKeychainProcesses } = await import('./secrets/reaper.js');
      const result = reapOrphanedKeychainProcesses();
      if (result.reaped > 0) {
        log('WARN', `Reaped ${result.reaped} keychain orphan/stuck process(es)`);
        for (const d of result.details) log('WARN', `  ${d}`);
      }
    } catch (err) {
      log('ERROR', `Keychain reaper failed: ${(err as Error).message}`);
    } finally {
      reapingKeychain = false;
    }
  };
  const keychainReapInterval = setInterval(() => { void runKeychainReap(); }, 5 * 60_000);

  // RUSH-2367: self-terminate if this daemon's own state dir has been removed
  // out from under it — the shape of a leaked test-fixture daemon whose /tmp
  // HOME was deleted by its test's own cleanup while the process itself
  // somehow survived (lost the SIGTERM/SIGKILL race, or outlived a killed
  // test runner before its `finally` ever ran). Nothing else can reach a
  // daemon in that state: no `agents daemon` command targets it, since a
  // different HOME resolves a different getDaemonDir() and therefore a
  // different instance registry — without this it runs forever. Reads
  // Reads the lifetime marker directly, never the local getDaemonDir() wrapper,
  // which recreates the directory as a side effect and would defeat the check.
  // Heartbeat/status paths may recreate the directory and pid file after a
  // deletion; they never recreate this per-lifetime token.
  let checkingStateDir = false;
  const runStateDirSelfCheck = (): void => {
    if (checkingStateDir) return;
    checkingStateDir = true;
    try {
      let markerMatches = false;
      try {
        markerMatches = fs.readFileSync(lifetimePath, 'utf-8') === lifetimeToken;
      } catch {
        // A missing state tree or marker is the condition this guard detects.
      }
      if (!markerMatches) {
        log('WARN', `Daemon state dir ${getDaemonDirRoot()} no longer exists; exiting (self-terminate guard)`);
        void handleShutdown();
      }
    } finally {
      checkingStateDir = false;
    }
  };
  const stateDirCheckMs = Number(process.env.AGENTS_DAEMON_STATE_DIR_CHECK_MS) || 60_000;
  const stateDirCheckInterval = setInterval(runStateDirSelfCheck, stateDirCheckMs);

  const handleReload = () => {
    log('INFO', 'Reloading jobs (SIGHUP)');
    // Refresh user-layer copies of opted-in project routines BEFORE the
    // scheduler reloads, so YAML edits under `<project>/.agents/routines/`
    // take effect on the next fire without a manual `routines sync`.
    try {
      const result = syncAllProjectRoutines();
      const n = result.projects.reduce((acc, p) => acc + p.synced.length, 0);
      if (n > 0 || result.missing.length > 0) {
        log('INFO', `Project routines sync: ${n} updated, ${result.missing.length} missing roots`);
      }
    } catch (err) {
      log('WARN', `Project routines sync failed: ${(err as Error).message}`);
    }
    // Re-evaluate the scheduler.enabled gate: flipping the key takes effect on
    // this reload, no daemon restart needed. A `routines add` on a re-enabled
    // box signals exactly this reload, which boots the scheduler — the
    // "Scheduler reloaded" it prints is then truthful, not a dead-end.
    const transition = schedulerGateTransition(scheduler !== null, isSchedulerEnabled());
    if (transition === 'boot') {
      log('INFO', 'scheduler.enabled is now on — booting the scheduler');
      bootScheduler();
    } else if (transition === 'stop') {
      log('WARN', 'scheduler.enabled is now off — stopping the scheduler; no routines will fire on this device');
      stopScheduler();
    } else if (transition === 'reload') {
      scheduler!.reloadAll();
      const reloaded = scheduler!.listScheduled();
      log('INFO', `Reloaded ${reloaded.length} jobs`);
    }
    try {
      monitorEngine.reload();
    } catch (err) {
      log('ERROR', `Monitor engine reload failed: ${(err as Error).message}`);
    }
  };

  const handleShutdown = async () => {
    log('INFO', 'Daemon shutting down');
    stopScheduler();
    monitorEngine.stop();
    await browserIPC.stop();
    clearInterval(monitorInterval);
    clearInterval(healInterval);
    clearTimeout(healKickoff);
    clearInterval(brokerSelfHealInterval);
    clearInterval(keychainReapInterval);
    clearInterval(stateDirCheckInterval);
    try {
      if (fs.readFileSync(lifetimePath, 'utf-8') === lifetimeToken) fs.unlinkSync(lifetimePath);
    } catch {
      // Already removed with the state tree, or replaced by a newer owner.
    }
    hostedBroker?.close();
    removeDaemonPid();
    removeHeartbeat();
    unregisterDaemonInstance();
    process.exit(0);
  };

  process.on('SIGHUP', handleReload);
  process.on('SIGTERM', () => handleShutdown());
  process.on('SIGINT', () => handleShutdown());

  await new Promise(() => {});
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
 * The plist never embeds a Claude OAuth token: the daemon holds no Claude
 * credential at all. Routine runs authenticate through the per-account
 * CLAUDE_CONFIG_DIR login on this device, exactly like an interactive
 * `agents run`, so no credential ever touches the service manifest.
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
  <key>ThrottleInterval</key>
  <integer>${DAEMON_THROTTLE_SECONDS}</integer>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${daemonPathValue(agentsBin, ['/usr/local/bin', '/usr/bin', '/bin', '/opt/homebrew/bin', `${os.homedir()}/.bun/bin`])}</string>
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
 * The unit never embeds a Claude OAuth token: the daemon holds no Claude
 * credential at all. Routine runs authenticate through the per-account
 * CLAUDE_CONFIG_DIR login on this device, exactly like an interactive
 * `agents run`, so no credential ever touches the unit file.
 */
export function generateSystemdUnit(
  agentsBin: string = getAgentsBinPath(),
): string {
  const launch = getDaemonLaunch(agentsBin);
  const execStart = [launch.command, ...launch.args].map(systemdExecArg).join(' ');

  return `[Unit]
Description=Agents Daemon - Scheduled Job Runner
After=network.target
StartLimitIntervalSec=${DAEMON_START_LIMIT_INTERVAL_SECONDS}
StartLimitBurst=${DAEMON_START_LIMIT_BURST}

[Service]
Type=simple
ExecStart=${execStart}
Restart=always
RestartSec=${DAEMON_THROTTLE_SECONDS}
Environment=PATH=${daemonPathValue(agentsBin, ['/usr/local/bin', '/usr/bin', '/bin'])}

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

  // Released by startDaemonLocked the moment the launch has been ISSUED, and
  // again here as the backstop for every path that returned before reaching
  // that point (a throw, or the platform default branch). Idempotent so the
  // double call is a no-op rather than unlinking a lock a later claimer owns.
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    releaseLock();
  };

  try {
    const result = startDaemonLocked(agentsBin ?? getAgentsBinPath(), releaseOnce);
    // RUSH-2418: record the start OUTCOME, not the attempt. A launch that
    // produced no pid is the crash-loop signal `ensureDaemonStarted` reads —
    // the daemon itself records the success side once it has claimed, so a
    // process that started and then died on boot never clears the streak.
    if (result.pid === null) {
      recordSubsystemError(SUBSYSTEM_DAEMON_START, `start via ${result.method} produced no daemon pid`);
    }
    return result;
  } catch (err: any) {
    recordSubsystemError(SUBSYSTEM_DAEMON_START, `start threw: ${err?.message ?? String(err)}`);
    throw err;
  } finally {
    releaseOnce();
  }
}

/**
 * Is the auto-start circuit breaker open (RUSH-2418)? True once
 * {@link DAEMON_AUTOSTART_FAILURE_LIMIT} consecutive starts have failed to
 * produce a live daemon. Pure read of the persisted health record, so `agents
 * daemon status`/`doctor` and the gate agree on one number.
 */
export function isDaemonAutostartCircuitOpen(): boolean {
  const health = readSubsystemHealth(SUBSYSTEM_DAEMON_START);
  return (health?.consecutiveFailures ?? 0) >= DAEMON_AUTOSTART_FAILURE_LIMIT;
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
  // RUSH-2354: honor daemon.enabled — a background-adjacent caller (secrets
  // unlock, browser start, ...) must not resurrect a daemon the owner
  // explicitly turned off. `agents daemon start` is the deliberate override
  // and calls startDaemon() directly instead of going through this helper.
  if (!isDaemonEnabled()) return null;
  // A live daemon is the answer whatever the failure history says — the breaker
  // gates LAUNCHING one, never reporting one that is already up. Checked first
  // so a stale failure streak can't make a healthy daemon read as absent to
  // callers that branch on this return (e.g. secrets/agent.ts).
  if (isDaemonRunning()) return startDaemon();
  // RUSH-2418: the auto-start circuit breaker. A daemon that dies during
  // startup would otherwise be relaunched by EVERY foreground command that
  // wants one (secrets unlock, browser start, watchdog, ...) — an
  // application-level crash loop the OS supervisor's throttle cannot see,
  // because each attempt is a fresh service start rather than a respawn. After
  // DAEMON_AUTOSTART_FAILURE_LIMIT consecutive failures, refuse and say why.
  // Deliberately NOT applied in startDaemon(): `agents daemon start` is the
  // operator's override and must always be able to retry.
  if (isDaemonAutostartCircuitOpen()) {
    process.stderr.write(
      `[agents] daemon auto-start disabled after ${DAEMON_AUTOSTART_FAILURE_LIMIT} consecutive failed starts. ` +
      `Run 'agents daemon doctor' to diagnose, or 'agents daemon start' to retry anyway.\n`,
    );
    return null;
  }
  try {
    return startDaemon();
  } catch {
    return null;
  }
}

/**
 * Issue the launch, then wait for the child to record its pid.
 *
 * RUSH-2417: the wait phase MUST NOT hold the start lock. `acquireStartLock`
 * and `claimDaemonInstance` resolve the same `<daemonDir>/daemon.lock`, so a
 * parent that busy-waits on `waitForPid` while still holding it deterministically
 * defeats the child it just launched: the child's `claimDaemonInstance` hits
 * EEXIST, reads a holder pid that IS alive (this process), and exits with the
 * false "another daemon is mid-takeover" warning — every launchd/systemd start
 * on a fresh install. The lock's job is to keep two concurrent `startDaemon()`
 * calls from both launching, and that is done once `launchctl load` /
 * `systemctl start` / the detached spawn has been issued, so `releaseLock()` is
 * called there rather than in the caller's `finally`.
 *
 * Releasing early cannot produce two daemons: launchd (one plist label) and
 * systemd (one unit) are singletons that no-op a second start, and the detached
 * path is covered by `claimDaemonInstance`'s last-wins takeover (SING-11) —
 * a second claimer evicts the incumbent rather than running beside it.
 */
function startDaemonLocked(agentsBin: string, releaseLock: () => void): { pid: number | null; method: string } {
  const platform = os.platform();
  // Same contract on the fallback path: the spawn IS the launch, so the lock is
  // dropped before the child exists rather than in a `finally` the child races.
  const detachedFallback = (): { pid: number | null; method: string } => {
    releaseLock();
    return startDetached({ agentsBin });
  };

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
      // Launch issued — the child needs this lock to claim (RUSH-2417).
      releaseLock();
      const pid = waitForPid(3000) ?? readServiceManagerPid();
      if (pid) return { pid, method: 'launchd' };
      // launchctl claimed success but nothing ran. Fall through.
    } catch {
      // load threw — fall through to detached spawn
    }
    return detachedFallback();
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

      // Launch issued — the child needs this lock to claim (RUSH-2417).
      releaseLock();
      const pid = waitForPid(3000) ?? readServiceManagerPid();
      if (pid) return { pid, method: 'systemd' };
      // systemctl returned success but no PID surfaced — fall through to a
      // plain detached spawn rather than reporting a null PID.
    } catch {
      // start threw — fall through to detached spawn
    }
    return detachedFallback();
  }

  return startDetached({ agentsBin });
}

/**
 * Resolve how to launch the daemon: `node <entry> __daemon-run`, matching the
 * exact form that works under a direct `__daemon-run`.
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
  return getCliLaunch(['__daemon-run'], agentsBin);
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
 * The full PATH value the daemon service manifest pins, in order: the Node runtime
 * dir (so the shim's shebang and any child resolve the exact installing Node — see
 * {@link daemonNodeBinDir}), then the directory of the `agents` shim itself, then
 * the platform's system dirs. The shim's own dir matters because a scheduled
 * `command` routine shells out to the bare name `agents`
 * (`/bin/sh -c 'agents watchdog --nudge'`): when the shim lives outside the Node
 * bin dir — a `~/.local/bin` global install, a separate npm prefix — a PATH
 * carrying only the Node dir resolves `agents` to nothing and every routine dies
 * with `exit 127`. Deduped across the whole list, so a Node/shim dir that already
 * appears among the system dirs (e.g. a `/usr/local/bin` install) never doubles.
 */
function daemonPathValue(agentsBin: string, systemDirs: readonly string[]): string {
  return [...new Set([daemonNodeBinDir(), path.dirname(agentsBin), ...systemDirs])].join(':');
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

/**
 * A daemon binary living under an ephemeral path — a git worktree, or a temp
 * directory (`/tmp`, `/var/folders`, `/dev/shm`) — is a latent wedge. The daemon
 * is long-lived but resolves its own job modules by dynamic `import()` rooted at
 * this entry (getAgentsBinPath → process.argv[1]). If that directory is later
 * removed (`git worktree remove`, a `/tmp` cleanup, a review/verify checkout
 * teardown) the running daemon keeps ENOENT-ing on every job it loads —
 * `anchorDaemonCwd` rescues the cwd, but nothing can re-root a deleted module
 * tree. Returns a human phrase naming the ephemeral kind, or null for a stable
 * install path (version home, a global npm prefix, a normal source checkout).
 */
export function describeEphemeralDaemonRoot(binPath: string): string | null {
  if (/[/\\]\.agents[/\\]worktrees[/\\]/.test(binPath)) return 'a git worktree';
  if (/^(?:\/private)?\/tmp[/\\]|^(?:\/private)?\/var\/folders[/\\]|^\/dev\/shm[/\\]/.test(binPath)) {
    return 'a temporary directory';
  }
  return null;
}

export function validateDaemonBinary(binPath: string): { warnings: string[] } {
  const warnings: string[] = [];
  if (BUN_VIRTUAL_ROOT.test(binPath)) {
    throw new Error(
      `Refusing to supervise daemon: resolved binary is a bun virtual path (${binPath}). ` +
      `Install agents globally (npm i -g @phnx-labs/agents-cli) and restart.`,
    );
  }
  const ephemeralRoot = describeEphemeralDaemonRoot(binPath);
  if (ephemeralRoot) {
    warnings.push(
      `Warning: daemon binary is inside ${ephemeralRoot} (${binPath}). ` +
      `Deleting it will wedge the daemon. Use the globally installed binary instead.`,
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
  /** Environment for the child (defaults to the daemon's current process env). */
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
    ...backgroundSpawnOptions({ cwd: os.homedir(), fdStdio: true }),
    env: opts.env ?? process.env,
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

/**
 * Structured outcome of {@link stopDaemon} (SING-12, RUSH-2355). `stopDaemon`
 * asserts its postcondition instead of assuming it: `ok` is true only when every
 * resource the daemon held is provably released. `surviving` names anything that
 * did not release (a still-live daemon, or a stale socket that could not be
 * cleared) and is what drives a non-zero exit; `detachedChildren` are the
 * in-flight routine children that survive deliberately (SING-11a) and are
 * reported, never killed.
 */
export interface DaemonStopResult {
  ok: boolean;
  stoppedPid: number | null;
  escalated: boolean;
  released: string[];
  surviving: string[];
  detachedChildren: number[];
}

/**
 * Live `__daemon-run` processes still registered in THIS state dir's instance
 * registry, excluding `exclude`. State-dir-scoped by construction: the registry
 * lives inside this daemon dir, so a daemon serving a DIFFERENT state dir (a test
 * fixture with its own HOME, a separate install/home) registers elsewhere and is
 * invisible here — it is never a stop/takeover target. POSIX-only (the registry
 * and its `ps` liveness probe are); `[]` on Windows.
 *
 * Exported for `agents daemon status`/`doctor`/`services` (RUSH-2368): those
 * commands previously flagged every `__daemon-run` on the box (a raw `ps` scan)
 * as a "duplicate" of this daemon, which misreported test fixtures under their
 * own HOME — and therefore their own state dir and registry — as strays to
 * kill. This registry read is the same scope the reaper (`reapStrayDaemons`)
 * and the stop postcondition (`stopDaemon`) already use, so the display and the
 * reaper agree on what a duplicate is.
 */
export function findSurvivingStateDirDaemons(exclude: Set<number>): number[] {
  if (process.platform === 'win32') return [];
  const dir = getDaemonInstancesDir();
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const found: number[] = [];
  for (const name of entries) {
    const pid = parseInt(name, 10);
    if (isNaN(pid) || String(pid) !== name) continue; // not a pid marker
    if (exclude.has(pid)) continue;
    if (!isAlive(pid)) continue;            // dead marker — reaper self-heals it
    if (!isDaemonRunProcess(pid)) continue; // pid reused by an unrelated process
    found.push(pid);
  }
  return found;
}

/**
 * Stop the daemon and ASSERT its postcondition (SING-12, RUSH-2355), unloading it
 * from launchd/systemd if applicable.
 *
 * The SIGTERM → grace → killTree sequence is unchanged; what it adds is
 * verification. After the daemon is gone it checks that the secrets broker socket
 * and browser IPC binding actually released — a stale socket present on disk but
 * with no live owner is the orphan that keeps clients holding unlocked bundles
 * hanging (`daemon.ts` broker-hosting; the two-brokers-on-one-socket bug) — and
 * that no `__daemon-run` for THIS state dir survives. A killTree escalation exits
 * without running the daemon's graceful handleShutdown, so those sockets can be
 * left stale; this reclaims each (the owner is provably dead) and reports it. It
 * never reports success on an unverified stop.
 */
export function stopDaemon(): DaemonStopResult {
  const platform = os.platform();
  const released: string[] = [];
  const surviving: string[] = [];
  let escalated = false;

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
      escalated = true;
    } else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch { /* process already exited */ }

      // Wait for it to actually go. This used to be a setTimeout escalation plus
      // an immediate removeDaemonPid(), which had two failure modes: in a
      // short-lived process (the npm postinstall) the timer never fired at all,
      // and clearing the pid file while the old daemon still ran made
      // isDaemonRunning() report false, so startDaemon() launched a SECOND
      // daemon. Its hosted broker then unlinked the live socket and rebound,
      // orphaning the first broker with every unlocked bundle still in its RAM
      // and unreachable — two brokers on one socket path, seen on a real machine
      // after an install into a second prefix.
      if (!waitForExit(pid, STOP_GRACE_MS)) {
        killTree(pid);
        escalated = true;
        waitForExit(pid, STOP_KILL_GRACE_MS);
      }
    }
  }

  removeDaemonPid();

  // ── Assert the postcondition (SING-12) ────────────────────────────────────
  // No `__daemon-run` for this state dir may survive the stop.
  const survivors = findSurvivingStateDirDaemons(new Set([process.pid]));
  if (pid && process.platform === 'win32' && isAlive(pid) && !survivors.includes(pid)) {
    survivors.push(pid); // registry is POSIX-only; check the killed pid directly
  }
  if (survivors.length > 0) {
    for (const s of survivors) surviving.push(`__daemon-run pid ${s} still alive`);
  } else if (pid) {
    released.push('daemon process');
  }

  // Browser IPC binding: on POSIX the listening socket is a filesystem object.
  // A graceful handleShutdown unlinks it; if it survives, the daemon exited
  // ungracefully (killTree) and left a stale binding — the owner is provably
  // dead, so reclaim it and report.
  if (process.platform !== 'win32') {
    const browserSock = getBrowserIpcSocketPath();
    if (fs.existsSync(browserSock)) {
      try { fs.unlinkSync(browserSock); } catch { /* raced with a fresh start */ }
      if (fs.existsSync(browserSock)) surviving.push('browser IPC socket not released');
      else released.push('browser IPC socket (reclaimed)');
    } else {
      released.push('browser IPC socket');
    }

    // Secrets broker socket: released when it is gone, or still owned by a
    // DIFFERENT live broker (a standalone service the daemon never hosted). A
    // socket present with NO live owner is the orphan — reclaim it.
    const brokerSock = secretsBrokerSocketPath();
    if (!fs.existsSync(brokerSock)) {
      released.push('secrets broker socket');
    } else if (brokerPidAlive()) {
      released.push('secrets broker socket (standalone owner)');
    } else {
      try { fs.unlinkSync(brokerSock); } catch { /* raced with a fresh bind */ }
      if (fs.existsSync(brokerSock)) surviving.push('secrets broker socket not released');
      else released.push('secrets broker socket (reclaimed)');
    }
  }

  // In-flight detached routine children survive on purpose (SING-11a) — report,
  // never kill: severing a live agent mid-run is worse than a daemon restart.
  const detachedChildren = listLiveRoutineChildren();

  return {
    ok: surviving.length === 0,
    stoppedPid: pid,
    escalated,
    released,
    surviving,
    detachedChildren,
  };
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
