/**
 * Device resource probing for `agents devices list`.
 *
 * One SSH round-trip per device gathers load average, memory pressure, and core
 * count (mac + linux via a POSIX snippet, windows via a CIM one-liner), parsed
 * into a {@link DeviceStats}. Probes run in parallel with a bounded timeout so
 * the list stays responsive — a slow or hung box degrades to "no stats" instead
 * of blocking the whole table.
 *
 * The parsers are pure and unit-tested (health.test.ts). They mirror the ones in
 * the Factory extension (apps/factory/src/core/deviceHealth.ts) — kept as a
 * separate copy on purpose: the CLI does not import across packages.
 */

import { execFile } from 'child_process';
import type { DeviceProfile } from './registry.js';
import { buildSshInvocation, writeAskpassShim } from './connect.js';

/** Default per-device probe budget. Short enough that the list never hangs on a
 * wedged box, long enough for a cold relayed SSH handshake. */
export const PROBE_TIMEOUT_MS = 2_500;

/** Windows probe budget. The first CIM query of a PowerShell session pays a
 * "Preparing modules for first use" cost on top of PowerShell startup, which
 * routinely blows the 2.5s POSIX budget on a relayed connection. */
export const WIN_PROBE_TIMEOUT_MS = 6_000;

const SEP = '---AGSTAT---';
/** One-shot remote snapshot: load, then memory (mac vm_stat else linux
 * meminfo), then core count (linux nproc else mac hw.ncpu). */
const PROBE_SNIPPET = `uptime; echo ${SEP}; (vm_stat 2>/dev/null || cat /proc/meminfo 2>/dev/null); echo ${SEP}; (nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null)`;

/** Windows equivalent, one labeled line via CIM. PowerShell 5.1-safe: no `||`
 * chaining, plain string concatenation. `LoadPercentage` is $null on some
 * hosts/VMs, which concatenates to an empty field — the parser treats that as
 * "no load signal" and headroom falls back to memory pressure alone.
 * wrapRemoteCommand base64-encodes this for powershell-shell devices, so the
 * quoting survives ssh intact. */
const WIN_PROBE_SNIPPET = `$os = Get-CimInstance Win32_OperatingSystem; $cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; Write-Output ('AGWINSTAT load=' + $cpu + ' freeKb=' + $os.FreePhysicalMemory + ' totalKb=' + $os.TotalVisibleMemorySize + ' ncpu=' + $env:NUMBER_OF_PROCESSORS)`;

export interface DeviceStats {
  host: string;
  reachable: boolean;
  loadAvg1?: number;
  ncpu?: number;
  /** Load normalized to core count (the "has room" number): loadAvg1 / ncpu *
   * 100 on mac/linux, CPU utilization % directly on windows (no loadAvg1). */
  loadPercent?: number;
  memPercent?: number;
  memTotalBytes?: number;
  memFreeBytes?: number;
  fetchedAt: number;
}

/** Compact human byte size: 512M, 64G, 1.5T (binary units, ≤1 decimal). */
export function fmtBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'K', 'M', 'G', 'T', 'P'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const s = v >= 100 || i <= 1 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, '');
  return `${s}${units[i]}`;
}

export function parseUptime(out: string): { loadAvg1?: number } {
  const m = out.match(/load average[s]?:\s*([0-9]+[.,][0-9]+|[0-9]+)/i);
  if (!m) return {};
  const v = parseFloat(m[1].replace(',', '.'));
  if (!Number.isFinite(v)) return {};
  return { loadAvg1: v };
}

interface MemStats {
  memPercent?: number;
  memTotalBytes?: number;
  memFreeBytes?: number;
}

