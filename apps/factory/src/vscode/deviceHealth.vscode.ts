import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { DeviceStats, parseUptime, parseVmStat, parseLinuxMemInfo, isDeviceOnline } from '../core/deviceHealth';
import { RepoSyncStatus, classifySync } from '../core/repoSync';
import { resolveAgentsBin, bootstrapPath } from '../core/agentsBin';
import { createTimedCache, cachedInFlight } from '../core/cachedInFlight';

const execFileAsync = promisify(execFile);

// A registered device, sourced live from `agents devices list --json`.
export interface Device {
  name: string;
  host: string;
  platform?: string;
  online?: boolean;
  registeredAt: number;
}

/**
 * The minimal device shape the fleet sweep actually reads (name + address +
 * reachability). Both `Device` and the persisted `HostPickerDevice` satisfy it,
 * so the host-picker cache can drive a usage sweep without carrying the full
 * registry row.
 */
export type DeviceRef = Pick<Device, 'name' | 'host' | 'online'>;

interface AgentsDeviceEntry {
  name: string;
  platform?: string;
  address?: { via?: string; dnsName?: string; ip?: string };
  tailscale?: { online?: boolean };
  createdAt?: string;
}

// Source the device fleet from the canonical agents-cli registry
// (`agents devices`, self-populated from Tailscale) rather than a hand-rolled
// file. Online status is derived by isDeviceOnline (matching the CLI: a missing
// tailscale block is NOT offline), and the SSH address from address.dnsName.
export async function listRegisteredDevices(): Promise<Device[]> {
  try {
    const bin = await resolveAgentsBin();
    // 20s, not 8s: on a loaded box the CLI's per-run startup alone can exceed
    // 8s. The host picker's render path never waits on this (it renders from
    // the persisted snapshot and refreshes in the background); cold-start
    // callers like the browse-device switcher and balanced-launch still await
    // it directly, so the timeout stays bounded rather than removed.
    const { stdout } = await execFileAsync(bin, ['devices', 'list', '--json'], {
      timeout: 20_000,
      env: augmentedEnv(bin),
    });
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as AgentsDeviceEntry[]).map((d) => ({
      name: d.name,
      host: d.address?.dnsName || d.name,
      platform: d.platform,
      online: isDeviceOnline(d.tailscale),
      registeredAt: d.createdAt ? Date.parse(d.createdAt) || 0 : 0,
    }));
  } catch {
    return [];
  }
}

const CACHE_TTL_MS = 6_000;
const PROBE_TIMEOUT_MS = 4_000;

// Both fleet probes coalesce concurrent + repeated calls per host through the
// shared cachedInFlight guard, so N uncoordinated callers (the launch-health
// timer, the Dispatch panel, each launch) never each spawn a full-fleet fan-out
// of `agents` subprocesses for the same host.
const statsStore = createTimedCache<DeviceStats>();
const agentCountStore = createTimedCache<number>();

