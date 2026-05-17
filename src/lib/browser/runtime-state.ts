import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { getProfileRuntimeDir, getBrowserRuntimeDir } from './profiles.js';

/**
 * Per-profile runtime files we persist under
 * `~/.agents/.cache/browser/<composite>/`:
 *
 *  - `pid`     — child process ID we spawned (or 0 if attached to an
 *                already-running browser)
 *  - `port`    — CDP port we ended up speaking on
 *  - `command` — basename of the executable so we can defend against pid
 *                reuse (`process.kill(pid, 0)` only proves *some* process
 *                with that id exists; if the OS recycled it for an
 *                unrelated daemon, we'd happily attach to garbage)
 *  - `meta.json` — richer record: which daemon spawned us, when, the
 *                user-data-dir we wrote into, optional tunnel PID. This
 *                is the file the orphan reaper reads on daemon startup.
 *  - `tasks.json` — open task state (managed elsewhere by service.ts)
 *
 * The one-value-per-file fields are kept for backward compat with older
 * builds; `meta.json` is additive and consulted preferentially.
 */
export interface ProfileRuntime {
  pid: number;
  port: number;
  command?: string;
  /** Full path of the user-data-dir we passed to --user-data-dir, used by the reaper to confirm. */
  userDataDir?: string;
  /** PID of the daemon that spawned this. When the daemon dies, the next one reaps. */
  daemonPid?: number;
  /** Wall-clock time of spawn — useful for diagnostics and TTL-based cleanup. */
  spawnedAt?: number;
  /** What kind of process: 'browser' (Chrome-family), 'electron' (Notion etc.), or 'tunnel' (ssh -L). */
  kind?: 'browser' | 'electron' | 'tunnel';
  /** Local ssh -L PID, if this profile is SSH-backed. Distinct from `pid` (which is the remote browser, normally 0). */
  tunnelPid?: number;
}

const PID_FILE = 'pid';
const PORT_FILE = 'port';
const COMMAND_FILE = 'command';
const META_FILE = 'meta.json';

function readNumberFile(p: string): number | null {
  try {
    const n = parseInt(fs.readFileSync(p, 'utf-8').trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function readStringFile(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Save the runtime record atomically. We write the legacy one-value-per-
 * file fields plus a JSON meta blob so future code can read either.
 * The cache directory may not exist yet (first launch); we create it.
 */
export function writeProfileRuntime(
  profileName: string,
  runtime: ProfileRuntime
): void {
  const dir = getProfileRuntimeDir(profileName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, PID_FILE), String(runtime.pid));
  fs.writeFileSync(path.join(dir, PORT_FILE), String(runtime.port));
  if (runtime.command) {
    fs.writeFileSync(path.join(dir, COMMAND_FILE), runtime.command);
  }
  const meta: ProfileRuntime = {
    ...runtime,
    daemonPid: runtime.daemonPid ?? process.pid,
    spawnedAt: runtime.spawnedAt ?? Date.now(),
  };
  fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify(meta));
}

/** Read just the JSON meta record. Returns null when absent or malformed. */
export function readProfileRuntimeMeta(profileName: string): ProfileRuntime | null {
  const dir = getProfileRuntimeDir(profileName);
  try {
    const raw = fs.readFileSync(path.join(dir, META_FILE), 'utf-8');
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null) return null;
    return obj as ProfileRuntime;
  } catch {
    return null;
  }
}

/**
 * Read the runtime triple. Returns null when the files are missing OR when
 * the recorded pid no longer points at the same process we launched —
 * stale data is auto-cleaned to keep the next caller from acting on it.
 */
export function readProfileRuntime(profileName: string): ProfileRuntime | null {
  const dir = getProfileRuntimeDir(profileName);
  const pid = readNumberFile(path.join(dir, PID_FILE));
  const port = readNumberFile(path.join(dir, PORT_FILE));
  const command = readStringFile(path.join(dir, COMMAND_FILE)) ?? undefined;

  if (pid === null || port === null) return null;

  if (!isProcessAlive(pid, command)) {
    clearProfileRuntime(profileName);
    return null;
  }

  return { pid, port, command };
}

/** Remove the pid/port/command/meta files. Leaves chrome-data + tasks.json intact. */
export function clearProfileRuntime(profileName: string): void {
  const dir = getProfileRuntimeDir(profileName);
  for (const f of [PID_FILE, PORT_FILE, COMMAND_FILE, META_FILE]) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* not present */ }
  }
}

/**
 * Recursively remove the whole profile cache (chrome-data, tasks.json,
 * everything). Used by `profiles delete` so an old profile name doesn't
 * leak its history into a freshly-recreated one.
 */
export function removeProfileCache(profileName: string): void {
  const dir = getProfileRuntimeDir(profileName);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
}

/**
 * Find every cache directory belonging to a given profile. The composite
 * naming (`<name>@<endpoint>`) means a single agents-cli profile can have
 * multiple runtime dirs side by side; this finds them all plus the legacy
 * non-composite dir from older builds.
 */
export function listProfileCacheDirs(profileName: string): string[] {
  const root = getBrowserRuntimeDir();
  if (!fs.existsSync(root)) return [];
  const matches: string[] = [];
  for (const entry of fs.readdirSync(root)) {
    if (entry === profileName) matches.push(path.join(root, entry));
    else if (entry.startsWith(`${profileName}@`)) matches.push(path.join(root, entry));
  }
  return matches;
}

