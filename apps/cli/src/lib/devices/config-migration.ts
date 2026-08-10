/**
 * One-time migration: fold per-device config from the legacy stores into the
 * central `fleet.devices.<name>.config` block of `~/.agents/agents.yaml`.
 *
 * Legacy sources (both pre-unification):
 *   - `~/.agents/devices/<name>/agents.yaml` — the `config:` map and the
 *     top-level `defaultBrowserProfile:` field. Agent pins (`agents:`,
 *     `isolatedAgents:`) and `routines:` STAY in the per-device doc — only
 *     operator config moves.
 *   - `~/.agents/.history/devices/auto-launch.json` — AGI EXT auto-launch
 *     enabled/preferred flags, becoming `autoLaunchEnabled` /
 *     `autoLaunchPreferred` config keys.
 *
 * Order is crash-safe: the central block is written FIRST, then the legacy
 * stores are stripped. A crash in between re-folds on the next run, and the
 * central-wins merge makes that a no-op. Idempotent — after a successful run
 * neither source holds config, so re-running is a cheap existence check.
 *
 * Invoked from three places so every install converges regardless of entry
 * point: `runMigration()` (fresh / sentinel-less installs), daemon boot, and
 * the first `lib/device-config.ts` read/write in a process.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import {
  getDevicesAutoLaunchPath,
  getUserAgentsDir,
  updateMeta,
} from '../state.js';
import { loadDevicesSync } from './registry.js';
import type { FleetDeviceOverride, FleetManifest } from '../fleet/types.js';

/** Config folded out of one legacy store, keyed by device name. */
type ConfigFolds = Record<string, Record<string, unknown>>;

/**
 * The `fleet.devices` map a config write should edit. A missing block starts
 * empty; the literal `'all'` upgrades to an explicit map of the
 * currently-registered roster so a config write never silently narrows what
 * `agents apply` targets. (The dynamic "new devices join automatically"
 * semantics of `'all'` do not survive the upgrade — per-device config is
 * inherently a map.)
 */
export function fleetDevicesMapForWrite(fleet: FleetManifest | undefined): Record<string, FleetDeviceOverride> {
  if (fleet && fleet.devices !== 'all') return { ...fleet.devices };
  if (fleet?.devices !== 'all') return {};
  // devices === 'all': expand to the registered roster.
  const roster = loadDevicesSync();
  const devices: Record<string, FleetDeviceOverride> = {};
  for (const name of Object.keys(roster)) devices[name] = {};
  return devices;
}

function mergeFold(folds: ConfigFolds, device: string, values: Record<string, unknown>): void {
  folds[device] = { ...folds[device], ...values };
}

/**
 * Read every legacy device doc, returning the config to fold per device.
 * A doc that fails to parse is LOUDLY skipped (and left untouched) so the next
 * run retries — never silently emptied, same corruption contract the device
 * registry keeps.
 */
function collectDeviceDocFolds(devicesRoot: string): { folds: ConfigFolds; docs: Array<{ name: string; path: string; doc: Record<string, unknown> }> } {
  const folds: ConfigFolds = {};
  const docs: Array<{ name: string; path: string; doc: Record<string, unknown> }> = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(devicesRoot, { withFileTypes: true });
  } catch {
    return { folds, docs }; // no devices/ tree — nothing to fold
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const docPath = path.join(devicesRoot, entry.name, 'agents.yaml');
    if (!fs.existsSync(docPath)) continue;
    let parsed: unknown;
    try {
      parsed = yaml.parse(fs.readFileSync(docPath, 'utf-8'));
    } catch (err) {
      console.error(`device config migration: could not parse ${docPath} (${(err as Error).message}); leaving it for a later retry`);
      continue;
    }
    if (parsed === null || parsed === undefined) continue; // empty doc
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(`device config migration: ${docPath} is not a YAML map; leaving it for manual repair`);
      continue;
    }
    const doc = parsed as Record<string, unknown>;
    const config: Record<string, unknown> = {};
    if (doc.config !== undefined) {
      if (typeof doc.config !== 'object' || doc.config === null || Array.isArray(doc.config)) {
        console.error(`device config migration: ${docPath} has a non-map config: block; leaving it for manual repair`);
        continue;
      }
      Object.assign(config, doc.config as Record<string, unknown>);
    }
    if (typeof doc.defaultBrowserProfile === 'string') {
      config.defaultBrowserProfile = doc.defaultBrowserProfile;
    }
    if (Object.keys(config).length === 0) continue;
    mergeFold(folds, entry.name, config);
    docs.push({ name: entry.name, path: docPath, doc });
  }
  return { folds, docs };
}

