import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { DeviceStats, parseUptime, parseVmStat, parseLinuxMemInfo } from '../core/deviceHealth';
import { RepoSyncStatus, classifySync } from '../core/repoSync';
import { resolveAgentsBin, bootstrapPath } from '../core/agentsBin';

const execFileAsync = promisify(execFile);

// A registered device, sourced live from `agents devices list --json`.
export interface Device {
  name: string;
  host: string;
  secretRef?: string;
  user?: string;
  platform?: string;
  online?: boolean;
  registeredAt: number;
}

interface AgentsDeviceEntry {
  name: string;
  platform?: string;
  user?: string;
  address?: { via?: string; dnsName?: string; ip?: string };
  auth?: { method?: string; bundle?: string; bundleKey?: string };
  tailscale?: { online?: boolean };
  createdAt?: string;
}

// Source the device fleet from the canonical agents-cli registry
// (`agents devices`, self-populated from Tailscale) rather than a hand-rolled
// file. Online status comes from tailscale.online, the credential bundle from
// auth.bundle, and the SSH address from address.dnsName.
export async function listRegisteredDevices(): Promise<Device[]> {
  try {
    const bin = await resolveAgentsBin();
    const { stdout } = await execFileAsync(bin, ['devices', 'list', '--json'], {
      timeout: 8_000,
      env: augmentedEnv(bin),
    });
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as AgentsDeviceEntry[]).map((d) => ({
      name: d.name,
      host: d.address?.dnsName || d.name,
      user: d.user,
      secretRef: d.auth?.bundle,
      platform: d.platform,
      online: d.tailscale?.online ?? false,
      registeredAt: d.createdAt ? Date.parse(d.createdAt) || 0 : 0,
    }));
  } catch {
    return [];
  }
}

const CACHE_TTL_MS = 6_000;
const PROBE_TIMEOUT_MS = 4_000;

const cache = new Map<string, { stats: DeviceStats; fetchedAt: number }>();
const inFlight = new Map<string, Promise<DeviceStats>>();

type SecretsFormat = 'json' | 'shell' | 'unknown';

interface SecretsReadCmd {
  base: string[];
  flags: string[];
  format: SecretsFormat;
}

let secretsReadCmdCache: SecretsReadCmd | null | undefined;

