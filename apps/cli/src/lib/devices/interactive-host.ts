/**
 * The `interactive` device sentinel: "wherever the human is sitting".
 *
 * `--device auto` means "pick a box by load". This means the opposite — one
 * specific box, the one whose screen a person is actually looking at, pinned as
 * `interactive.host`.
 *
 * It exists because a skill cannot teach a host name. Guidance that says
 * "deliver it to zion" is wrong on every other fleet and stale the moment the
 * pin changes, so agents were left to infer the target or to skip the step. A
 * fixed token is something a SKILL.md can state literally and have be correct
 * everywhere.
 *
 * Resolution happens at the dispatch site, before `isSelfHost`, exactly like
 * `auto` — so a pin naming this machine runs locally instead of self-SSHing, and
 * the forwarded argv has the routing flag stripped, which is what keeps this
 * from recursing.
 */
import { getConfigValue } from '../device-config.js';

/** The reserved `--device` value meaning the box the human is at. */
export const INTERACTIVE_DEVICE_SENTINEL = 'interactive';

/** True when a host flag value is the interactive sentinel. */
export function isDeviceInteractive(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === INTERACTIVE_DEVICE_SENTINEL;
}

/**
 * The device pinned as `interactive.host`, or null when unset.
 *
 * Callers MUST refuse on null rather than falling back to the local machine.
 * The whole point of the sentinel is reaching a screen someone is watching;
 * silently running on a headless worker instead is the exact failure it exists
 * to prevent, and it would fail invisibly.
 */
export function resolveInteractiveDevice(): string | null {
  const pinned = getConfigValue('interactive.host').value;
  if (typeof pinned !== 'string' || !pinned.trim()) return null;
  const host = pinned.trim();
  // A self-referential pin does NOT recurse — resolution happens once at the
  // dispatch site — but it does resolve to a literal host named "interactive",
  // which then fails as an unreachable device and reads as a confusing
  // `device=interactive → interactive`. Treat it as unset so the caller prints
  // the actionable "pin a host" message instead. `auto` is rejected for the same
  // reason: the two sentinels mean opposite things and chaining them is a
  // mistake, not a request.
  if (isDeviceInteractive(host) || host.toLowerCase() === 'auto') return null;
  return host;
}

/** The actionable error for an unset pin — shared so every call site says the same thing. */
export function interactiveUnsetError(): string {
  return (
    `--device interactive needs an interactive host pinned, and none is set.\n` +
    `  Set it on the machine you sit at:  agents config set interactive.host <device>`
  );
}
