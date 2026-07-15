/**
 * Fleet-wide device operations — pick online targets and run a command on each.
 *
 * Used by `agents fleet update` / `agents fleet run` (aliases of the same
 * subcommands under `agents devices`). Offline devices are skipped with a
 * reason so a single dead node never blocks the rest of the rollout.
 */

import { spawnSync } from 'child_process';
import { machineId } from '../session/sync/config.js';
import type { DeviceProfile, DeviceRegistry } from './registry.js';
import { buildSshInvocation, sshTargetFor, writeAskpassShim } from './connect.js';

export type FleetSkipReason = 'offline' | 'no-address' | 'self-local';

export interface FleetTarget {
  device: DeviceProfile;
  /** When set, this device is not reached (skip with reason). */
  skip?: FleetSkipReason;
}

export interface FleetRunResult {
  name: string;
  status: 'ok' | 'failed' | 'skipped';
  code: number | null;
  reason?: FleetSkipReason | string;
  /** Truncated combined stderr/stdout for failures. */
  detail?: string;
}

/**
 * Classify each registered device for a fleet operation.
 *
 * - Tailscale-offline → skip `offline`
 * - No address → skip `no-address`
 * - This machine (`machineId`) is included as a normal target when it has an
 *   address (remote path); callers that want a local-spawn path can detect
 *   `name === machineId()` themselves. We do **not** skip self by default —
 *   rolling the CLI out to "every box including this one" is the common case.
 */
export function planFleetTargets(reg: DeviceRegistry): FleetTarget[] {
  const names = Object.keys(reg).sort();
  return names.map((name) => {
    const device = reg[name];
    if (device.tailscale && !device.tailscale.online) {
      return { device, skip: 'offline' as const };
    }
    try {
      sshTargetFor(device);
    } catch {
      return { device, skip: 'no-address' as const };
    }
    return { device };
  });
}

/** Human label for a skip reason. */
export function skipLabel(reason: FleetSkipReason): string {
  switch (reason) {
    case 'offline':
      return 'offline';
    case 'no-address':
      return 'no address';
    case 'self-local':
      return 'this machine';
  }
}

/**
 * Run `cmd` on one device via the same ssh path as `agents ssh <name> …`.
 * Captures stdout/stderr (not inherited) so the fleet table can summarize.
 */
export function runOnDevice(
  device: DeviceProfile,
  cmd: string[],
  opts: { timeoutMs?: number } = {},
): { code: number | null; stdout: string; stderr: string } {
  const shim = writeAskpassShim();
  const { args, env } = buildSshInvocation(device, cmd, shim);
  const res = spawnSync('ssh', args, {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    timeout: opts.timeoutMs ?? 600_000,
  });
  return {
    code: res.status,
    stdout: res.stdout?.toString() ?? '',
    stderr: (res.stderr?.toString() ?? '') + (res.error ? String(res.error.message) : ''),
  };
}

/** Run `agents upgrade --yes` (or a pin) on a device. */
export function upgradeCommand(version?: string): string[] {
  return version
    ? ['agents', 'upgrade', version, '--yes']
    : ['agents', 'upgrade', '--yes'];
}

/**
 * Execute a command across planned targets. Pure orchestration over
 * {@link runOnDevice}; testable by injecting `runner`.
 */
export function runFleet(
  targets: FleetTarget[],
  cmd: string[],
  runner: typeof runOnDevice = runOnDevice,
): FleetRunResult[] {
  const results: FleetRunResult[] = [];
  for (const t of targets) {
    if (t.skip) {
      results.push({
        name: t.device.name,
        status: 'skipped',
        code: null,
        reason: t.skip,
      });
      continue;
    }
    const res = runner(t.device, cmd);
    const ok = res.code === 0;
    const detail = (res.stderr || res.stdout).trim().slice(0, 200);
    results.push({
      name: t.device.name,
      status: ok ? 'ok' : 'failed',
      code: res.code,
      detail: ok ? undefined : detail || undefined,
    });
  }
  return results;
}

/** Whether this process is running on `name` (local machine). Exported for tests. */
export function isLocalDevice(name: string): boolean {
  return name === machineId();
}