function augmentedEnv(binPath: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${bootstrapPath(binPath)}:${process.env.PATH ?? ''}` };
}

function isLocalHost(host: string): boolean {
  return host === 'this-mac' || host === 'localhost' || host === '';
}

export async function probeReachable(host: string): Promise<boolean> {
  if (isLocalHost(host)) return true;
  try {
    const bin = await resolveAgentsBin();
    await execFileAsync(bin, ['ssh', host, '--', 'true'], {
      timeout: PROBE_TIMEOUT_MS,
      env: augmentedEnv(bin),
    });
    return true;
  } catch {
    return false;
  }
}

export async function fetchDeviceStats(
  host: string,
  opts: { isLocal: boolean },
): Promise<DeviceStats> {
  return cachedInFlight(statsStore, host, CACHE_TTL_MS, () => fetchDeviceStatsOnce(host, opts));
}

async function fetchDeviceStatsOnce(
  host: string,
  opts: { isLocal: boolean },
): Promise<DeviceStats> {
  const fetchedAt = Date.now();
  if (opts.isLocal) {
    try {
      const loadAvg1 = os.loadavg()[0];
      const { stdout } = await execFileAsync('vm_stat', [], { timeout: 3_000 });
      const mem = parseVmStat(stdout);
      return { host, reachable: true, loadAvg1, ...mem, fetchedAt };
    } catch {
      return { host, reachable: true, fetchedAt };
    }
  }
  try {
    const bin = await resolveAgentsBin();
    const { stdout } = await execFileAsync(bin, ['ssh', host, '--', 'uptime; echo ---SEP---; (vm_stat || cat /proc/meminfo)'], {
      timeout: PROBE_TIMEOUT_MS,
      env: augmentedEnv(bin),
    });
    const parts = stdout.split('---SEP---');
    const uptimePart = parts[0] ?? '';
    const memPart = parts[1] ?? '';
    const load = parseUptime(uptimePart);
    let mem = parseVmStat(memPart);
    if (mem.memPercent === undefined) mem = parseLinuxMemInfo(memPart);
    return { host, reachable: true, ...load, ...mem, fetchedAt };
  } catch {
    return { host, reachable: false, fetchedAt };
  }
}

export async function countRunningAgents(host: string, opts: { isLocal: boolean }): Promise<number> {
  return cachedInFlight(agentCountStore, host, CACHE_TTL_MS, () => countRunningAgentsOnce(host, opts));
}

async function countRunningAgentsOnce(host: string, opts: { isLocal: boolean }): Promise<number> {
  try {
    const bin = await resolveAgentsBin();
    const args = ['sessions', '--active', '--json'];
    if (!opts.isLocal) args.push('--host', host);
    const { stdout } = await execFileAsync(bin, args, {
      timeout: opts.isLocal ? 6_000 : 10_000,
      env: augmentedEnv(bin),
    });
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Assign the project path to $P on the remote, expanding a leading ~ against
// the remote $HOME (which the extension can't know locally).
function pathAssign(projectPath: string): string {
  if (projectPath === '~') return 'P="$HOME"';
  if (projectPath.startsWith('~/')) return `P="$HOME/"${sq(projectPath.slice(2))}`;
  return `P=${sq(projectPath)}`;
}

// Sync status for a repo AS IT EXISTS ON THE DEVICE (not the local mac). A repo
// that isn't cloned there is a first-class state ('missing') — the dispatch
// policy clones it. Runs a single shell snippet locally or over SSH.
export async function getDeviceSyncStatus(
  host: string,
  projectPath: string,
  opts: { isLocal: boolean },
): Promise<RepoSyncStatus> {
  const empty: RepoSyncStatus = { root: projectPath, state: 'unknown', ahead: 0, behind: 0, dirty: false, defaultBranch: '' };
  if (!projectPath) return empty;
  const snippet =
    `${pathAssign(projectPath)}; ` +
    `if [ ! -d "$P/.git" ]; then echo MISSING; exit 0; fi; ` +
    `cd "$P" || { echo MISSING; exit 0; }; ` +
    `git fetch origin -q 2>/dev/null || true; ` +
    `DEF=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##'); ` +
    `if [ -z "$DEF" ]; then echo UNKNOWN; exit 0; fi; ` +
    `D=0; [ -n "$(git status --porcelain)" ] && D=1; ` +
    `set -- $(git rev-list --left-right --count "origin/$DEF...HEAD" 2>/dev/null); ` +
    `echo "OK $DEF \${1:-0} \${2:-0} $D"`;
  try {
    let stdout: string;
    if (opts.isLocal) {
      ({ stdout } = await execFileAsync('/bin/sh', ['-lc', snippet], { timeout: 20_000 }));
    } else {
      const bin = await resolveAgentsBin();
      ({ stdout } = await execFileAsync(bin, ['ssh', host, '--', `bash -lc ${sq(snippet)}`], {
        timeout: 25_000,
        env: augmentedEnv(bin),
      }));
    }
    const line = stdout.trim().split('\n').pop() ?? '';
    if (line.startsWith('MISSING')) return { ...empty, state: 'missing' };
    if (line.startsWith('OK')) {
      const [, def, behindStr, aheadStr, dirtyStr] = line.split(/\s+/);
      const behind = parseInt(behindStr, 10) || 0;
      const ahead = parseInt(aheadStr, 10) || 0;
      const dirty = dirtyStr === '1';
      return { root: projectPath, state: classifySync({ ahead, behind, dirty }), ahead, behind, dirty, defaultBranch: def || '' };
    }
    return empty;
  } catch {
    return empty;
  }
}
