// Where a `New <Harness>` command runs — the one place the setting is read and
// turned into launch options (no VS Code import, so it is unit-testable).
//
// The extension does NOT score devices. `auto` emits `--device auto` and the
// CLI answers it from the automatic-placement pool, which is an allowlist over
// the devices marked `agents devices role <name> worker` (see the CLI's
// lib/devices/pool.ts). That keeps one placement rule for the whole fleet
// instead of a second, drifting copy in the UI layer.

import { buildAgentLaunchCommand } from './agents';

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

export type HarnessLaunchVariant = 'default' | 'pick-host' | 'auto';

/** Launch choices layered on top of placement for per-harness palette commands. */
export interface HarnessLaunchOpts extends LaunchTargetOpts {
  accountPicker?: true;
}

/** Inputs shared by every command that routes through the extension's one launch engine. */
export interface NewAgentLaunchOpts extends LaunchTargetOpts {
  agentKey?: string;
  host?: string;
  accountPicker?: boolean;
}

export interface HarnessLaunchRegistration {
  commandId: string;
  variant: HarnessLaunchVariant;
  launchOptions: () => NewAgentLaunchOpts;
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

/**
 * Keep the three per-harness command variants distinct:
 *
 * - default: configured placement, then ask which device-local account to run;
 * - pick-host: ask for the device, then ask which account on it to run;
 * - auto: let agents-cli choose both the device and account without a prompt.
 */
export function launchOptsForHarnessCommand(
  variant: HarnessLaunchVariant,
  defaultTarget: LaunchTarget = DEFAULT_LAUNCH_TARGET,
): HarnessLaunchOpts {
  switch (variant) {
    case 'default':
      return { ...launchOptsForTarget(defaultTarget), accountPicker: true };
    case 'pick-host':
      return { pickHost: true, accountPicker: true };
    case 'auto':
      return {};
  }
}

/**
 * The three registered commands for one harness. The default target is read by
 * the callback so a settings change applies without reloading the editor.
 */
export function harnessLaunchRegistrations(
  agentKey: string,
  commandId: string,
  getDefaultTarget: () => LaunchTarget,
): HarnessLaunchRegistration[] {
  return [
    {
      commandId,
      variant: 'default',
      launchOptions: () => ({
        agentKey,
        ...launchOptsForHarnessCommand('default', getDefaultTarget()),
      }),
    },
    {
      commandId: `${commandId}PickHost`,
      variant: 'pick-host',
      launchOptions: () => ({ agentKey, ...launchOptsForHarnessCommand('pick-host') }),
    },
    {
      commandId: `${commandId}Auto`,
      variant: 'auto',
      launchOptions: () => ({ agentKey, ...launchOptsForHarnessCommand('auto') }),
    },
  ];
}

/** Build the final shell command used by launchAgent after any host prompt resolves. */
export function buildNewAgentLaunchCommand(
  options: NewAgentLaunchOpts,
  context: {
    defaultModel?: string;
    cwd?: string;
    projectSlug?: string;
  } = {},
): string {
  const agent = options.agentKey ?? 'auto';
  const isLocal = options.local === true || (options.pickHost === true && !options.host);
  return buildAgentLaunchCommand(
    agent,
    null,
    context.defaultModel,
    undefined,
    undefined,
    options.accountPicker ? undefined : 'balanced',
    'auto',
    {
      host: options.host,
      local: isLocal,
      accountPicker: options.accountPicker,
      project: context.projectSlug,
      cwd: context.projectSlug ? undefined : context.cwd,
    },
  );
}
