/**
 * Device/user config keys — typed read/write over the two-tier agents.yaml store.
 *
 * One registry (`CONFIG_KEYS`) maps each CLI dotted name to where it lives:
 *   - user scope   → central `~/.agents/agents.yaml` under `config:` (syncs
 *                    fleet-wide via `agents repo push/pull`)
 *   - device scope → `~/.agents/devices/<host>/agents.yaml` under `config:`
 *                    (per-machine; mirrors how `defaultBrowserProfile` is routed)
 *
 * This machine's keys go through the readMeta/updateMeta funnel (state.ts) so the
 * partition/overlay logic stays the single writer. Another device's doc is
 * read/written in place — the devices/ tree syncs via the DotAgents repo, so
 * editing `devices/mac-mini/agents.yaml` locally is how `configure`/`note`
 * target a peer (`--device`-style).
 *
 * `browser.profile` is NOT a `config:` key — it is the existing
 * `Meta.defaultBrowserProfile` field; the registry entry documents the mapping
 * and set/get route to it so there is one source of truth (no duplicate key).
 *
 * Unset always means today's behavior.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { META_HEADER, getUserAgentsDir, readMeta, updateMeta } from './state.js';
import { atomicWriteFileSync } from './fs-atomic.js';
import { machineId } from './machine-id.js';
import { assertValidDeviceName } from './devices/registry.js';
import type { Meta } from './types.js';

/** Which tier of the agents.yaml store a key lives in. */
export type ConfigScope = 'user' | 'device';

/** Value type of a config key — drives validation and `--json` rendering. */
export type ConfigType = 'string' | 'int' | 'bool' | 'string-list';

/** One known config key. */
export interface ConfigKeySpec {
  /** CLI dotted name, e.g. `interactive.host`. */
  name: string;
  /** camelCase key under the YAML `config:` block. */
  yamlKey: string;
  scope: ConfigScope;
  type: ConfigType;
  /** One-line description for help/list output. */
  description: string;
  /**
   * When set, the value lives in this top-level Meta field instead of the
   * `config:` block (only `browser.profile` → `defaultBrowserProfile` today).
   */
  field?: 'defaultBrowserProfile';
  /** Extra validation beyond the type check; return an error string or null. */
  validate?: (value: unknown) => string | null;
}

/** A key with its resolved value and the layer that set it. */
export interface ConfigEntry {
  spec: ConfigKeySpec;
  /** The stored value, or undefined when unset (unset = default behavior). */
  value: unknown;
  /** Which layer set it; undefined when unset. */
  layer?: ConfigScope;
}

/** Options scoping a read/write to a specific device's doc (default: this machine). */
export interface ConfigTarget {
  device?: string;
}

export const CONFIG_KEYS: readonly ConfigKeySpec[] = [
  {
    name: 'interactive.host',
    yamlKey: 'interactiveHost',
    scope: 'user',
    type: 'string',
    description:
      'Device that shows the user artifacts (browser opens, dashboards) — the "online macOS box" skills should use instead of guessing.',
    validate: (v) => {
      try {
        assertValidDeviceName(v as string);
        return null;
      } catch (err: any) {
        return err?.message ?? String(err);
      }
    },
  },
  {
    name: 'browser.profile',
    yamlKey: 'defaultBrowserProfile',
    scope: 'device',
    type: 'string',
    field: 'defaultBrowserProfile',
    description:
      'Browser profile `agents browser start` resolves to without --profile (set via `agents browser profiles set-default`).',
  },
  {
    name: 'agents.max-concurrent',
    yamlKey: 'maxAgents',
    scope: 'device',
    type: 'int',
    description:
      'Cap on concurrent agents on this device. What counts toward it depends on the consumer: ' +
      'Factory auto-launch counts device-wide running agents; teams placement counts the team’s own roster on the device.',
    validate: (v) => ((v as number) >= 1 ? null : 'agents.max-concurrent must be >= 1.'),
  },
  {
    name: 'scheduler.enabled',
    yamlKey: 'schedulerEnabled',
    scope: 'device',
    type: 'bool',
    description: 'Whether the routines scheduler (daemon) may fire on this device.',
  },
  {
    name: 'daemon.enabled',
    yamlKey: 'daemonEnabled',
    scope: 'device',
    type: 'bool',
    description:
      'Whether the daemon may run on this device at all (secrets broker, browser IPC, watchdog, and the ' +
      'routines scheduler). Disabling is the top-level kill switch: nothing auto-starts the daemon while it ' +
      'is set, including `routines add`/`routines start`/`routines catchup`/webhook triggers. ' +
      '`agents daemon start` still starts it explicitly.',
  },
  {
    name: 'watchdog.enabled',
    yamlKey: 'watchdogEnabled',
    scope: 'device',
    type: 'bool',
    description: 'Whether the daemon runs the watchdog pass on this device.',
  },
  {
    name: 'browser.remote-control',
    yamlKey: 'browserRemoteControl',
    scope: 'device',
    type: 'bool',
    description:
      "Whether other fleet machines may drive THIS device's browser over `browser --host <this-device>`. " +
      'Default off — a fleet-remote drive is refused until the owner runs `agents browser remote-control on`.',
  },
  {
    name: 'notes',
    yamlKey: 'notes',
    scope: 'device',
    type: 'string-list',
    description: 'Free-form operator notes about this device (one entry per `agents devices note`).',
  },
];