/**
 * `process.kill(pid, 0)` answers "is a process with this id alive?" — but
 * pid reuse is real on long-uptime machines, and a stale cache pointing
 * at a since-reassigned pid would happily call the imposter ours.
 *
 * Strategy: if we recorded the executable basename when we launched, ask
 * `ps` what command the live pid is running and compare. No command on
 * record means we fall back to the existence check (older cache entries
 * or `pid:0` for "attached to an externally-launched browser").
 */
export function isProcessAlive(pid: number, expectedCommand?: string): boolean {
  if (pid === 0) return true;
  try {
    process.kill(pid, 0);
  } catch (err: any) {
    if (err && err.code === 'EPERM') {
      // exists but we can't signal it — count it as alive
      return !expectedCommand || matchesCommand(pid, expectedCommand);
    }
    return false;
  }
  if (!expectedCommand) return true;
  return matchesCommand(pid, expectedCommand);
}

/**
 * Snapshot of one tracked profile, suitable for `agents browser ps` output.
 * Combines the on-disk meta record with live-process probes so callers can
 * tell at a glance which entries are alive, stale, or have outright leaked.
 */
export interface ProfileSnapshot {
  /** Composite name as the cache dir is keyed: `<profile>` or `<profile>@<endpoint>`. */
  name: string;
  /** Absolute path of the cache dir. */
  dir: string;
  meta: ProfileRuntime | null;
  /** Live-process probe: does the recorded pid still exist + match command? */
  pidAlive: boolean;
  /** Live-process probe for the tunnel pid (SSH profiles). */
  tunnelAlive: boolean;
  /** True iff the daemon that started this is still alive. False == orphaned. */
  daemonAlive: boolean;
  /** Number of tasks recorded in tasks.json (open browser tabs). */
  taskCount: number;
}

/**
 * Read every profile cache directory and produce a structured snapshot.
 * Works without the daemon — `agents browser ps` uses this to render a
 * complete state view even when the IPC server is down. The caller can
 * post-process to detect conflicts (e.g. two profiles with the same port,
 * or a port someone else is listening on).
 */
export function listAllProfileSnapshots(): ProfileSnapshot[] {
  const root = getBrowserRuntimeDir();
  if (!fs.existsSync(root)) return [];
  const out: ProfileSnapshot[] = [];
  for (const name of fs.readdirSync(root).sort()) {
    const dir = path.join(root, name);
    let stat;
    try { stat = fs.statSync(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;

    const meta = readProfileRuntimeMeta(name);
    const taskCount = readTaskCount(dir);

    const pidAlive = meta ? isProcessAlive(meta.pid, meta.command) : false;
    const tunnelAlive = meta?.tunnelPid ? isProcessAlive(meta.tunnelPid, 'ssh') : false;
    const daemonAlive = meta?.daemonPid ? isProcessAlive(meta.daemonPid) : false;

    out.push({ name, dir, meta, pidAlive, tunnelAlive, daemonAlive, taskCount });
  }
  return out;
}

function readTaskCount(dir: string): number {
  try {
    const raw = fs.readFileSync(path.join(dir, 'tasks.json'), 'utf-8');
    const obj = JSON.parse(raw);
    if (Array.isArray(obj)) return obj.length;
    if (obj && typeof obj === 'object') return Object.keys(obj).length;
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Reap browser + tunnel processes spawned by daemons that no longer exist.
 * Call once on daemon startup. The idea: every process we spawn records
 * its daemonPid in meta.json. If that daemon is dead (crashed, SIGKILL),
 * its children were left rootless — kill them now so they don't hijack
 * the next session's local ports.
 *
 * We're conservative: a record with no daemonPid (older builds) is left
 * alone — we'd rather leak than wrongly kill a user-owned process that
 * happens to share metadata.
 */
export function reapOrphanedProcesses(): { reaped: number; details: string[] } {
  const root = getBrowserRuntimeDir();
  if (!fs.existsSync(root)) return { reaped: 0, details: [] };

  let reaped = 0;
  const details: string[] = [];

  for (const profileName of fs.readdirSync(root)) {
    const meta = readProfileRuntimeMeta(profileName);
    if (!meta) continue;
    if (!meta.daemonPid) continue;
    if (meta.daemonPid === process.pid) continue;
    // Owning daemon still alive — leave its kids alone.
    if (isProcessAlive(meta.daemonPid)) continue;

    // Kill what the dead daemon left behind. Best-effort.
    const kill = (pid?: number, label?: string): void => {
      if (!pid || pid === 0) return;
      // Only kill if it matches the recorded command — guards against
      // pid reuse handing us an unrelated process to murder.
      if (meta.command && !matchesCommand(pid, meta.command) &&
          !matchesCommand(pid, 'ssh')) return;
      try {
        process.kill(pid, 'SIGTERM');
        reaped++;
        details.push(`reaped ${label ?? 'pid'} ${pid} (profile ${profileName})`);
      } catch { /* already gone */ }
    };

    kill(meta.pid, 'browser');
    kill(meta.tunnelPid, 'tunnel');
    clearProfileRuntime(profileName);
  }

  return { reaped, details };
}

function matchesCommand(pid: number, expectedCommand: string): boolean {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return false;
    // Match on the basename only — `/Applications/Comet.app/Contents/MacOS/Comet`
    // vs the recorded `Comet`, vs `Google\ Chrome`. Case-insensitive.
    const live = path.basename(out).toLowerCase();
    const want = path.basename(expectedCommand).toLowerCase();
    return live === want || live.startsWith(want) || want.startsWith(live);
  } catch {
    return false;
  }
}
