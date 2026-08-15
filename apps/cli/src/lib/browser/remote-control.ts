/**
 * Consent gate for driving THIS machine's browser from another fleet machine.
 *
 * `browser --device <device>` routes a browser command to `<device>` over SSH (the
 * fleet passthrough) and runs `agents browser ...` there. Every such remote
 * invocation carries the {@link FLEET_REMOTE_ENV} marker, set once at the fleet
 * dispatch site (`maybeRunOnHost`). A machine only accepts being driven when its
 * owner has opted in via `agents browser remote-control on` (the device-scope
 * `browser.remote-control` config key, never synced).
 *
 * Local invocations (no marker) are never gated — this only governs cross-machine
 * drives. Read-only queries are not gated here; the gate sits at the drive entry
 * point (`browser start`), the one command that opens/attaches a browser.
 */

import { getConfigValue } from '../device-config.js';

/** Env marker set on every remote `agents` invocation by `buildRemoteAgentsInvocation`. */
export const FLEET_REMOTE_ENV = 'AGENTS_FLEET_REMOTE';

/** True when this process was dispatched to this machine by a fleet `--device` run. */
export function isFleetRemoteInvocation(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[FLEET_REMOTE_ENV] === '1';
}

/**
 * Whether this machine allows other fleet machines to drive its browser. Reads
 * the device-scope `browser.remote-control` config key. Unset = off (deny).
 */
export function remoteControlEnabled(): boolean {
  return getConfigValue('browser.remote-control').value === true;
}

/**
 * Guard the browser-drive entry point. A fleet-remote invocation may only drive
 * this machine's browser when the owner opted in; otherwise throw a clear,
 * actionable error. A local invocation is never gated.
 *
 * `env` and `enabled` are injectable so the decision is unit-testable without a
 * real remote hop or a real config store.
 */
export function assertRemoteControlAllowed(opts?: {
  env?: NodeJS.ProcessEnv;
  enabled?: boolean;
}): void {
  const env = opts?.env ?? process.env;
  if (!isFleetRemoteInvocation(env)) return;
  const enabled = opts?.enabled ?? remoteControlEnabled();
  if (enabled) return;

  const who = env.AGENTS_ACTOR_HOST || env.AGENTS_ACTOR || 'A fleet machine';
  throw new Error(
    `${who} tried to drive this machine's browser over \`browser --device\`, but remote ` +
      `browser control is off here. To allow it, run on THIS machine:\n` +
      `  agents browser remote-control on`,
  );
}
