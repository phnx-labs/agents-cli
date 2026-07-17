/**
 * Fleet-wide device operations — pick online targets and run a command on each.
 *
 * Used by `agents fleet update` / `agents fleet run` (aliases of the same
 * subcommands under `agents devices`). Offline devices are skipped with a
 * reason so a single dead node never blocks the rest of the rollout. Per-device
 * throws (misconfigured auth, etc.) become `failed` rows — they never abort
 * the remaining devices.
 */

import { spawnSync } from 'child_process';
import { isControlDevice, type DeviceProfile, type DeviceRegistry } from './registry.js';
import { buildSshInvocation, sshTargetFor, writeAskpassShim } from './connect.js';

export type FleetSkipReason = 'offline' | 'no-address' | 'control';

/** npm dist-tags / semver pins only — rejects shell metacharacters. */
export const FLEET_VERSION_RE = /^[A-Za-z0-9._-]+$/;

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
 * - Control-only device (a cockpit, e.g. a paired iPhone) → skip `control`
 * - Tailscale-offline → skip `offline`
 * - No address → skip `no-address`
 * - Everything else is a target (including this machine, reached over ssh when
 *   it has a registry address — same path as any other box).
 */
export function planFleetTargets(reg: DeviceRegistry): FleetTarget[] {
  const names = Object.keys(reg).sort();
  return names.map((name) => {
    const device = reg[name];
    // A control device drives the fleet but never runs agents — never a target
    // for update/run/stats, whatever its platform reads as.
    if (isControlDevice(device)) {
      return { device, skip: 'control' as const };
    }
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
    case 'control':
      return 'control device';
  }
}

/**
 * Run `cmd` on one device via the same ssh path as `agents ssh <name> …`.
 * Captures stdout/stderr (not inherited) so the fleet table can summarize.
 * Throws from buildSshInvocation are returned as a non-zero result so a single
 * misconfigured device cannot abort the fleet loop.
 */
export function runOnDevice(
  device: DeviceProfile,
  cmd: string[],
  opts: { timeoutMs?: number } = {},
): { code: number | null; stdout: string; stderr: string } {
  try {
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
  } catch (err) {
    return {
      code: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Build `agents upgrade --yes` argv, optionally pinned to a version/dist-tag.
 * Rejects anything that is not a plain npm version/tag token so a version pin
 * cannot inject shell metacharacters into the remote command line.
 */
export function upgradeCommand(version?: string): string[] {
  if (version !== undefined && version !== '') {
    if (!FLEET_VERSION_RE.test(version)) {
      throw new Error(
        `Invalid version '${version}'. Use a semver or dist-tag (letters, digits, . _ - only).`,
      );
    }
    return ['agents', 'upgrade', version, '--yes'];
  }
  return ['agents', 'upgrade', '--yes'];
}

/**
 * Execute a command across planned targets. Pure orchestration over
 * {@link runOnDevice}; testable by injecting `runner`. Per-device throws from
 * the runner are recorded as `failed` so one bad device never aborts the rest.
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
    try {
      const res = runner(t.device, cmd);
      const ok = res.code === 0;
      const detail = (res.stderr || res.stdout).trim().slice(0, 200);
      results.push({
        name: t.device.name,
        status: ok ? 'ok' : 'failed',
        code: res.code,
        detail: ok ? undefined : detail || undefined,
      });
    } catch (err) {
      results.push({
        name: t.device.name,
        status: 'failed',
        code: 1,
        detail: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
    }
  }
  return results;
}