export function parseVmStat(out: string): MemStats {
  const pageSize = parseInt(out.match(/page size of\s+([0-9]+)\s+bytes/)?.[1] ?? '4096', 10);
  const active = out.match(/Pages active:\s+([0-9]+)/);
  const wired = out.match(/Pages wired down:\s+([0-9]+)/);
  const compressed = out.match(/Pages occupied by compressor:\s+([0-9]+)/);
  const free = out.match(/Pages free:\s+([0-9]+)/);
  if (!active || !wired || !compressed || !free) return {};
  // macOS reclaims inactive + speculative pages on demand, so they count as
  // available — folding them into "free" (as Activity Monitor / vm_pressure do)
  // rather than "used" keeps the headroom bucket honest on a Mac.
  const inactive = out.match(/Pages inactive:\s+([0-9]+)/);
  const speculative = out.match(/Pages speculative:\s+([0-9]+)/);
  const usedPages = parseInt(active[1], 10) + parseInt(wired[1], 10) + parseInt(compressed[1], 10);
  const freePages =
    parseInt(free[1], 10) +
    parseInt(inactive?.[1] ?? '0', 10) +
    parseInt(speculative?.[1] ?? '0', 10);
  const totalPages = usedPages + freePages;
  if (totalPages <= 0) return {};
  return {
    memPercent: (usedPages / totalPages) * 100,
    memTotalBytes: totalPages * pageSize,
    memFreeBytes: freePages * pageSize,
  };
}

export function parseLinuxMemInfo(out: string): MemStats {
  const total = out.match(/^MemTotal:\s+([0-9]+)/im);
  const available = out.match(/^MemAvailable:\s+([0-9]+)/im);
  if (!total || !available) return {};
  const tKb = parseInt(total[1], 10);
  const aKb = parseInt(available[1], 10);
  if (tKb <= 0) return {};
  return {
    memPercent: Math.max(0, Math.min(100, ((tKb - aKb) / tKb) * 100)),
    memTotalBytes: tKb * 1024,
    memFreeBytes: aKb * 1024,
  };
}

