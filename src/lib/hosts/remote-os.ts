/**
 * Resolve a remote host's OS family so the SSH command layer can pick the right
 * shell dialect (POSIX `bash -lc` vs Windows PowerShell). See `remoteShellFor`
 * in `remote-cmd.ts` for how the string is consumed.
 *
 * Two sources, in priority order:
 *   1. The device registry `platform` (`windows`/`linux`/`macos`), which is
 *      populated fleet-wide by Tailscale sync — the reliable answer for a box
 *      like `win-mini` that was discovered, not hand-enrolled.
 *   2. The enrolled `HostEntry.os` overlay in agents.yaml (the `uname` captured
 *      at `agents hosts add` time), for hosts that live only in that overlay.
 *
 * Missing/unknown from both → `undefined`, which `remoteShellFor` maps to POSIX.
 * Kept synchronous so the sync `agents sessions --host` fan-out can use it.
 */

import { loadDevicesSync } from '../devices/registry.js';
import { readMeta } from '../state.js';

/** Resolve the OS/platform string for a host name, or undefined if unknown. */
export function resolveRemoteOsSync(name: string): string | undefined {
  try {
    const platform = loadDevicesSync()[name]?.platform;
    if (platform && platform !== 'unknown') return platform;
  } catch {
    // A corrupt/unreadable device registry must never break command building —
    // fall through to the host overlay and ultimately the POSIX default.
  }
  return readMeta().hosts?.[name]?.os;
}