function augmentedEnv(binPath: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${bootstrapPath(binPath)}:${process.env.PATH ?? ''}` };
}

function isLocalHost(host: string): boolean {
  return host === 'this-mac' || host === 'localhost' || host === '';
}

export async function probeReachable(host: string): Promise<boolean> {
  if (isLocalHost(host)) return true;
  try {
    await execFileAsync(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', '-o', 'StrictHostKeyChecking=accept-new', '--', host, 'true'],
      { timeout: PROBE_TIMEOUT_MS },
    );
    return true;
  } catch {
    return false;
  }
}

export async function fetchDeviceStats(
  host: string,
  opts: { isLocal: boolean; identityFile?: string; user?: string },
): Promise<DeviceStats> {
  const now = Date.now();
  const cached = cache.get(host);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.stats;
  const existing = inFlight.get(host);
  if (existing) return existing;
  const promise = fetchDeviceStatsOnce(host, opts);
  inFlight.set(host, promise);
  try {
    const stats = await promise;
    cache.set(host, { stats, fetchedAt: stats.fetchedAt });
    return stats;
  } finally {
    inFlight.delete(host);
  }
}

async function fetchDeviceStatsOnce(
  host: string,
  opts: { isLocal: boolean; identityFile?: string; user?: string },
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
  const target = opts.user ? `${opts.user}@${host}` : host;
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', '-o', 'StrictHostKeyChecking=accept-new'];
  if (opts.identityFile) args.push('-i', opts.identityFile);
  args.push('--', target, 'uptime; echo ---SEP---; (vm_stat || cat /proc/meminfo)');
  try {
    const { stdout } = await execFileAsync('ssh', args, { timeout: PROBE_TIMEOUT_MS });
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

export async function resolveSecret(secretRef: string): Promise<{ user?: string; identityFile?: string }> {
  try {
    const bin = await resolveAgentsBin();
    const cmd = await discoverSecretsReadCmd();
    if (!cmd) return {};
    const args = [...cmd.base, secretRef, ...cmd.flags];
    const { stdout } = await execFileAsync(bin, args, { timeout: 15_000, env: augmentedEnv(bin) });
    const entries = parseSecretsOutput(stdout, cmd.format);
    return extractCredentials(entries);
  } catch {
    return {};
  }
}

async function discoverSecretsReadCmd(): Promise<SecretsReadCmd | null> {
  if (secretsReadCmdCache !== undefined) return secretsReadCmdCache ?? null;
  try {
    const bin = await resolveAgentsBin();
    const { stdout } = await execFileAsync(bin, ['secrets', '--help'], {
      timeout: 5_000,
      env: augmentedEnv(bin),
    });
    const lower = stdout.toLowerCase();
    if (lower.includes('export')) {
      const { stdout: exportHelp } = await execFileAsync(bin, ['secrets', 'export', '--help'], {
        timeout: 5_000,
        env: augmentedEnv(bin),
      });
      const exportLower = exportHelp.toLowerCase();
      if (exportLower.includes('--plaintext') && exportLower.includes('--format')) {
        secretsReadCmdCache = { base: ['secrets', 'export'], flags: ['--plaintext', '--format', 'json'], format: 'json' };
        return secretsReadCmdCache;
      }
      if (exportLower.includes('--plaintext')) {
        secretsReadCmdCache = { base: ['secrets', 'export'], flags: ['--plaintext'], format: 'shell' };
        return secretsReadCmdCache;
      }
    }
    if (lower.includes('view')) {
      secretsReadCmdCache = { base: ['secrets', 'view'], flags: ['--reveal', '--plaintext'], format: 'unknown' };
      return secretsReadCmdCache;
    }
    secretsReadCmdCache = null;
    return null;
  } catch {
    secretsReadCmdCache = null;
    return null;
  }
}

function parseSecretsOutput(stdout: string, format: SecretsFormat): Record<string, string> {
  if (format === 'json') {
    try {
      const parsed = JSON.parse(stdout);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, string>;
    } catch {
      // fall through to shell-line parsing
    }
  }
  const entries: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key) entries[key] = value;
    }
  }
  return entries;
}

function extractCredentials(entries: Record<string, string>): { user?: string; identityFile?: string } {
  const keys = Object.keys(entries);
  const userKey = keys.find((k) => /user/i.test(k) && !/key/i.test(k));
  const keyKey =
    keys.find((k) => /private.*key|identity.*file|ssh.*key/i.test(k)) ??
    keys.find((k) => /key/i.test(k) && !/api|token|password/i.test(k));
  const user = userKey ? entries[userKey] : undefined;
  let identityFile: string | undefined;
  if (keyKey) identityFile = materializeKey(entries[keyKey]);
  return { user, identityFile };
}

function materializeKey(value: string): string {
  if ((value.startsWith('/') || value.startsWith('~/')) && !value.includes('-----BEGIN')) {
    return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  }
  const tmpDir = path.join(os.homedir(), '.agents', '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  // Content-addressed name so repeated resolves overwrite one file per key
  // instead of dropping a fresh plaintext copy on every panel open / dispatch.
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 16);
  const tmpPath = path.join(tmpDir, `ssh-key-${digest}`);
  fs.writeFileSync(tmpPath, value, { mode: 0o600 });
  return tmpPath;
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
  opts: { isLocal: boolean; identityFile?: string; user?: string },
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
      const target = opts.user ? `${opts.user}@${host}` : host;
      const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new'];
      if (opts.identityFile) args.push('-i', opts.identityFile);
      // `--` guards a host/user starting with '-'; login shell so git resolves.
      args.push('--', target, `bash -lc ${sq(snippet)}`);
      ({ stdout } = await execFileAsync('ssh', args, { timeout: 25_000 }));
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
