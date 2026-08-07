/**
 * `agents daemon` — runtime, hosted services, and failure visibility for the
 * always-on daemon (RUSH-2354).
 *
 * The daemon holds the routines scheduler, the secrets broker, the browser IPC
 * server, and the watchdog pass — but until this command group existed it had
 * no user-facing surface: no way to see it, restart it, or turn it off.
 * `daemon.ts` (the runtime) has always implemented every mechanism this file
 * wires up; nothing here is new machinery, only the missing CLI surface.
 *
 * There is deliberately no `agents daemon jobs` — scheduled work is
 * `agents routines`, always (see RUSH-2353, which migrates the daemon's
 * hardcoded timers onto routines). `status`/`services` point at
 * `agents routines stats` for per-routine failure detail instead of
 * duplicating it.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { setHelpSections } from '../lib/help.js';
import {
  getDaemonStatus,
  isDaemonRunning,
  isDaemonWedged,
  readDaemonLog,
  startDaemon,
  stopDaemon,
  signalDaemonReload,
} from '../lib/daemon.js';
import { getConfigValue, setConfigValue, isDaemonEnabled } from '../lib/device-config.js';
import {
  readSubsystemHealth,
  SUBSYSTEM_SECRETS_BROKER,
  SUBSYSTEM_BROWSER_IPC,
  type SubsystemHealth,
} from '../lib/daemon-health.js';
import { listJobs, getLatestRun } from '../lib/routines.js';
import { JobScheduler } from '../lib/scheduler.js';
import { getDaemonDir } from '../lib/state.js';
import { followFile } from '../lib/log-follow.js';
import { parseDuration } from '../lib/hooks/cache.js';

// ─── Process scanning — which install owns the pid, and every duplicate ──────

interface DaemonProcess {
  pid: number;
  /** The entry file/binary the process was launched from, best-effort. */
  entry: string | null;
  /** Resolved package version for `entry`, or null if it couldn't be found. */
  version: string | null;
}

/**
 * Resolve the working directory a live process was started from, or null if
 * unavailable. Linux only (`/proc/<pid>/cwd`) — there is no equivalent
 * zero-dependency primitive on macOS/BSD.
 */
function processCwd(pid: number): string | null {
  try { return fs.realpathSync(`/proc/${pid}/cwd`); } catch { return null; }
}

/**
 * Walk up from `entryPath` looking for the nearest `package.json` and read its
 * version. A relative `entryPath` (the common shape for a dev `node --import
 * tsx <entry> __daemon-run` invocation) is meaningless resolved against the
 * CALLING process's cwd — it must be anchored to the OWNING process's own cwd
 * instead, via `processCwd(pid)`. Getting this wrong silently reports another
 * process's version as this one's (observed live: a relative `src/index.ts`
 * resolved against the caller's cwd instead of the stray daemon's actual
 * ephemeral `/tmp` cwd, reporting a version that process was not running).
 * Absolute entries (every production launch — `getAgentsBinPath()` always
 * returns one) need no anchoring and resolve the same either way.
 */
