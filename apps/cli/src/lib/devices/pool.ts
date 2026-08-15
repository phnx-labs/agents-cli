/**
 * The automatic-placement pool — which devices `--device auto` may pick from.
 *
 * One rule, in one place, so every automatic-placement path agrees: `agents run
 * --device auto`, `agents teams add --device auto`, the generic host resolver,
 * and the AGI EXT launch commands (which emit `--device auto` rather than
 * scoring devices themselves) all draw from {@link filterAutoPool}.
 *
 * The pool is an ALLOWLIST the moment the operator marks a worker. Roles are
 * stored in that device's tracked per-device doc
 * (`devices/<name>/agents.yaml` `config.role`, see `lib/device-config.ts`)
 * and sync with `agents repo push/pull`.
 *
 * | Fleet state | `--device auto` picks from |
 * |---|---|
 * | no device marked | every online device (unchanged behavior) |
 * | some marked `worker` | ONLY those workers |
 * | marked `personal` | never, under either state |
 *
 * `auto.pool all` turns the allowlist off; `personal` stays excluded, because a
 * machine the user sits at is marked precisely so agents stay off it.
 *
 * Paired cockpits (an iPhone/iPad, `role: control` in the device registry, set
 * by `agents devices pair-ios`) are excluded by the CALLER that reads the
 * registry — `listOnlineDeviceNames` in `lib/smart-launch.ts` — not here. That
 * role is machine-local by nature and already has a home; duplicating it in the
 * shared config would be a second store for one concept.
 */
import { autoPoolMode, listConfiguredDeviceRoles, type AutoPoolMode, type ConfiguredDeviceRole } from '../device-config.js';
import { normalizeHost } from '../machine-id.js';

/** Roles that automatic placement never picks, whatever the pool mode. */
const NEVER_AUTO: ReadonlySet<ConfiguredDeviceRole> = new Set<ConfiguredDeviceRole>(['personal']);

export interface AutoPoolOptions {
  /** Pool mode; defaults to the configured `auto.pool`. */
  mode?: AutoPoolMode;
  /** Configured roles by device name; defaults to the fleet-shared block. */
  roles?: Record<string, ConfiguredDeviceRole>;
  /**
   * Device names to resolve roles for when `roles` is not given directly —
   * so a fleet-wide role default reaches a device with no per-device doc of
   * its own. Ignored once `roles` is supplied. See
   * {@link listConfiguredDeviceRoles}.
   */
  roster?: string[];
}

/**
 * Narrow a candidate host list to the devices automatic placement may pick.
 *
 * Returns the input order, minus the excluded devices. An empty result is a
 * real answer — "you marked workers and none of them is a candidate right now"
 * — and callers surface it as their own no-healthy-device error rather than
 * quietly widening back to the full fleet.
 */
export function filterAutoPool(pool: string[], opts: AutoPoolOptions = {}): string[] {
  const roles = opts.roles ?? listConfiguredDeviceRoles(opts.roster ?? pool);
  const byHost = new Map(Object.entries(roles).map(([name, role]) => [normalizeHost(name), role]));
  const roleOf = (host: string) => byHost.get(normalizeHost(host));
  const eligible = pool.filter((host) => {
    const role = roleOf(host);
    return role === undefined || !NEVER_AUTO.has(role);
  });
  const mode = opts.mode ?? autoPoolMode();
  if (mode === 'all') return eligible;
  const anyWorkerMarked = [...byHost.values()].some((role) => role === 'worker');
  if (!anyWorkerMarked) return eligible;
  return eligible.filter((host) => roleOf(host) === 'worker');
}

/** True when this host is one automatic placement may pick. */
export function isAutoPoolMember(host: string, opts: AutoPoolOptions = {}): boolean {
  return filterAutoPool([host], opts).length > 0;
}

/** Device names explicitly marked `worker`, in registry order. */
export function listWorkerDevices(opts: Pick<AutoPoolOptions, 'roles'> = {}): string[] {
  const roles = opts.roles ?? listConfiguredDeviceRoles();
  return Object.entries(roles)
    .filter(([, role]) => role === 'worker')
    .map(([name]) => name);
}

/**
 * One line naming why the pool is what it is, for the `--device auto` banner and
 * the no-healthy-device error. Empty string when no role narrows anything, so
 * callers can append it unconditionally.
 */
export function describeAutoPool(opts: AutoPoolOptions = {}): string {
  const roles = opts.roles ?? listConfiguredDeviceRoles(opts.roster);
  const mode = opts.mode ?? autoPoolMode();
  const workers = listWorkerDevices({ roles });
  if (mode === 'all') {
    return workers.length > 0 ? 'auto.pool=all (worker marks ignored)' : '';
  }
  if (workers.length === 0) return '';
  return `workers: ${workers.join(', ')}`;
}
