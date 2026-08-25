/**
 * This machine's stable, human-readable id. Lives in a dependency-free leaf so
 * low-level modules (state.ts) can key per-device paths off it without importing
 * the secrets/session-sync layer (which would create a cycle).
 */

import * as os from 'os';

/**
 * Normalize a raw hostname into a stable device id: first label only,
 * lowercased, non-alphanumerics collapsed to hyphens. `zion.tail…ts.net` and
 * `ZION` both become `zion`. The single source for this transform — machineId()
 * and cross-machine session grouping must agree or the local machine won't
 * match its own registry key.
 */
export function normalizeHost(raw: string): string {
  return raw.split('.')[0].trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'unknown';
}

/**
 * This machine's stable, human-readable id, used as its R2 sync prefix, session
 * mirror directory, `agents devices` self-key, and per-device config folder.
 * Tailnet hostnames (zion, yosemite-s0, mac-mini) are already unique and
 * readable; we lowercase and strip any domain suffix. Overridable via
 * AGENTS_SYNC_MACHINE_ID for tests and unusual setups.
 */
export function machineId(): string {
  return normalizeHost(process.env.AGENTS_SYNC_MACHINE_ID || os.hostname());
}
