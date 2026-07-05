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
import { isAlive, killTree } from './platform/index.js';
import { listJobs as listAllJobs } from './routines.js';
import { JobScheduler } from './scheduler.js';
import { executeJobDetached, monitorRunningJobs } from './runner.js';
import { detectOverdueJobs, notifyOverdue } from './overdue.js';
import { BrowserService } from './browser/service.js';
import { BrowserIPCServer } from './browser/ipc.js';
import { readAndResolveBundleEnv } from './secrets/bundles.js';

const PID_FILE = 'daemon.pid';
const LOCK_FILE = 'daemon.lock';
const LOG_FILE = 'logs.jsonl';
const LOG_MAX_SIZE = 5 * 1024 * 1024; // 5 MB
const LOG_ROTATE_COUNT = 3;
const PLIST_NAME = 'com.phnx-labs.agents-daemon';
const SYSTEMD_UNIT = 'agents-daemon.service';

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

/** Check if the daemon process is alive by sending signal 0 to the stored PID. */
export function isDaemonRunning(): boolean {
  const pid = readDaemonPid();
  if (!pid) return false;
  if (isAlive(pid)) return true;
  removeDaemonPid();
  return false;
}

/** Redact values that look like tokens or credentials in a log message. */
function redactSecrets(message: string): string {
  let safe = message;
  safe = safe.replace(/eyJ[A-Za-z0-9_-]{20,}/g, '[REDACTED_TOKEN]');
  safe = safe.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
  safe = safe.replace(/(sk-[a-zA-Z0-9]{20,})/g, '[REDACTED_KEY]');
  safe = safe.replace(/(ANTHROPIC_API_KEY|OPENAI_API_KEY|API_KEY|SECRET|TOKEN|PASSWORD)=\S+/gi, '$1=[REDACTED]');
  return safe;
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
  writeDaemonPid(process.pid);
  log('INFO', `Daemon started (PID: ${process.pid})`);

  const scheduler = new JobScheduler(async (config) => {
    log('INFO', `Triggering job '${config.name}' (agent: ${config.agent})`);
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

  const monitorInterval = setInterval(() => {
    monitorRunningJobs();
  }, 60_000);

  // Cross-machine session sync: push this machine's transcripts to R2 and pull
  // every other machine's, ~every 90s. Skipped silently when the r2.backups
  // bundle is absent. An overlap guard prevents a slow cycle from stacking.
  let syncing = false;
  const runSessionSync = async () => {
    if (syncing) return;
    syncing = true;
    try {
      const { isSyncConfigured } = await import('./session/sync/config.js');
      if (!isSyncConfigured()) return;
      const { syncSessions } = await import('./session/sync/sync.js');
      const r = await syncSessions();
      if (r.pushed || r.pulled || r.errors.length) {
        log('INFO', `sessions sync: pushed ${r.pushed}, pulled ${r.pulled}, merged ${r.merged}` +
          (r.errors.length ? `, ${r.errors.length} error(s): ${r.errors[0]}` : ''));
      }
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
      const { heal, summarizeHeal, notifyHeal, healChangedAnything } = await import('./heal.js');
      const result = await heal({ mode: 'safe' });
      if (healChangedAnything(result) || result.skippedPlugins.length > 0) {
        log('INFO', `heal: ${summarizeHeal(result)}`);
        notifyHeal(result);
      }
    } catch (err) {
      log('ERROR', `heal check failed: ${(err as Error).message}`);
    } finally {
      healing = false;
    }
  };
  const healInterval = setInterval(() => { void runHealCheck(); }, 6 * 60 * 60_000);
  const healKickoff = setTimeout(() => { void runHealCheck(); }, 30_000);

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

  const handleReload = () => {
    log('INFO', 'Reloading jobs (SIGHUP)');
    scheduler.reloadAll();
    const reloaded = scheduler.listScheduled();
    log('INFO', `Reloaded ${reloaded.length} jobs`);
    // Drop the memoized R2 config so rotated/added sync credentials are re-read
    // on the next cycle instead of waiting for a restart.
    void import('./session/sync/config.js').then(m => m.clearR2ConfigCache());
  };

  const handleShutdown = async () => {
    log('INFO', 'Daemon shutting down');
    scheduler.stopAll();
    await browserIPC.stop();
    clearInterval(monitorInterval);
    clearInterval(syncInterval);
    clearInterval(healInterval);
    clearTimeout(healKickoff);
    clearInterval(deviceProbeInterval);
    clearTimeout(deviceProbeKickoff);
    removeDaemonPid();
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
 * way `agents run --secrets` does, so the token is found whether it was stored
 * keychain-backed or as a literal. Returns null when the bundle/key isn't
 * configured, the Keychain read is cancelled, or the platform has no keychain —
 * the daemon then behaves exactly as before (relying on the interactive OAuth
 * session). Never throws: a misconfigured token must not block daemon startup.
 */
export function readDaemonClaudeOAuthToken(): string | null {
  try {
    const { env } = readAndResolveBundleEnv(DAEMON_OAUTH_BUNDLE, { caller: 'daemon' });
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

/** Generate a macOS launchd plist for auto-starting the daemon. */
export function generateLaunchdPlist(): string {
  const agentsBin = getAgentsBinPath();
  const logPath = getLogPath();
  const oauthToken = readDaemonClaudeOAuthToken();
  const oauthEntry = oauthToken
    ? `
    <key>${DAEMON_OAUTH_KEY}</key>
    <string>${xmlEscape(oauthToken)}</string>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${agentsBin}</string>
    <string>daemon</string>
    <string>_run</string>
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
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:${os.homedir()}/.bun/bin:${os.homedir()}/.nvm/versions/node/v24.0.0/bin</string>${oauthEntry}
  </dict>
</dict>
</plist>`;
}

/** Generate a Linux systemd user unit for auto-starting the daemon. */
export function generateSystemdUnit(): string {
  const agentsBin = getAgentsBinPath();
  const oauthToken = readDaemonClaudeOAuthToken();
  const oauthLine = oauthToken
    ? `\nEnvironment=${DAEMON_OAUTH_KEY}=${oauthToken}`
    : '';

  return `[Unit]
Description=Agents Daemon - Scheduled Job Runner
After=network.target

[Service]
Type=simple
ExecStart=${agentsBin} daemon _run
Restart=always
RestartSec=10
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${os.homedir()}/.nvm/versions/node/v24.0.0/bin${oauthLine}

[Install]
WantedBy=default.target`;
}

function getAgentsBinPath(): string {
  // Prefer the binary actively executing this code. `which agents` returns
  // whatever happens to be first on PATH, which means a side-by-side dev
  // build at ~/.local/bin would silently spawn the registry-installed
  // daemon and run stale code. process.argv[1] is the absolute path of
  // the JS entrypoint the user actually invoked.
  const argv1 = process.argv[1];
  if (argv1 && fs.existsSync(argv1)) return argv1;
  try {
    return execFileSync('which', ['agents'], { encoding: 'utf-8' }).trim();
  } catch {
    return 'agents';
  }
}

/** Start the daemon via launchd, systemd, or as a detached process. */
export function startDaemon(): { pid: number | null; method: string } {
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
    return startDaemonLocked();
  } finally {
    releaseLock();
  }
}

function startDaemonLocked(): { pid: number | null; method: string } {
  const platform = os.platform();

  if (platform === 'darwin') {
    try {
      const plistPath = getLaunchdPlistPath();
      const plistDir = path.dirname(plistPath);
      if (!fs.existsSync(plistDir)) {
        fs.mkdirSync(plistDir, { recursive: true });
      }
      // The plist may embed a long-lived OAuth token in EnvironmentVariables;
      // create owner-only atomically (no world-readable window before chmod).
      writeOwnerOnlyServiceManifest(plistPath, generateLaunchdPlist());

      try {
        execFileSync('launchctl', ['unload', plistPath], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch { /* not loaded, expected */ }
      // launchctl prints `Load failed:` and exits 0 when the label is in a
      // stuck state from a prior session — so a zero exit code isn't proof
      // of success. If no pid materializes within the window, give up on
      // launchd and fall through to a plain detached spawn.
      execFileSync('launchctl', ['load', plistPath], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      const pid = waitForPid(3000);
      if (pid) return { pid, method: 'launchd' };
      // launchctl claimed success but nothing ran. Fall through.
    } catch {
      // load threw — fall through to detached spawn
    }
    return startDetached();
  }

  if (platform === 'linux') {
    try {
      const unitPath = getSystemdUnitPath();
      const unitDir = path.dirname(unitPath);
      if (!fs.existsSync(unitDir)) {
        fs.mkdirSync(unitDir, { recursive: true });
      }
      // May embed a long-lived OAuth token in an Environment= line; owner-only.
      writeOwnerOnlyServiceManifest(unitPath, generateSystemdUnit());

      execFileSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf-8' });
      execFileSync('systemctl', ['--user', 'enable', SYSTEMD_UNIT], { encoding: 'utf-8' });
      execFileSync('systemctl', ['--user', 'start', SYSTEMD_UNIT], { encoding: 'utf-8' });

      const pid = waitForPid(3000);
      return { pid, method: 'systemd' };
    } catch {
      return startDetached();
    }
  }

  return startDetached();
}

/**
 * Environment for the detached daemon fallback. The launchd/systemd paths
 * deliver the long-lived OAuth token via the service manifest's environment;
 * the detached path has no manifest, so inject it here. Read happens during an
 * interactive `routines start`, so a Keychain Touch ID prompt can be satisfied;
 * the daemon then passes it to every routine run it spawns. An already-set
 * value (e.g. inherited from launchd) is left untouched.
 */
export function buildDetachedDaemonEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
    const token = readDaemonClaudeOAuthToken();
    if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
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
 * When the entry isn't a JS file (e.g. a native launcher resolved via
 * `which agents`), run it directly — it owns its own runtime resolution.
 */
export function getDaemonLaunch(agentsBin: string = getAgentsBinPath()): { command: string; args: string[] } {
  if (/\.(c|m)?js$/.test(agentsBin)) {
    return { command: process.execPath, args: [agentsBin, 'daemon', '_run'] };
  }
  return { command: agentsBin, args: ['daemon', '_run'] };
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
  const child = spawn(command, args, {
    stdio: ['ignore', logFd, logFd],
    detached: true,
    // No console window on Windows — a hidden, consoleless process can't be
    // torn down by a console-close event when its launcher exits (#556).
    windowsHide: true,
    env: opts.env ?? buildDetachedDaemonEnv(),
  });

  child.unref();
  fs.closeSync(logFd);

  return { pid: child.pid || null, method: 'detached' };
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
  running: boolean;
  pid: number | null;
  jobCount: number;
  logPath: string;
} {
  const running = isDaemonRunning();
  const pid = readDaemonPid();

  let jobCount = 0;
  try {
    jobCount = listAllJobs().filter((j) => j.enabled).length;
  } catch { /* job listing failed */ }

  return { running, pid, jobCount, logPath: getLogPath() };
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