function resolveVersionNear(entryPath: string, pid: number): string | null {
  let resolved = entryPath;
  if (!path.isAbsolute(resolved)) {
    const cwd = processCwd(pid);
    if (!cwd) return null; // cannot anchor a relative entry — do not guess
    resolved = path.join(cwd, resolved);
  }
  try { resolved = fs.realpathSync(resolved); } catch { /* shim/symlink may be broken or entry may not exist locally */ }
  let dir = path.dirname(resolved);
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
      if (typeof pkg.version === 'string') return pkg.version;
    } catch { /* keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Extract the launch entry from a tokenized `ps` args line ending in
 * `__daemon-run`: the token immediately before it is always the entry —
 * `<node> [node flags...] <entry> __daemon-run` (a dev `node --import tsx
 * <entry> __daemon-run` or the production `node <entry> __daemon-run`) or a
 * compiled standalone binary (`<binary> __daemon-run`, 2 tokens). Reading the
 * second-to-last token is robust to however many node flags precede the entry,
 * unlike guessing a fixed position from the front.
 */
function entryFromTokens(tokens: string[]): string | null {
  return tokens.length >= 2 ? tokens[tokens.length - 2] : null;
}

/**
 * Every live `__daemon-run` process on this box, regardless of which install
 * launched it. POSIX-only (uses `ps`), mirroring `reapStrayDaemons`'s scope —
 * a no-op on Windows.
 *
 * `getDaemonLaunch` always spawns `<node> <entry> __daemon-run` with nothing
 * after it — the ONLY argv `__daemon-run` ever appears in for a real daemon.
 * A substring/regex test anywhere in the full command line is not enough: an
 * `agents run claude "<prompt>"` invocation whose prompt happens to quote the
 * literal text `__daemon-run` (this ticket's own brief does) matches that test
 * too, and was observed producing false "duplicate daemon" rows. Requiring it
 * to be the LAST whitespace-delimited token is the actual invariant.
 */
function scanDaemonProcesses(): DaemonProcess[] {
  if (process.platform === 'win32') return [];
  let out: string;
  try {
    out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return [];
  }
  const found: DaemonProcess[] = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const args = m[2].trim();
    const tokens = args.split(/\s+/);
    if (tokens.length === 0 || tokens[tokens.length - 1] !== '__daemon-run') continue;
    const pid = parseInt(m[1], 10);
    if (isNaN(pid)) continue;
    const entry = entryFromTokens(tokens);
    const version = entry ? resolveVersionNear(entry, pid) : null;
    found.push({ pid, entry, version });
  }
  return found;
}

