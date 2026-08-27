/**
 * Config drift: has THIS box drained its device-scoped state into its own
 * `devices/<host>/agents.yaml`, or is it still carrying per-box state in the
 * shared top-level `agents.yaml`?
 *
 * PHNX-3315 P1 heals a frozen top-level header and drains the central `browser:`
 * tombstone; P2 folds `fleet.discovery` / `fleet.ignored`, the `hosts:` registry,
 * and device-scoped native `accounts:` out of central and into the device doc.
 * Each fold-and-delete migration is idempotent and runs on config access / daemon
 * boot / install — so a converged box shows NO drift. A box that has NOT run the
 * fold yet (stale checkout, never re-synced) still holds those blocks centrally,
 * and until now that was INVISIBLE: `agents sync status` only reported per-agent
 * "N missing", so an un-drained box was discovered the hard way — as a mystery
 * `agents repo pull` conflict when two boxes rewrote the same shared map.
 *
 * This detector is READ-ONLY and must NOT trigger the migration (that would drain
 * the very leak it is trying to surface): it reads the raw top-level user file
 * directly, never `readMeta()` (system-merged) and never the migration hook.
 */

import { hasStaleMetaHeader, readTopLevelUserMeta } from './state.js';

export interface ConfigDrift {
  /** Top-level `agents.yaml` header != the current META_HEADER (the P1 case). */
  staleHeader: boolean;
  /**
   * Labels of central blocks that should have folded into this box's device doc
   * but still linger — the P1 `browser` tombstone and the P2 `fleet` / `hosts` /
   * `accounts` device-scoped writers. Empty on a drained box.
   */
  centralLeaks: string[];
}

function isMap(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Inspect this box's on-disk state for config drift. Pure read — no migration, no
 * writes. Mirrors the gather step of {@link migrateDeviceConfigStores} (plus the
 * browser tombstone) so a leak here is exactly what a fold would drain.
 */
export function detectConfigDrift(): ConfigDrift {
  const staleHeader = hasStaleMetaHeader();
  const raw = readTopLevelUserMeta();
  const centralLeaks: string[] = [];

  if (raw) {
    // P1: the leftover central `browser:` tombstone (should fold into deviceBrowser).
    if (isMap(raw.browser) && Object.keys(raw.browser).length > 0) {
      centralLeaks.push('browser');
    }

    // P2: fleet.discovery / fleet.ignored, and the short-lived per-device config
    // store under fleet.devices.<name>.config — all fold into the device doc.
    const fleet = isMap(raw.fleet) ? raw.fleet : undefined;
    if (fleet) {
      if (isMap(fleet.discovery) && Object.keys(fleet.discovery).length > 0) {
        centralLeaks.push('fleet.discovery');
      }
      if (Array.isArray(fleet.ignored) && fleet.ignored.length > 0) {
        centralLeaks.push('fleet.ignored');
      }
      if (isMap(fleet.devices)) {
        const anyDeviceConfig = Object.values(fleet.devices).some(
          (ov) => isMap(ov) && isMap(ov.config) && Object.keys(ov.config).length > 0,
        );
        if (anyDeviceConfig) centralLeaks.push('fleet.devices.*.config');
      }
    }

    // P2: the central `hosts:` registry (should fold into deviceHosts).
    if (isMap(raw.hosts) && Object.keys(raw.hosts).length > 0) {
      centralLeaks.push('hosts');
    }

    // P2: central native accounts marked scope:'device' — identity PII that
    // belongs in the device doc, off the git-tracked shared file. Fleet-shared /
    // version-scoped identities stay central and are NOT a leak.
    const accounts = isMap(raw.accounts) ? raw.accounts : undefined;
    const native = accounts && isMap(accounts.native) ? accounts.native : undefined;
    if (native && Object.values(native).some((a) => isMap(a) && a.scope === 'device')) {
      centralLeaks.push('accounts (device-scoped)');
    }
  }

  return { staleHeader, centralLeaks };
}

/** True when either drift class is present. */
export function hasConfigDrift(d: ConfigDrift): boolean {
  return d.staleHeader || d.centralLeaks.length > 0;
}