/** Read the legacy auto-launch.json, returning the flags to fold per device. */
function collectAutoLaunchFolds(autoLaunchPath: string): ConfigFolds {
  const folds: ConfigFolds = {};
  let raw: string;
  try {
    raw = fs.readFileSync(autoLaunchPath, 'utf-8');
  } catch {
    return folds; // absent — nothing to fold
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`device config migration: could not parse ${autoLaunchPath} (${(err as Error).message}); leaving it for a later retry`);
    return folds;
  }
  const devices = (parsed as { devices?: unknown })?.devices;
  if (devices && typeof devices === 'object' && !Array.isArray(devices)) {
    for (const [name, pref] of Object.entries(devices as Record<string, { enabled?: unknown; preferred?: unknown }>)) {
      const config: Record<string, unknown> = {};
      if (pref?.enabled === false) config.autoLaunchEnabled = false;
      if (pref?.preferred === true) config.autoLaunchPreferred = true;
      if (Object.keys(config).length > 0) mergeFold(folds, name, config);
    }
  }
  return folds;
}

/**
 * Fold the legacy per-device config stores into the central
 * `fleet.devices.<name>.config` block. Safe to call on every boot / config
 * access: cheap no-op once the legacy stores are stripped.
 */
export function migrateDeviceConfigToCentral(): void {
  const devicesRoot = path.join(getUserAgentsDir(), 'devices');
  const autoLaunchPath = getDevicesAutoLaunchPath();

  const { folds: docFolds, docs } = collectDeviceDocFolds(devicesRoot);
  const autoFolds = collectAutoLaunchFolds(autoLaunchPath);
  const folds: ConfigFolds = {};
  for (const [name, config] of Object.entries(docFolds)) mergeFold(folds, name, config);
  for (const [name, config] of Object.entries(autoFolds)) mergeFold(folds, name, config);
  if (Object.keys(folds).length === 0) return;

  // 1. Central write FIRST. A `fleet.devices: all` declaration upgrades to an
  //    explicit map of the currently-registered roster so `agents apply` keeps
  //    targeting the same devices. A key already present centrally WINS over
  //    the legacy value — a re-fold after a mid-migration crash is then a
  //    no-op, and a value written by a newer CLI is never clobbered.
  updateMeta((m) => {
    const devices = fleetDevicesMapForWrite(m.fleet);
    for (const [name, config] of Object.entries(folds)) {
      const prev = devices[name] ?? {};
      devices[name] = { ...prev, config: { ...config, ...prev.config } };
    }
    const fleet: FleetManifest = { ...m.fleet, devices };
    return { ...m, fleet };
  });

  // 2. The legacy stores are deliberately LEFT IN PLACE.
  //
  //    This migration used to delete them — `fs.rmSync` on the device doc and
  //    `fs.rmdirSync` on its directory. Deleting is what made the fold unsafe
  //    to run anywhere: it had to win a race against every other machine's copy
  //    of the same shared file, and a box on an older CLI that re-created the
  //    doc would be stripped again on the next command.
  //
  //    An additive fold has neither problem. The central block is written; the
  //    source is untouched; a box still running the previous CLI keeps reading
  //    what it always read. The now-redundant legacy copy is pruned in a later
  //    release by one explicit operator command, not by 13 machines each
  //    deciding to delete on their own schedule.
  void docs;
  void autoLaunchPath;
}