/** Elapsed wall-clock seconds since `pid` started, or null if unavailable (best-effort, POSIX only). */
function uptimeSeconds(pid: number): number | null {
  if (process.platform === 'win32') return null;
  try {
    const out = execFileSync('ps', ['-o', 'etimes=', '-p', String(pid)], { encoding: 'utf-8' }).trim();
    const n = parseInt(out, 10);
    return isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

function humanDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

// ─── Health probes for the two hosted services ───────────────────────────────

interface SecretsBrokerHealth {
  reachable: boolean;
  socketPath: string | null;
  heldBundles: number | null;
  record: SubsystemHealth | null;
}

async function probeSecretsBroker(): Promise<SecretsBrokerHealth> {
  const record = readSubsystemHealth(SUBSYSTEM_SECRETS_BROKER);
  try {
    const { agentPing, agentStatus, secretsBrokerSocketPath } = await import('../lib/secrets/agent.js');
    const ping = await agentPing();
    if (!ping.reachable) return { reachable: false, socketPath: secretsBrokerSocketPath(), heldBundles: null, record };
    const entries = await agentStatus();
    return { reachable: true, socketPath: secretsBrokerSocketPath(), heldBundles: entries.length, record };
  } catch {
    return { reachable: false, socketPath: null, heldBundles: null, record };
  }
}

interface BrowserIpcHealth {
  bound: boolean;
  socketPath: string;
  sessionCount: number;
  record: SubsystemHealth | null;
}

async function probeBrowserIPC(): Promise<BrowserIpcHealth> {
  const record = readSubsystemHealth(SUBSYSTEM_BROWSER_IPC);
  const { isDaemonReachable, getSocketPath } = await import('../lib/browser/ipc.js');
  const { listAllProfileSnapshots } = await import('../lib/browser/runtime-state.js');
  const bound = await isDaemonReachable();
  const sessionCount = listAllProfileSnapshots().filter((s) => s.pidAlive && s.daemonAlive).length;
  return { bound, socketPath: getSocketPath(), sessionCount, record };
}

// ─── Scheduler summary (routine count / next fire / failing count) ──────────

interface SchedulerSummary {
  routineCount: number;
  enabledCount: number;
  nextFire: Date | null;
  failingCount: number;
}

function schedulerSummary(): SchedulerSummary {
  const jobs = listJobs();
  const enabled = jobs.filter((j) => j.enabled);
  let nextFire: Date | null = null;
  try {
    const scheduler = new JobScheduler(async () => {});
    scheduler.loadAll();
    for (const job of scheduler.listScheduled()) {
      if (job.nextRun && (!nextFire || job.nextRun < nextFire)) nextFire = job.nextRun;
    }
    scheduler.stopAll();
  } catch { /* best-effort */ }
  const failingCount = enabled.filter((j) => {
    const last = getLatestRun(j.name);
    return last?.status === 'failed' || last?.status === 'timeout';
  }).length;
  return { routineCount: jobs.length, enabledCount: enabled.length, nextFire, failingCount };
}

// ─── Rendering ────────────────────────────────────────────────────────────

function healthLine(label: string, record: SubsystemHealth | null): string {
  if (!record || record.consecutiveFailures === 0) {
    const ok = record?.lastOkAt ? chalk.gray(`(last ok ${record.lastOkAt})`) : '';
    return `  ${chalk.green('healthy')}  ${label} ${ok}`;
  }
  return `  ${chalk.red(`${record.consecutiveFailures} consecutive failure(s)`)}  ${label} ${chalk.gray(`— ${record.lastError}`)}`;
}

async function runStatus(opts: { json?: boolean }): Promise<void> {
  const status = getDaemonStatus();
  const enabled = isDaemonEnabled();
  const state: 'running' | 'wedged' | 'stopped' | 'disabled' =
    !status.running && !enabled ? 'disabled' : status.state;
  const pid = status.pid;
  const uptime = pid ? uptimeSeconds(pid) : null;
  const heartbeatAgeMs = status.heartbeat ? Date.now() - Date.parse(status.heartbeat.lastTick) : null;

  const processes = scanDaemonProcesses();
  const owner = pid ? processes.find((p) => p.pid === pid) : undefined;
  const duplicates = processes.filter((p) => p.pid !== pid);

  const [secrets, browserIpc] = await Promise.all([probeSecretsBroker(), probeBrowserIPC()]);
  const scheduler = schedulerSummary();

  if (opts.json) {
    console.log(JSON.stringify({
      state,
      pid,
      uptimeSeconds: uptime,
      heartbeatAgeMs,
      logPath: status.logPath,
      binaryPath: owner?.entry ?? status.binaryPath,
      binaryVersion: owner?.version ?? null,
      duplicates: duplicates.map((d) => ({ pid: d.pid, entry: d.entry, version: d.version })),
      daemonEnabled: enabled,
      services: {
        secretsBroker: {
          reachable: secrets.reachable,
          socketPath: secrets.socketPath,
          heldBundles: secrets.heldBundles,
          health: secrets.record,
        },
        browserIpc: {
          bound: browserIpc.bound,
          socketPath: browserIpc.socketPath,
          sessionCount: browserIpc.sessionCount,
          health: browserIpc.record,
        },
      },
      scheduler: {
        enabled: getConfigValue('scheduler.enabled').value !== false,
        routineCount: scheduler.routineCount,
        enabledCount: scheduler.enabledCount,
        nextFire: scheduler.nextFire ? scheduler.nextFire.toISOString() : null,
        failingCount: scheduler.failingCount,
      },
    }, null, 2));
    return;
  }

  const stateLabel =
    state === 'running' ? chalk.green('running')
    : state === 'wedged' ? chalk.red('wedged')
    : state === 'disabled' ? chalk.yellow('disabled')
    : chalk.gray('stopped');

  console.log(chalk.bold('Identity\n'));
  console.log(`  State:      ${stateLabel}`);
  if (pid) console.log(`  PID:        ${pid}`);
  if (uptime !== null) console.log(`  Uptime:     ${humanDuration(uptime)}`);
  if (heartbeatAgeMs !== null) console.log(`  Heartbeat:  ${Math.round(heartbeatAgeMs / 1000)}s ago`);
  console.log(`  Binary:     ${chalk.gray(owner?.entry ?? status.binaryPath ?? 'unknown')}`);
  console.log(`  Version:    ${chalk.gray(owner?.version ?? 'unknown')}`);
  console.log(`  Log:        ${chalk.gray(status.logPath)}`);
  if (!enabled) console.log(chalk.yellow(`  daemon.enabled is false — nothing auto-starts it. Explicit start: agents daemon start`));

  if (duplicates.length > 0) {
    console.log(chalk.red(`\nDuplicates (${duplicates.length})\n`));
    for (const d of duplicates) {
      console.log(`  PID ${d.pid}  ${chalk.gray(d.entry ?? 'unknown entry')} ${d.version ? chalk.gray(`(v${d.version})`) : ''}`);
    }
    console.log(chalk.gray('\n  Only one install should own the daemon. Stop the stray(s): kill <pid>'));
  }

  console.log(chalk.bold('\nHealth\n'));
  console.log(healthLine(`secrets broker  ${secrets.reachable ? `(${secrets.socketPath}, ${secrets.heldBundles} bundle(s) held)` : '(unreachable)'}`, secrets.record));
  console.log(healthLine(`browser IPC     ${browserIpc.bound ? `(${browserIpc.socketPath}, ${browserIpc.sessionCount} session(s))` : '(unbound)'}`, browserIpc.record));

  const schedulerEnabled = getConfigValue('scheduler.enabled').value !== false;
  console.log(`  ${schedulerEnabled ? chalk.green('enabled') : chalk.yellow('disabled')}  scheduler — ${scheduler.enabledCount}/${scheduler.routineCount} routine(s) enabled` +
    (scheduler.nextFire ? `, next ${scheduler.nextFire.toLocaleString()}` : ''));
  if (scheduler.failingCount > 0) {
    console.log(chalk.red(`  ${scheduler.failingCount} routine(s) failing their last run — see: agents routines stats`));
  }

  if (state === 'wedged') {
    console.log(chalk.red('\nThe daemon is wedged (heartbeat stale). Restart: agents daemon restart'));
  }
}

async function runServices(opts: { json?: boolean }): Promise<void> {
  const [secrets, browserIpc] = await Promise.all([probeSecretsBroker(), probeBrowserIPC()]);
  if (opts.json) {
    console.log(JSON.stringify({
      secretsBroker: { reachable: secrets.reachable, socketPath: secrets.socketPath, heldBundles: secrets.heldBundles, health: secrets.record },
      browserIpc: { bound: browserIpc.bound, socketPath: browserIpc.socketPath, sessionCount: browserIpc.sessionCount, health: browserIpc.record },
    }, null, 2));
    return;
  }
  console.log(chalk.bold('Hosted services\n'));
  console.log(healthLine(`secrets broker  ${secrets.reachable ? `(${secrets.socketPath}, ${secrets.heldBundles} bundle(s) held)` : '(unreachable)'}`, secrets.record));
  console.log(healthLine(`browser IPC     ${browserIpc.bound ? `(${browserIpc.socketPath}, ${browserIpc.sessionCount} session(s))` : '(unbound)'}`, browserIpc.record));
  console.log(chalk.gray('\nScheduled routines run through `agents routines` — see: agents routines stats'));
}

// ─── Logs ────────────────────────────────────────────────────────────────

interface DaemonLogEntry {
  ts: string;
  level: string;
  message: string;
}

function parseLogLines(raw: string): DaemonLogEntry[] {
  const out: DaemonLogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry.ts === 'string' && typeof entry.level === 'string') out.push(entry);
    } catch { /* skip malformed line */ }
  }
  return out;
}

