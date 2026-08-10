/**
 * Resolve a remote host's OS family so the SSH command layer can pick the right
 * shell dialect (POSIX `bash -lc` vs Windows PowerShell). See `remoteShellFor`
 * in `remote-cmd.ts` for how the string is consumed.
 *
 * Three sources, in priority order:
 *   1. The central config `platform` key (`fleet.devices.<name>.config.platform`
 *      in agents.yaml) — the operator's explicit override, set with
 *      `agents devices config <name> platform <os>`.
 *   2. The device registry `platform` (`windows`/`linux`/`macos`), which is
 *      populated fleet-wide by Tailscale sync — the reliable answer for a box
 *      like `win-mini` that was discovered, not hand-enrolled.
 *   3. The enrolled `HostEntry.os` overlay in agents.yaml (the `uname` captured
 *      when the overlay entry was written), for hosts that live only in that overlay.
 *
 * Missing/unknown from all three → `undefined`, which `remoteShellFor` maps to
 * POSIX. Kept synchronous so the sync `agents sessions --host` fan-out can use it.
 */

import { loadDevicesSync } from '../devices/registry.js';
import { readDeviceConfigValues } from '../device-config.js';
import { readMeta } from '../state.js';

/** Resolve the OS/platform string for a host name, or undefined if unknown. */
export function resolveRemoteOsSync(name: string): string | undefined {
  try {
    const configured = readDeviceConfigValues(name).platform;
    if (typeof configured === 'string' && configured !== 'unknown') return configured;
    const platform = loadDevicesSync()[name]?.platform;
    if (platform && platform !== 'unknown') return platform;
  } catch {
    // A corrupt/unreadable device registry must never break command building —
    // fall through to the host overlay and ultimately the POSIX default.
  }
  return readMeta().hosts?.[name]?.os;
}