/** Look up a key spec by CLI dotted name, or throw listing the known keys. */
export function configKeySpec(name: string): ConfigKeySpec {
  const spec = CONFIG_KEYS.find((k) => k.name === name);
  if (!spec) {
    throw new Error(
      `Unknown config key '${name}'. Known keys: ${CONFIG_KEYS.map((k) => k.name).join(', ')}.`,
    );
  }
  return spec;
}

/** Throw when `value` does not match the key's declared type or validation. */
function assertValidValue(spec: ConfigKeySpec, value: unknown): void {
  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`Config key '${spec.name}' expects a non-empty string, got ${JSON.stringify(value)}.`);
      }
      break;
    case 'int':
      if (!Number.isInteger(value)) {
        throw new Error(`Config key '${spec.name}' expects an integer, got ${JSON.stringify(value)}.`);
      }
      break;
    case 'bool':
      if (typeof value !== 'boolean') {
        throw new Error(`Config key '${spec.name}' expects a boolean, got ${JSON.stringify(value)}.`);
      }
      break;
    case 'string-list':
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        throw new Error(`Config key '${spec.name}' expects a list of strings, got ${JSON.stringify(value)}.`);
      }
      break;
  }
  const err = spec.validate?.(value);
  if (err) throw new Error(`Invalid value for '${spec.name}': ${err}`);
}

// ─── Sibling-device doc access ────────────────────────────────────────────────

/** Path to any device's doc (self or a peer) under the synced devices/ tree. */
function deviceDocPath(device: string): string {
  return path.join(getUserAgentsDir(), 'devices', device, 'agents.yaml');
}

/**
 * Read a device doc directly. Returns null when the file does not exist. A
 * malformed file is a hard error — silently returning null would let the next
 * write wipe the device's pins/default (same contract as the device registry).
 * A valid-but-non-map document (a bare string, a list) is the same kind of
 * corruption: reject it here instead of failing later with a TypeError.
 */
function readDeviceDoc(device: string): Meta | null {
  const p = deviceDocPath(device);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  const corrupted = (detail: string) =>
    new Error(`Device config corrupted at ${p}: ${detail}. Inspect and restore from backup.`);
  let parsed: unknown;
  try {
    parsed = yaml.parse(raw);
  } catch (err: any) {
    throw corrupted(err?.message ?? String(err));
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw corrupted(`expected a YAML map, got ${Array.isArray(parsed) ? 'a list' : JSON.stringify(parsed)}`);
  }
  return parsed as Meta;
}

/** Write a device doc in place (atomic). Only ever holds device-local fields. */
function writeDeviceDoc(device: string, doc: Meta): void {
  const p = deviceDocPath(device);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const body = Object.keys(doc).length > 0 ? doc : { agents: {} };
  atomicWriteFileSync(p, META_HEADER + yaml.stringify(body));
}

// ─── Reads ────────────────────────────────────────────────────────────────────

function entryFromMeta(spec: ConfigKeySpec, meta: Meta): ConfigEntry {
  if (spec.field === 'defaultBrowserProfile') {
    const value = meta.defaultBrowserProfile;
    return { spec, value, layer: value !== undefined ? 'device' : undefined };
  }
  if (spec.scope === 'user') {
    const value = meta.config?.[spec.yamlKey];
    return { spec, value, layer: value !== undefined ? 'user' : undefined };
  }
  const value = meta.deviceConfig?.[spec.yamlKey];
  return { spec, value, layer: value !== undefined ? 'device' : undefined };
}

/** True when `device` names this machine (case-insensitive, mirroring
 * `isLocalDevice` in teams/scheduler.ts) — `configure ZION` on host zion must
 * take the self path (readMeta/updateMeta funnel), not the peer-doc path. */
function isSelfDevice(device: string): boolean {
  return device.toLowerCase() === machineId();
}

/** Get one config key's value and the layer that set it. */
export function getConfigValue(name: string, opts?: ConfigTarget): ConfigEntry {
  const spec = configKeySpec(name);
  if (spec.scope === 'device' && opts?.device && !isSelfDevice(opts.device)) {
    const doc = readDeviceDoc(opts.device) ?? {};
    return entryFromMeta(spec, { deviceConfig: doc.config, defaultBrowserProfile: doc.defaultBrowserProfile });
  }
  return entryFromMeta(spec, readMeta());
}

/** List every known key with its value and the layer that set it. */
export function listConfig(opts?: ConfigTarget): ConfigEntry[] {
  return CONFIG_KEYS.map((spec) => getConfigValue(spec.name, opts));
}

// ─── Writes ───────────────────────────────────────────────────────────────────