const LEVEL_RANK: Record<string, number> = { INFO: 0, WARN: 1, ERROR: 2 };

function passesFilters(entry: DaemonLogEntry, minLevel: string | undefined, sinceMs: number | undefined): boolean {
  if (minLevel) {
    const min = LEVEL_RANK[minLevel.toUpperCase()] ?? 0;
    const level = LEVEL_RANK[entry.level.toUpperCase()] ?? 0;
    if (level < min) return false;
  }
  if (sinceMs !== undefined && Date.parse(entry.ts) < sinceMs) return false;
  return true;
}

function printLogEntry(entry: DaemonLogEntry): void {
  const color = entry.level === 'ERROR' ? chalk.red : entry.level === 'WARN' ? chalk.yellow : chalk.gray;
  console.log(`${chalk.gray(entry.ts)} ${color(entry.level.padEnd(5))} ${entry.message}`);
}

async function runLogs(opts: { lines?: string; follow?: boolean; level?: string; since?: string; json?: boolean }): Promise<void> {
  const sinceMs = opts.since ? Date.now() - (parseDuration(opts.since) ?? 0) * 1000 : undefined;
  const lineCount = opts.lines ? parseInt(opts.lines, 10) : 50;

  if (opts.follow) {
    const logPath = path.join(getDaemonDir(), 'logs.jsonl');
    for (const entry of parseLogLines(readDaemonLog(lineCount)).filter((e) => passesFilters(e, opts.level, sinceMs))) {
      if (opts.json) console.log(JSON.stringify(entry));
      else printLogEntry(entry);
    }
    const stop = followFile(logPath, (text) => {
      for (const entry of parseLogLines(text).filter((e) => passesFilters(e, opts.level, sinceMs))) {
        if (opts.json) console.log(JSON.stringify(entry));
        else printLogEntry(entry);
      }
    }, { fromEnd: true });
    process.on('SIGINT', () => { stop(); process.exit(0); });
    return;
  }

  const entries = parseLogLines(readDaemonLog()).filter((e) => passesFilters(e, opts.level, sinceMs)).slice(-lineCount);
  if (entries.length === 0) {
    if (opts.json) console.log('[]');
    else console.log(chalk.gray('No matching log lines'));
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(entries));
    return;
  }
  for (const entry of entries) printLogEntry(entry);
}