export function parseNcpu(out: string): { ncpu?: number } {
  const n = parseInt(out.trim().split(/\s+/)[0] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? { ncpu: n } : {};
}

/** Assemble a DeviceStats from the three snippet sections. */
export function parseProbeOutput(host: string, stdout: string, fetchedAt: number): DeviceStats {
  const [uptimePart = '', memPart = '', ncpuPart = ''] = stdout.split(SEP);
  const { loadAvg1 } = parseUptime(uptimePart);
  const mem = memPart.includes('MemTotal') ? parseLinuxMemInfo(memPart) : parseVmStat(memPart);
  const { ncpu } = parseNcpu(ncpuPart);
  const loadPercent =
    loadAvg1 !== undefined && ncpu ? (loadAvg1 / ncpu) * 100 : undefined;
  return {
    host,
    reachable: true,
    loadAvg1,
    ncpu,
    loadPercent,
    memPercent: mem.memPercent,
    memTotalBytes: mem.memTotalBytes,
    memFreeBytes: mem.memFreeBytes,
    fetchedAt,
  };
}

/** Assemble a DeviceStats from the windows one-liner. A missing marker line
 * (e.g. CIM unavailable) keeps `reachable: true` — ssh answered — with no
 * numbers, mirroring how garbage POSIX output degrades. */
export function parseWinProbeOutput(host: string, stdout: string, fetchedAt: number): DeviceStats {
  const m = stdout.match(/AGWINSTAT load=([0-9.]*) freeKb=([0-9]+) totalKb=([0-9]+) ncpu=([0-9]+)/);
  if (!m) return { host, reachable: true, fetchedAt };
  const loadPercent = m[1] === '' ? undefined : parseFloat(m[1]);
  const freeKb = parseInt(m[2], 10);
  const totalKb = parseInt(m[3], 10);
  const ncpu = parseInt(m[4], 10);
  return {
    host,
    reachable: true,
    ncpu: Number.isFinite(ncpu) && ncpu > 0 ? ncpu : undefined,
    loadPercent: loadPercent !== undefined && Number.isFinite(loadPercent) ? loadPercent : undefined,
    memPercent: totalKb > 0 ? Math.max(0, Math.min(100, ((totalKb - freeKb) / totalKb) * 100)) : undefined,
    memTotalBytes: totalKb > 0 ? totalKb * 1024 : undefined,
    memFreeBytes: totalKb > 0 ? freeKb * 1024 : undefined,
    fetchedAt,
  };
}

export interface FleetCapacity {
  reachable: number;
  cores: number;
  memTotalBytes: number;
  memFreeBytes: number;
}

/** Sum cores and memory across reachable devices for the summary footer. */
export function fleetCapacity(statsList: Iterable<DeviceStats>): FleetCapacity {
  const cap: FleetCapacity = { reachable: 0, cores: 0, memTotalBytes: 0, memFreeBytes: 0 };
  for (const s of statsList) {
    if (!s.reachable) continue;
    cap.reachable++;
    cap.cores += s.ncpu ?? 0;
    cap.memTotalBytes += s.memTotalBytes ?? 0;
    cap.memFreeBytes += s.memFreeBytes ?? 0;
  }
  return cap;
}

/** Headroom bucket from the worst of normalized-load and memory. */
export type Headroom = 'idle' | 'light' | 'busy' | 'loaded' | 'unknown';

export function headroom(stats: DeviceStats | undefined): Headroom {
  if (!stats || !stats.reachable) return 'unknown';
  const signals = [stats.loadPercent, stats.memPercent].filter(
    (v): v is number => typeof v === 'number',
  );
  if (signals.length === 0) return 'unknown';
  const worst = Math.max(...signals);
  if (worst < 15) return 'idle';
  if (worst < 40) return 'light';
  if (worst < 75) return 'busy';
  return 'loaded';
}

/** Probe one device over the same ssh path as `agents ssh <name>`. Never throws;
 * an unreachable/slow/misconfigured device resolves to `reachable: false`. */
export function probeDeviceStats(
  device: DeviceProfile,
  opts: { timeoutMs?: number; now?: number } = {},
): Promise<DeviceStats> {
  const host = device.name;
  const fetchedAt = opts.now ?? Date.now();
  const isWin = device.shell === 'powershell';
  let args: string[];
  let env: Record<string, string>;
  try {
    const shim = writeAskpassShim();
    // buildSshInvocation joins the cmd with spaces and hands the string to the
    // remote login shell, which evaluates the snippet's `;`/`||` directly — no
    // `sh -c` wrapper needed (and a wrapper would only re-quote the first token).
    // For powershell devices it base64-encodes the snippet instead.
    ({ args, env } = buildSshInvocation(device, [isWin ? WIN_PROBE_SNIPPET : PROBE_SNIPPET], shim));
  } catch {
    return Promise.resolve({ host, reachable: false, fetchedAt });
  }
  return new Promise<DeviceStats>((resolve) => {
    execFile(
      'ssh',
      args,
      {
        encoding: 'utf-8',
        env: { ...process.env, ...env },
        timeout: opts.timeoutMs ?? (isWin ? WIN_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS),
      },
      (err, stdout) => {
        if (err || !stdout) return resolve({ host, reachable: false, fetchedAt });
        resolve(isWin ? parseWinProbeOutput(host, stdout, fetchedAt) : parseProbeOutput(host, stdout, fetchedAt));
      },
    );
  });
}

/** Probe the local machine directly (no ssh round-trip) — used for the "this
 * machine" row so it always shows real numbers even if it isn't ssh-reachable
 * from itself. */
export function probeLocalStats(
  host: string,
  opts: { timeoutMs?: number; now?: number } = {},
): Promise<DeviceStats> {
  const fetchedAt = opts.now ?? Date.now();
  const isWin = process.platform === 'win32';
  return new Promise<DeviceStats>((resolve) => {
    execFile(
      isWin ? 'powershell' : 'sh',
      isWin ? ['-NoProfile', '-Command', WIN_PROBE_SNIPPET] : ['-c', PROBE_SNIPPET],
      { encoding: 'utf-8', timeout: opts.timeoutMs ?? (isWin ? WIN_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS) },
      (err, stdout) => {
        if (err || !stdout) return resolve({ host, reachable: false, fetchedAt });
        resolve(isWin ? parseWinProbeOutput(host, stdout, fetchedAt) : parseProbeOutput(host, stdout, fetchedAt));
      },
    );
  });
}

/** Probe many devices concurrently; returns a name→stats map. Bounded by the
 * per-probe timeout, so total wall time ≈ the slowest single probe. The device
 * named `selfName` is probed locally instead of over ssh. */
export async function probeFleetStats(
  devices: DeviceProfile[],
  opts: { timeoutMs?: number; selfName?: string } = {},
): Promise<Map<string, DeviceStats>> {
  const entries = await Promise.all(
    devices.map(async (d) => {
      const stats =
        d.name === opts.selfName
          ? await probeLocalStats(d.name, opts)
          : await probeDeviceStats(d, opts);
      return [d.name, stats] as const;
    }),
  );
  return new Map(entries);
}