function setInMeta(spec: ConfigKeySpec, value: unknown): void {
  updateMeta((m) => {
    if (spec.field === 'defaultBrowserProfile') {
      return { ...m, defaultBrowserProfile: value as string };
    }
    if (spec.scope === 'user') {
      return { ...m, config: { ...m.config, [spec.yamlKey]: value } };
    }
    return { ...m, deviceConfig: { ...m.deviceConfig, [spec.yamlKey]: value } };
  });
}

function unsetInMeta(spec: ConfigKeySpec): void {
  updateMeta((m) => {
    if (spec.field === 'defaultBrowserProfile') {
      const { defaultBrowserProfile, ...rest } = m;
      void defaultBrowserProfile;
      return rest;
    }
    const block = spec.scope === 'user' ? m.config : m.deviceConfig;
    if (!block || !(spec.yamlKey in block)) return m;
    const next = { ...block };
    delete next[spec.yamlKey];
    const cleaned = Object.keys(next).length > 0 ? next : undefined;
    return spec.scope === 'user' ? { ...m, config: cleaned } : { ...m, deviceConfig: cleaned };
  });
}

function setInDeviceDoc(device: string, spec: ConfigKeySpec, value: unknown): void {
  const doc = readDeviceDoc(device) ?? {};
  if (spec.field === 'defaultBrowserProfile') {
    doc.defaultBrowserProfile = value as string;
  } else {
    doc.config = { ...doc.config, [spec.yamlKey]: value };
  }
  writeDeviceDoc(device, doc);
}

function unsetInDeviceDoc(device: string, spec: ConfigKeySpec): void {
  const doc = readDeviceDoc(device);
  if (!doc) return; // nothing stored — unset is a no-op
  if (spec.field === 'defaultBrowserProfile') {
    delete doc.defaultBrowserProfile;
  } else if (doc.config && spec.yamlKey in doc.config) {
    delete doc.config[spec.yamlKey];
    if (Object.keys(doc.config).length === 0) delete doc.config;
  } else {
    return; // key not present — no write needed
  }
  writeDeviceDoc(device, doc);
}

/** Set a config key (validated). Device-scope keys target this machine unless `opts.device` names a peer. */
export function setConfigValue(name: string, value: unknown, opts?: ConfigTarget): void {
  const spec = configKeySpec(name);
  assertValidValue(spec, value);
  if (spec.scope === 'device' && opts?.device && !isSelfDevice(opts.device)) {
    setInDeviceDoc(opts.device, spec, value);
    return;
  }
  setInMeta(spec, value);
}

/** Unset a config key — restores default behavior. No-op when already unset. */
export function unsetConfigValue(name: string, opts?: ConfigTarget): void {
  const spec = configKeySpec(name);
  if (spec.scope === 'device' && opts?.device && !isSelfDevice(opts.device)) {
    unsetInDeviceDoc(opts.device, spec);
    return;
  }
  unsetInMeta(spec);
}

// ─── Consumers' helpers ───────────────────────────────────────────────────────

/** True unless this machine's device doc disables the routines scheduler. */
export function isSchedulerEnabled(): boolean {
  return getConfigValue('scheduler.enabled').value !== false;
}

/**
 * Throw when the routines scheduler is disabled on this machine, naming the
 * setting and the fix. The single message every scheduler-start surface
 * (auto-start on `routines add`, manual `routines start`, the daemon's own
 * scheduler init) refuses with.
 */
export function assertSchedulerEnabled(): void {
  if (isSchedulerEnabled()) return;
  throw new Error(
    `The routines scheduler is disabled on this device (scheduler.enabled=false in ~/.agents/devices/${machineId()}/agents.yaml). ` +
      `Re-enable with: agents devices configure ${machineId()} --scheduler on`,
  );
}

/** True unless this machine's device doc disables the daemon outright (top-level kill switch). */
export function isDaemonEnabled(): boolean {
  return getConfigValue('daemon.enabled').value !== false;
}

/**
 * Throw when the daemon is disabled on this machine, naming the setting and
 * the fix. Every AUTO-start surface (routines add/start/catchup/webhook,
 * `ensureDaemonStarted`) refuses with this before calling `startDaemon()`.
 * `agents daemon start` is the deliberate override and does NOT call this —
 * disable only blocks auto-start, mirroring `systemctl disable`.
 */
export function assertDaemonEnabled(): void {
  if (isDaemonEnabled()) return;
  throw new Error(
    `The daemon is disabled on this device (daemon.enabled=false in ~/.agents/devices/${machineId()}/agents.yaml). ` +
      `Re-enable with: agents daemon enable`,
  );
}

/**
 * Read the `agents.max-concurrent` cap for each named device from its synced
 * device doc (no SSH). Devices without a cap are omitted — uncapped is the
 * default. Used as an input to host ranking (teams placement, Factory
 * auto-launch), never as a remote probe.
 */
export function readMaxConcurrentCaps(devices: string[]): Record<string, number> {
  const caps: Record<string, number> = {};
  for (const device of devices) {
    const value = getConfigValue('agents.max-concurrent', { device }).value;
    if (typeof value === 'number') caps[device] = value;
  }
  return caps;
}