// ─── Doctor ──────────────────────────────────────────────────────────────

async function runDoctor(opts: { json?: boolean }): Promise<void> {
  const status = getDaemonStatus();
  const enabled = isDaemonEnabled();
  const problems: string[] = [];

  if (!status.running && enabled) problems.push('Daemon is not running. Start it: agents daemon start');
  if (status.running && isDaemonWedged()) problems.push('Daemon is wedged (heartbeat stale). Restart: agents daemon restart');

  const duplicates = scanDaemonProcesses().filter((p) => p.pid !== status.pid);
  if (duplicates.length > 0) {
    problems.push(`${duplicates.length} duplicate daemon process(es) running: ${duplicates.map((d) => d.pid).join(', ')}. Stop the stray(s).`);
  }

  const secrets = await probeSecretsBroker();
  if (!secrets.reachable) problems.push('Secrets broker is unreachable.');
  if (secrets.record && secrets.record.consecutiveFailures > 0) {
    problems.push(`Secrets broker has ${secrets.record.consecutiveFailures} consecutive failure(s): ${secrets.record.lastError}`);
  }

  const browserIpc = await probeBrowserIPC();
  if (!browserIpc.bound) problems.push('Browser IPC is unbound.');
  if (browserIpc.record && browserIpc.record.consecutiveFailures > 0) {
    problems.push(`Browser IPC has ${browserIpc.record.consecutiveFailures} consecutive failure(s): ${browserIpc.record.lastError}`);
  }

  const scheduler = schedulerSummary();
  if (scheduler.failingCount > 0) {
    problems.push(`${scheduler.failingCount} routine(s) failing their last run. See: agents routines stats`);
  }

  if (opts.json) {
    console.log(JSON.stringify({ healthy: problems.length === 0, problems }));
    if (problems.length > 0) process.exitCode = 1;
    return;
  }

  if (problems.length === 0) {
    console.log(chalk.green('daemon: healthy'));
    return;
  }
  console.log(chalk.bold(`daemon: ${problems.length} problem(s)\n`));
  for (const p of problems) console.log(`  ${chalk.red('✗')} ${p}`);
  process.exitCode = 1;
}

