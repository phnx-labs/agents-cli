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
import { listJobs as listAllJobs } from './routines.js';
import { JobScheduler } from './scheduler.js';
import { executeJobDetached, monitorRunningJobs } from './runner.js';
import { BrowserService } from './browser/service.js';
import { BrowserIPCServer } from './browser/ipc.js';

const PID_FILE = 'daemon.pid';
const LOCK_FILE = 'daemon.lock';
const LOG_FILE = 'logs.jsonl';
const LOG_MAX_SIZE = 5 * 1024 * 1024; // 5 MB
const LOG_ROTATE_COUNT = 3;
const PLIST_NAME = 'com.phnx-labs.agents-daemon';
const SYSTEMD_UNIT = 'agents-daemon.service';

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
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    removeDaemonPid();
    return false;
  }
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

  const handleReload = () => {
    log('INFO', 'Reloading jobs (SIGHUP)');
    scheduler.reloadAll();
    const reloaded = scheduler.listScheduled();
    log('INFO', `Reloaded ${reloaded.length} jobs`);
  };

  const handleShutdown = async () => {
    log('INFO', 'Daemon shutting down');
    scheduler.stopAll();
    await browserIPC.stop();
    clearInterval(monitorInterval);
    removeDaemonPid();
    process.exit(0);
  };

  process.on('SIGHUP', handleReload);
  process.on('SIGTERM', () => handleShutdown());
  process.on('SIGINT', () => handleShutdown());

  await new Promise(() => {});
}

/** Generate a macOS launchd plist for auto-starting the daemon. */
export function generateLaunchdPlist(): string {
  const agentsBin = getAgentsBinPath();
  const logPath = getLogPath();

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
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:${os.homedir()}/.bun/bin:${os.homedir()}/.nvm/versions/node/v24.0.0/bin</string>
  </dict>
</dict>
</plist>`;
}

/** Generate a Linux systemd user unit for auto-starting the daemon. */
export function generateSystemdUnit(): string {
  const agentsBin = getAgentsBinPath();

  return `[Unit]
Description=Agents Daemon - Scheduled Job Runner
After=network.target

[Service]
Type=simple
ExecStart=${agentsBin} daemon _run
Restart=always
RestartSec=10
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${os.homedir()}/.nvm/versions/node/v24.0.0/bin

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
      fs.writeFileSync(plistPath, generateLaunchdPlist(), 'utf-8');

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
      fs.writeFileSync(unitPath, generateSystemdUnit(), 'utf-8');

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

function startDetached(): { pid: number; method: string } {
  const agentsBin = getAgentsBinPath();
  const logPath = getLogPath();
  const logFd = fs.openSync(logPath, 'a');

  const child = spawn(agentsBin, ['daemon', '_run'], {
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });

  child.unref();
  fs.closeSync(logFd);

  return { pid: child.pid || null, method: 'detached' } as { pid: number; method: string };
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
    try {
      process.kill(pid, 'SIGTERM');
    } catch { /* process already exited */ }

    setTimeout(() => {
      try {
        process.kill(pid, 0);
        process.kill(pid, 'SIGKILL');
      } catch { /* process already exited */ }
    }, 5000);
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
  try {
    process.kill(pid, 'SIGHUP');
    return true;
  } catch {
    return false;
  }
}
