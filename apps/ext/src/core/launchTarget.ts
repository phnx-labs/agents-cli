// Where a `New <Harness>` command runs — the one place the setting is read and
// turned into launch options (no VS Code import, so it is unit-testable).
//
// The extension does NOT score devices. `auto` emits `--device auto` and the
// CLI answers it from the automatic-placement pool, which is an allowlist over
// the devices marked `agents devices role <name> worker` (see the CLI's
// lib/devices/pool.ts). That keeps one placement rule for the whole fleet
// instead of a second, drifting copy in the UI layer.

/** The configured default target for the per-harness New commands. */
export type LaunchTarget = 'auto' | 'local' | 'ask';

/** The default when the setting is unset: rotate over the fleet's worker pool. */
export const DEFAULT_LAUNCH_TARGET: LaunchTarget = 'auto';

const TARGETS: readonly LaunchTarget[] = ['auto', 'local', 'ask'];

/**
 * Read a configured value into a target. Anything unrecognized (including an
 * unset setting) falls to {@link DEFAULT_LAUNCH_TARGET} — a launch the user just
 * triggered must not be blocked by a typo in settings.json, and `auto` is the
 * documented default behavior.
 */
export function resolveLaunchTarget(value: unknown): LaunchTarget {
  return typeof value === 'string' && (TARGETS as readonly string[]).includes(value)
    ? (value as LaunchTarget)
    : DEFAULT_LAUNCH_TARGET;
}

/** The subset of LaunchAgentOpts a target decides. */
export interface LaunchTargetOpts {
  local?: boolean;
  pickHost?: boolean;
}

/**
 * Launch options for a target. `auto` sets neither flag: that is what makes
 * buildAgentLaunchCommand emit `--device auto` (see launchAgent's `isLocal`).
 */
export function launchOptsForTarget(target: LaunchTarget): LaunchTargetOpts {
  switch (target) {
    case 'local':
      return { local: true };
    case 'ask':
      return { pickHost: true };
    case 'auto':
      return {};
  }
}