// ─── Command registration ────────────────────────────────────────────────

export function registerDaemonCommand(program: Command): void {
  const cmd = program
    .command('daemon')
    .description('The always-on daemon: secrets broker, browser IPC, watchdog, and the routines scheduler. Bare `agents daemon` shows status.')
    .option('--json', 'Emit as JSON')
    .action(async (opts, command) => {
      await runStatus({ json: command.optsWithGlobals().json === true });
    });

  setHelpSections(cmd, {
    examples: `
      # Identity, duplicates, and per-service health in one view
      agents daemon status

      # Machine-readable status (for scripts / Factory)
      agents daemon status --json

      # Start / stop / restart the daemon process
      agents daemon start
      agents daemon stop
      agents daemon restart

      # Persist the daemon off — nothing auto-starts it until re-enabled
      agents daemon disable
      agents daemon enable

      # Reload config (SIGHUP) without restarting — picks up routine/scheduler-gate changes
      agents daemon reload

      # Just the two hosted services (secrets broker, browser IPC)
      agents daemon services

      # Tail the daemon's own log, warnings and up, from the last hour
      agents daemon logs -f --level warn --since 1h

      # One-shot health check for scripts (non-zero exit on problems)
      agents daemon doctor
    `,
    notes: `
      There is no 'agents daemon jobs' — scheduled work is 'agents routines',
      always. Use 'agents routines stats' for per-routine failure detail.

      'disable' is a persisted kill switch: it stops routines/add,
      routines/start, routines/catchup, and webhook triggers from auto-starting
      the daemon (daemon.enabled: false in ~/.agents/devices/<host>/agents.yaml).
      'agents daemon start' still starts it explicitly, same as
      'systemctl start' on a disabled unit.
    `,
  });

  cmd.command('status')
    .description('Identity (state/pid/uptime/binary), duplicate daemon processes, and per-service health.')
    .option('--json', 'Emit as JSON')
    .action(async (opts, command) => {
      await runStatus({ json: command.optsWithGlobals().json === true });
    });

  cmd.command('start')
    .description('Start the daemon. Bypasses daemon.enabled — this is the deliberate override.')
    .action(() => {
      const result = startDaemon();
      if (result.method === 'already-running') {
        console.log(chalk.yellow(`Daemon already running (PID: ${result.pid})`));
      } else if (result.pid) {
        console.log(chalk.green(`Daemon started (PID: ${result.pid}, ${result.method})`));
      } else {
        console.log(chalk.yellow('Daemon start dispatched but no PID surfaced. Check: agents daemon status'));
      }
    });

  cmd.command('stop')
    .description('Stop the daemon.')
    .option('--json', 'Emit the structured stop result (released/surviving resources, detached children).')
    .action((_opts, command) => {
      const asJson = command.optsWithGlobals().json === true;
      if (!isDaemonRunning()) {
        if (asJson) {
          console.log(JSON.stringify(
            { ok: true, stoppedPid: null, escalated: false, released: [], surviving: [], detachedChildren: [] },
            null, 2));
        } else {
          console.log(chalk.yellow('Daemon is not running'));
        }
        return;
      }
      // SING-12 / RUSH-2355: stop asserts its postcondition and returns what
      // released vs survived — surface it and exit non-zero on an unclean stop.
      const result = stopDaemon();
      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(result.ok ? chalk.green('Daemon stopped') : chalk.red('Daemon stop incomplete'));
        for (const r of result.released) console.log(chalk.gray(`  released: ${r}`));
        for (const s of result.surviving) console.log(chalk.red(`  surviving: ${s}`));
        if (result.detachedChildren.length > 0) {
          console.log(chalk.gray(`  detached routine children left running (adopted on next daemon start): ${result.detachedChildren.join(', ')}`));
        }
      }
      if (!result.ok) process.exitCode = 1;
    });

  cmd.command('restart')
    .description('Stop then start the daemon.')
    .action(() => {
      if (isDaemonRunning()) {
        const stop = stopDaemon();
        console.log(stop.ok ? chalk.gray('Daemon stopped') : chalk.red('Daemon stop incomplete'));
        for (const s of stop.surviving) console.log(chalk.red(`  surviving: ${s}`));
      }
      const result = startDaemon();
      if (result.pid) console.log(chalk.green(`Daemon started (PID: ${result.pid}, ${result.method})`));
      else console.log(chalk.yellow('Daemon start dispatched but no PID surfaced. Check: agents daemon status'));
    });

  cmd.command('enable')
    .description('Clear the daemon.enabled kill switch. Does not start the daemon by itself.')
    .action(() => {
      setConfigValue('daemon.enabled', true);
      console.log(chalk.green('daemon.enabled: true') + chalk.gray(' — auto-start surfaces (routines add/start/catchup, webhooks) may bring the daemon up again'));
    });

  cmd.command('disable')
    .description('Persist daemon.enabled: false — nothing auto-starts the daemon until re-enabled. Does not stop a running daemon.')
    .action(() => {
      setConfigValue('daemon.enabled', false);
      console.log(chalk.yellow('daemon.enabled: false') + chalk.gray(' — auto-start is off. Explicit start still works: agents daemon start'));
      if (isDaemonRunning()) console.log(chalk.gray('(the daemon is still running — stop it explicitly if you want it down: agents daemon stop)'));
    });

  cmd.command('reload')
    .description('Send SIGHUP to reload jobs and re-evaluate the scheduler.enabled gate, without a restart.')
    .action(() => {
      if (!isDaemonRunning()) {
        console.log(chalk.yellow('Daemon is not running — nothing to reload. Start it: agents daemon start'));
        return;
      }
      const ok = signalDaemonReload();
      console.log(ok ? chalk.green('Daemon reloaded') : chalk.yellow('Reload signal not delivered (unsupported on this platform, or the daemon just exited)'));
    });

  cmd.command('services')
    .description('The two hosted services (secrets broker, browser IPC): bound state, socket path, and health.')
    .option('--json', 'Emit as JSON')
    .action(async (opts, command) => {
      await runServices({ json: command.optsWithGlobals().json === true });
    });

  cmd.command('logs')
    .description('Read the daemon\'s own log (lifecycle + subsystem errors — not routine run output).')
    .option('-n, --lines <number>', 'Show this many recent lines', '50')
    .option('-f, --follow', 'Stream new lines as they are written (like tail -f)')
    .option('--level <level>', 'Minimum level to show: info | warn | error')
    .option('--since <dur>', 'Only lines newer than this (e.g. 1h, 30m)')
    .option('--json', 'Emit each line as JSON')
    .action(async (opts, command) => {
      const merged = command.optsWithGlobals();
      await runLogs({ lines: opts.lines, follow: opts.follow, level: opts.level, since: opts.since, json: merged.json === true || opts.json === true });
    });

  cmd.command('doctor')
    .description('One-shot health check: identity, duplicates, hosted services, scheduler. Non-zero exit on problems.')
    .option('--json', 'Emit as JSON')
    .action(async (opts, command) => {
      await runDoctor({ json: command.optsWithGlobals().json === true });
    });
}
