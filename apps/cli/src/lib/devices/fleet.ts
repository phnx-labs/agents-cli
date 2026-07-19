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

export interface FanOutDeviceTarget {
  name: string;
  skip?: FleetSkipReason | string;
}

export interface FanOutDeviceResult<T> {
  name: string;
  status: 'ok' | 'failed' | 'skipped';
  value?: T;
  error?: string;
  reason?: FleetSkipReason | string;
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

/**
 * Remote fan-out targets for the fleet health/drift gates (`fleet status`,
 * `check --devices`): every planned device except this machine and control-only
 * cockpits. A control device never runs agents (mirrors doctor's fan-out, which
 * drops it via `isControlDevice`), so counting it as unreachable/drift would make
 * the CI gate fail on every run for a fleet that merely has a cockpit registered.
 * Offline / no-address devices are kept — those are genuine faults a gate should
 * surface — so their `skip` reason still flows through as an `unreachable` row.
 */
export function remoteFleetTargets(planned: FleetTarget[], self: string): FleetTarget[] {
  return planned.filter((t) => t.device.name !== self && t.skip !== 'control');
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
 * Run `cmd` on THIS machine directly — no ssh. Used by {@link runFleet} for the
 * self target: a box frequently can't ssh to itself (no self-authorized key, as
 * `agents fleet update` hit trying to reach zion from zion) and doesn't need to —
 * `agents upgrade` etc. runs identically as a local process. Mirrors
 * {@link runOnDevice}'s return shape and never throws. The argv is space-joined
 * and evaluated by a shell — matching the POSIX-shell ssh path (so PATH-resolved
 * `agents`, quoting, and `;`/`&&` behave the same). It does NOT replicate the
 * powershell-device encoding runOnDevice uses (`connect.ts` base64 path): a
 * Windows self runs under the default OS shell (cmd.exe), which still resolves
 * `agents` on PATH for the only self commands that matter (`agents upgrade …`).
 */
export function runLocalCommand(
  cmd: string[],
  opts: { timeoutMs?: number } = {},
): { code: number | null; stdout: string; stderr: string } {
  try {
    const res = spawnSync(cmd.join(' '), {
      shell: true,
      encoding: 'utf-8',
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

export interface RunFleetOptions {
  /**
   * Name of THIS machine. Its target runs the command **locally** (no ssh) — a
   * box can't reliably ssh to itself and doesn't need to. Omit to ssh every
   * target (the old behaviour). Callers pass `machineId()`.
   */
  self?: string;
  /** Injectable ssh runner (tests). */
  runner?: typeof runOnDevice;
  /** Injectable local runner (tests). */
  localRunner?: typeof runLocalCommand;
}

/**
 * Execute a command across planned targets. Pure orchestration over
 * {@link runOnDevice} / {@link runLocalCommand}; testable by injecting either.
 * The `self` target runs locally so `agents fleet update` upgrades this machine
 * too instead of failing to ssh to itself. Per-device throws from a runner are
 * recorded as `failed` so one bad device never aborts the rest.
 */
export function runFleet(
  targets: FleetTarget[],
  cmd: string[],
  opts: RunFleetOptions = {},
): FleetRunResult[] {
  const runner = opts.runner ?? runOnDevice;
  const localRunner = opts.localRunner ?? runLocalCommand;
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
      const isSelf = opts.self !== undefined && t.device.name === opts.self;
      const res = isSelf ? localRunner(cmd) : runner(t.device, cmd);
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

/** Run one async probe per device in parallel, preserving input order. */
export async function fanOutDevices<T, Target extends FanOutDeviceTarget = FanOutDeviceTarget>(
  targets: Target[],
  probe: (target: Target) => Promise<T>,
): Promise<FanOutDeviceResult<T>[]> {
  return Promise.all(targets.map(async (target) => {
    if (target.skip) {
      return {
        name: target.name,
        status: 'skipped' as const,
        reason: target.skip,
      };
    }
    try {
      return {
        name: target.name,
        status: 'ok' as const,
        value: await probe(target),
      };
    } catch (err) {
      return {
        name: target.name,
        status: 'failed' as const,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }));
}
