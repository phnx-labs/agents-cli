/**
 * Device/user config keys — typed read/write over the three-layer store.
 *
 * One registry (`CONFIG_KEYS`) maps each CLI dotted name to where it lives:
 *   - user scope   → central `~/.agents/agents.yaml` under `config:` (syncs
 *                    fleet-wide via `agents repo push/pull`)
 *   - device scope → the per-device TRACKED doc
 *                    `~/.agents/devices/<name>/agents.yaml` under `config:` —
 *                    conflict-free by construction (each machine writes only
 *                    its own folder, and the churny auto-written pins no longer
 *                    share the file)
 *   - fleet layer  → central `~/.agents/agents.yaml` under
 *                    `fleet.defaults.config` — fleet-wide defaults written by
 *                    `agents devices config --fleet <key> <value>`
 *
 * Read order for a device-scope key: built-in default < fleet.defaults.config
 * < per-device config:. Names and non-secret values only (a secrets-bundle
 * NAME is fine; a credential never is).
 *
 * The device registry (`~/.agents/.history/devices/registry.json`) stays the
 * DISCOVERY cache (address, tailscale snapshot, reachability); the profile
 * fields config can override (ssh.*, platform, user) are overlaid onto it at
 * read time by `lib/devices/resolve-profile.ts`.
 *
 * Legacy stores (central `fleet.devices.<name>.config`, legacy auto-launch.json,
 * doc-level defaultBrowserProfile, pins in tracked docs) are folded into this
 * layout once by `lib/devices/config-migration.ts`, invoked on the first
 * read/write in a process — after migration there is ONE read path per layer,
 * no fallback branches.
 *
 * Unset always means today's behavior (the documented default).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { META_HEADER, getUserAgentsDir, readMeta, updateMeta, withMetaLock } from './state.js';
import { atomicWriteFileSync } from './fs-atomic.js';
import { machineId } from './machine-id.js';
import { assertValidDeviceName } from './devices/registry.js';
import { migrateDeviceConfigStores } from './devices/config-migration.js';
import type { FleetManifest } from './fleet/types.js';

/** Which tier of the agents.yaml store a key lives in. */
export type ConfigScope = 'user' | 'device';

/**
 * For a device-scope key: WHO READS IT. Storage is still the three-layer
 * store (per-device doc / fleet.defaults.config); visibility only gates
 * whether a PEER may read or write the key.
 *
 * - `shared`  — a peer reads it (ssh.*, platform, role, caps), so any box
 *   may set it for any device. Lands in that device's tracked doc.
 * - `machine` — only the owning box ever reads it (scheduler, daemon, tmux,
 *   browser consent). Refused for a peer — run it on that box instead.
 */
export type ConfigVisibility = 'shared' | 'machine';

/** Value type of a config key — drives validation and `--json` rendering. */
export type ConfigType = 'string' | 'int' | 'bool' | 'string-list';

/** Fields every key carries, regardless of scope. */
interface ConfigKeySpecBase {
  /** CLI dotted name, e.g. `interactive.host`. */
  name: string;
  /** camelCase key under the YAML config block. */
  yamlKey: string;
  type: ConfigType;
  /** One-line description for help/list output. */
  description: string;
  /** The effective value when the key is unset (bool keys; drives the interactive menu's default). */
  defaultValue?: unknown;
  /** Extra validation beyond the type check; return an error string or null. */
  validate?: (value: unknown) => string | null;
}

/**
 * One known config key. A device-scope key MUST declare its `visibility`; a
 * user-scope key has none (it is fleet-wide by definition).
 */
export type ConfigKeySpec =
  | (ConfigKeySpecBase & { scope: 'user'; visibility?: never })
  | (ConfigKeySpecBase & { scope: 'device'; visibility: ConfigVisibility });

/** Which layer set a key's effective value (`default` = unset, built-in behavior). */
export type ConfigSource = 'user' | 'device' | 'fleet' | 'default';

/** A key with its resolved value and the layer that set it. */
export interface ConfigEntry {
  spec: ConfigKeySpec;
  /** The effective value, or undefined when unset (unset = default behavior). */
  value: unknown;
  /** Which layer set the effective value. */
  source: ConfigSource;
}

/** Options scoping a read/write: a specific device (default: this machine), or the fleet-defaults layer. */
export interface ConfigTarget {
  device?: string;
  /** Write/read the fleet-wide defaults layer (central fleet.defaults.config). */
  fleet?: boolean;
}

const DEVICE_PLATFORMS = ['windows', 'linux', 'macos', 'unknown'] as const;
const SSH_AUTH_METHODS = ['key', 'password'] as const;
/** Roles a device can be marked with — see the `role` key below. */
const DEVICE_ROLES = ['worker', 'personal'] as const;
/** Which devices automatic placement may pick — see the `auto.pool` key below. */
const AUTO_POOL_MODES = ['workers', 'all'] as const;

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
    name: 'usage.primary-host',
    yamlKey: 'usagePrimaryHost',
    scope: 'user',
    type: 'string',
    description: 'Device whose usage snapshots are authoritative for fleet-wide usage reporting.',
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
    name: 'auto.pool',
    yamlKey: 'autoPool',
    scope: 'user',
    type: 'string',
    description:
      "Which devices automatic placement (`--device auto`) may pick: 'workers' (default — only devices marked role=worker, " +
      "once at least one is marked) or 'all' (every online device, ignoring worker marks). A device marked personal is " +
      'never picked automatically under either mode.',
    defaultValue: 'workers',
    validate: (v) =>
      (AUTO_POOL_MODES as readonly string[]).includes(v as string)
        ? null
        : `auto.pool must be one of ${AUTO_POOL_MODES.join(' | ')}.`,
  },
  {
    name: 'browser.profile',
    yamlKey: 'defaultBrowserProfile',
    scope: 'device',
    visibility: 'machine',
    type: 'string',
    description:
      'Browser profile `agents browser start` resolves to without --profile (set via `agents browser use`).',
  },
  {
    name: 'agents.max-concurrent',
    yamlKey: 'maxAgents',
    scope: 'device',
    visibility: 'shared',
    type: 'int',
    description:
      'Cap on concurrent agents on this device. What counts toward it depends on the consumer: ' +
      'AGI EXT auto-launch counts device-wide running agents; teams placement counts the team’s own roster on the device.',
    validate: (v) => ((v as number) >= 1 ? null : 'agents.max-concurrent must be >= 1.'),
  },
  {
    name: 'scheduler.enabled',
    yamlKey: 'schedulerEnabled',
    scope: 'device',
    visibility: 'machine',
    type: 'bool',
    defaultValue: true,
    description: 'Whether the routines scheduler (daemon) may fire on this device.',
  },
  {
    name: 'daemon.enabled',
    yamlKey: 'daemonEnabled',
    scope: 'device',
    visibility: 'machine',
    type: 'bool',
    defaultValue: true,
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
    visibility: 'shared',
    type: 'bool',
    defaultValue: false,
    description: 'Whether the daemon runs the watchdog pass on this device.',
  },
  {
    name: 'tmux.enabled',
    yamlKey: 'tmuxEnabled',
    scope: 'device',
    visibility: 'machine',
    type: 'bool',
    defaultValue: true,
    description:
      'Whether an interactive `agents run` on this device is wrapped in the shared-socket tmux session. ' +
      'On gives every agent an addressable pane (`agents sessions --active` tells co-located agents apart, ' +
      '`agents focus` re-attaches without forking). Off spawns the agent directly on this box — the durable ' +
      'form of `--no-tmux`, for a machine whose tmux is broken or unwanted.',
  },
  {
    name: 'browser.remote-control',
    yamlKey: 'browserRemoteControl',
    scope: 'device',
    visibility: 'machine',
    type: 'bool',
    defaultValue: false,
    description:
      "Whether other fleet machines may drive THIS device's browser over `browser --device <this-device>`. " +
      'Default off — a fleet-remote drive is refused until the owner runs `agents browser remote-control on`.',
  },
  {
    name: 'browser.task-idle-minutes',
    yamlKey: 'browserTaskIdleMinutes',
    scope: 'device',
    visibility: 'machine',
    type: 'int',
    defaultValue: 30,
    description:
      'Minutes a browser task may sit with no IPC action (navigate, click, type, screenshot, …) before the daemon\'s ' +
      'abandoned-task reaper closes its tabs and marks it done (RUSH-2622). 0 disables idle reaping — the reaper still ' +
      "closes a task whose owning agent session has exited, whatever this is set to. Read only on THIS box's own " +
      'reaper tick and `agents browser gc`, so it never applies to a peer.',
    validate: (v) =>
      (v as number) >= 0 ? null : 'browser.task-idle-minutes must be >= 0 (0 disables idle reaping).',
  },
  {
    name: 'notes',
    yamlKey: 'notes',
    scope: 'device',
    visibility: 'shared',
    type: 'string-list',
    description:
      'Free-form operator notes about this device (one entry per `agents devices config <name> notes <text>`). ' +
      'Long-form scratch, never shown in device listings — for the one-line synced summary of what the box is for, use `description`.',
  },
  {
    name: 'description',
    yamlKey: 'description',
    scope: 'device',
    visibility: 'shared',
    type: 'string',
    description:
      'One line saying what this device is FOR ("gpu box — cuda 12.4"), synced fleet-wide. Kept to one short line ' +
      'because the device-list renderer will show it (RUSH-3062, `surface` track). ' +
      'Replaces the value on each set; for appended long-form scratch use `notes`.',
    validate: (v) => {
      const s = v as string;
      if (s.includes('\n') || s.includes('\r')) return 'description must be a single line.';
      if (s.length > 80) return `description must be at most 80 characters (got ${s.length}) — it is a one-line table cell.`;
      return null;
    },
  },
  {
    name: 'ssh.user',
    yamlKey: 'sshUser',
    scope: 'device',
    visibility: 'shared',
    type: 'string',
    description: 'SSH login user for the device — overrides the registry profile’s user at dial time.',
  },
  {
    name: 'ssh.auth',
    yamlKey: 'sshAuth',
    scope: 'device',
    visibility: 'shared',
    type: 'string',
    description: 'SSH auth method: `key` (ssh agent / on-disk keys) or `password` (pulled from a secrets bundle).',
    validate: (v) =>
      (SSH_AUTH_METHODS as readonly string[]).includes(v as string)
        ? null
        : `ssh.auth must be one of ${SSH_AUTH_METHODS.join(' | ')}.`,
  },
  {
    name: 'ssh.bundle',
    yamlKey: 'sshBundle',
    scope: 'device',
    visibility: 'shared',
    type: 'string',
    description: 'Secrets bundle holding the SSH password (for ssh.auth=password). A bundle NAME — never a secret value.',
  },
  {
    name: 'ssh.bundle-key',
    yamlKey: 'sshBundleKey',
    scope: 'device',
    visibility: 'shared',
    type: 'string',
    description: "Key within the bundle whose value is the password (default 'password').",
  },
  {
    name: 'ssh.identity-file',
    yamlKey: 'sshIdentityFile',
    scope: 'device',
    visibility: 'shared',
    type: 'string',
    description: 'Explicit private-key path for key auth (passed to OpenSSH with IdentitiesOnly=yes).',
  },
  {
    name: 'platform',
    yamlKey: 'platform',
    scope: 'device',
    visibility: 'shared',
    type: 'string',
    description: 'OS family of the device — picks PowerShell vs POSIX on the remote end. Overrides the discovered platform.',
    validate: (v) =>
      (DEVICE_PLATFORMS as readonly string[]).includes(v as string)
        ? null
        : `platform must be one of ${DEVICE_PLATFORMS.join(' | ')}.`,
  },
  {
    name: 'role',
    yamlKey: 'role',
    scope: 'device',
    visibility: 'shared',
    type: 'string',
    description:
      "What this device is for, fleet-wide: 'worker' (a box agents run on) or 'personal' (a machine you sit at — never " +
      'picked automatically). Marking ANY device worker turns automatic placement into an allowlist: `--device auto` then ' +
      'picks only from the marked workers.',
    validate: (v) =>
      (DEVICE_ROLES as readonly string[]).includes(v as string)
        ? null
        : `role must be one of ${DEVICE_ROLES.join(' | ')}.`,
  },
  {
    name: 'auto-launch.enabled',
    yamlKey: 'autoLaunchEnabled',
    scope: 'device',
    visibility: 'shared',
    type: 'bool',
    defaultValue: true,
    description: 'Whether AGI EXT auto-launch may pick this device (default on).',
  },
  {
    name: 'auto-launch.preferred',
    yamlKey: 'autoLaunchPreferred',
    scope: 'device',
    visibility: 'shared',
    type: 'bool',
    defaultValue: false,
    description: 'Boost this device in AGI EXT auto-launch ranking (default off).',
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

// ─── Migration hook ───────────────────────────────────────────────────────────

let migrationDone = false;

/**
 * Fold the legacy config/pins stores into the current layout, once per
 * process. A failure is loud but non-fatal — config reads must keep working,
 * and the next process retries the fold. Honors AGENTS_SKIP_MIGRATION=1, the
 * same gate bootstrap's runMigration uses (tests pin it so a fork never folds
 * the developer's real ~/.agents as a side effect).
 */
export function ensureDeviceConfigMigrated(): void {
  if (migrationDone || process.env.AGENTS_SKIP_MIGRATION === '1') return;
  try {
    migrateDeviceConfigStores();
    migrationDone = true;
  } catch (err: any) {
    console.error(`device config migration failed (${err?.message ?? err}); a later run retries`);
  }
}

// ─── Layer reads ──────────────────────────────────────────────────────────────

/** Path to a device's tracked operator doc (`devices/<name>/agents.yaml`). */
function deviceDocPath(device: string): string {
  return path.join(getUserAgentsDir(), 'devices', device, 'agents.yaml');
}

/**
 * Read a device's doc. Returns null when the file does not exist. A malformed
 * file is a hard error — silently returning null would let the next write wipe
 * the device's routines/config (same contract as routine-activation's reader).
 */
function readDeviceDoc(device: string): Record<string, unknown> | null {
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
  const doc = parsed as Record<string, unknown>;
  if (doc.config !== undefined && (typeof doc.config !== 'object' || doc.config === null || Array.isArray(doc.config))) {
    throw corrupted('config: must be a mapping');
  }
  return doc;
}

/** Write a device doc (atomic), preserving keys this module does not own
 * (`routines:`). A doc left empty is removed instead of leaving an empty
 * tracked file behind. */
function writeDeviceDoc(device: string, doc: Record<string, unknown>): void {
  const p = deviceDocPath(device);
  if (Object.keys(doc).length === 0) {
    try {
      fs.rmSync(p, { force: true });
      fs.rmdirSync(path.dirname(p));
    } catch { /* dir not empty, or the file was already gone */ }
    return;
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  atomicWriteFileSync(p, META_HEADER + yaml.stringify(doc));
}

/** The fleet-defaults config layer (central `fleet.defaults.config`; {} when unset). */
export function readFleetConfigDefaults(): Record<string, unknown> {
  const config = readMeta().fleet?.defaults?.config;
  return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
}

/** The device layer only: the doc's `config:` block ({} when unset). */
function readDeviceDocConfig(device: string): Record<string, unknown> {
  return (readDeviceDoc(device)?.config as Record<string, unknown> | undefined) ?? {};
}

/**
 * The effective device-scope config block for `device`: fleet.defaults.config
 * overlaid with the per-device doc's config:. This is the single read path
 * post-migration — the profile resolver (`lib/devices/resolve-profile.ts`)
 * goes through here. Deliberately does NOT auto-trigger the migration: it
 * serves the hot dial/render paths. Sync and cheap (small local files).
 */
export function readDeviceConfigValues(device: string): Record<string, unknown> {
  return { ...readFleetConfigDefaults(), ...readDeviceDocConfig(device) };
}

/** The device a targeted read/write applies to (default: this machine). */
function targetDevice(opts?: ConfigTarget): string {
  return opts?.device ?? machineId();
}

/**
 * A machine-visibility key is only ever readable for THIS box. Asking for a
 * peer's value is a mistake with a concrete fix, so say so rather than
 * silently returning this machine's answer for another machine.
 */
function assertLocalTarget(spec: ConfigKeySpec, device: string): void {
  if (spec.scope !== 'device' || spec.visibility !== 'machine') return;
  if (device === machineId()) return;
  throw new Error(
    `${spec.name} is machine-local, so it can only be read or set on the device itself.\n` +
    `Run it on ${device}, e.g.: agents ssh ${device} 'agents devices config ${device} ${spec.name} <value>'`,
  );
}

/** Get one config key's effective value and the layer that set it. */
export function getConfigValue(name: string, opts?: ConfigTarget): ConfigEntry {
  ensureDeviceConfigMigrated();
  const spec = configKeySpec(name);
  if (spec.scope === 'user') {
    const value = readMeta().config?.[spec.yamlKey];
    return { spec, value, source: value !== undefined ? 'user' : 'default' };
  }
  if (opts?.fleet) {
    const value = readFleetConfigDefaults()[spec.yamlKey];
    return { spec, value, source: value !== undefined ? 'fleet' : 'default' };
  }
  const device = targetDevice(opts);
  assertLocalTarget(spec, device);
  const docConfig = readDeviceDocConfig(device);
  if (spec.yamlKey in docConfig) return { spec, value: docConfig[spec.yamlKey], source: 'device' };
  const fleetConfig = readFleetConfigDefaults();
  if (spec.yamlKey in fleetConfig) return { spec, value: fleetConfig[spec.yamlKey], source: 'fleet' };
  return { spec, value: undefined, source: 'default' };
}

/**
 * List every known key with its effective value and the layer that set it.
 *
 * Listing a PEER omits its machine-local keys rather than throwing — those
 * values live on that box and are unknowable from here, but a bulk listing
 * must not hard-fail. Asking for such a key by name still errors.
 */
export function listConfig(opts?: ConfigTarget): ConfigEntry[] {
  const isPeer = !opts?.fleet && targetDevice(opts) !== machineId();
  const visible = isPeer
    ? CONFIG_KEYS.filter((spec) => spec.scope !== 'device' || spec.visibility !== 'machine')
    : CONFIG_KEYS;
  return visible.map((spec) => getConfigValue(spec.name, opts));
}

/** List user-scope config keys with their values. Used to show inherited settings
 * in per-device views without implying those keys are device-local. */
export function listUserConfig(): ConfigEntry[] {
  return CONFIG_KEYS.filter((spec) => spec.scope === 'user').map((spec) => getConfigValue(spec.name));
}

/** Resolve the explicit usage host, falling back to the user's interactive host. */
export function resolveUsagePrimaryHost(): string | null {
  return (getConfigValue('usage.primary-host').value as string | undefined)
    ?? (getConfigValue('interactive.host').value as string | undefined)
    ?? null;
}

// ─── Writes ───────────────────────────────────────────────────────────────────

/** The fleet manifest for a defaults write: `devices` materializes as an
 * explicit empty map (NOT 'all') so `agents apply` targets nothing until the
 * operator declares a roster. */
function fleetForDefaultsWrite(fleet: FleetManifest | undefined): FleetManifest {
  return { ...fleet, devices: fleet && fleet.devices !== undefined ? fleet.devices : {} };
}

function setInFleetDefaults(spec: ConfigKeySpec, value: unknown): void {
  updateMeta((m) => {
    const fleet = fleetForDefaultsWrite(m.fleet);
    const defaults = { ...fleet.defaults, config: { ...fleet.defaults?.config, [spec.yamlKey]: value } };
    return { ...m, fleet: { ...fleet, defaults } };
  });
}

function unsetInFleetDefaults(spec: ConfigKeySpec): void {
  updateMeta((m) => {
    const stored = m.fleet?.defaults?.config;
    if (!stored || !(spec.yamlKey in stored)) return m; // nothing stored — no-op
    const config = { ...stored };
    delete config[spec.yamlKey];
    const defaults = { ...m.fleet!.defaults };
    if (Object.keys(config).length > 0) defaults.config = config;
    else delete defaults.config;
    const fleet: FleetManifest = { ...m.fleet!, devices: m.fleet!.devices };
    if (Object.keys(defaults).length > 0) fleet.defaults = defaults;
    else delete fleet.defaults;
    // Drop the fleet block entirely when the unset emptied a block that holds
    // nothing else — don't leave a vestigial `fleet: {devices: {}}` behind.
    const devicesEmpty = fleet.devices == null || fleet.devices === 'all'
      ? false
      : Object.keys(fleet.devices).length === 0;
    if (devicesEmpty && !fleet.defaults && !fleet.secrets && !fleet.routines) {
      const { fleet: _, ...rest } = m;
      void _;
      return rest;
    }
    return { ...m, fleet };
  });
}

function setInDeviceDoc(device: string, spec: ConfigKeySpec, value: unknown): void {
  // The doc is shared with writeMetaUnlocked (which owns routines:) — the
  // read-modify-write runs under the meta lock so the two writers can't lose
  // each other's update across processes.
  withMetaLock(() => {
    const doc = readDeviceDoc(device) ?? {};
    doc.config = { ...(doc.config as Record<string, unknown> | undefined), [spec.yamlKey]: value };
    writeDeviceDoc(device, doc);
  });
}

function unsetInDeviceDoc(device: string, spec: ConfigKeySpec): void {
  withMetaLock(() => {
    const doc = readDeviceDoc(device);
    if (!doc) return; // nothing stored — unset is a no-op
    const config = doc.config as Record<string, unknown> | undefined;
    if (!config || !(spec.yamlKey in config)) return; // key not present — no write needed
    delete config[spec.yamlKey];
    if (Object.keys(config).length > 0) doc.config = config;
    else delete doc.config;
    writeDeviceDoc(device, doc);
  });
}

/**
 * Set a config key (validated). Device-scope keys target this machine unless
 * `opts.device` names a peer; `opts.fleet` writes the fleet-wide defaults layer
 * instead. User-scope keys reject `fleet` (they are already fleet-wide).
 */
export function setConfigValue(name: string, value: unknown, opts?: ConfigTarget): void {
  ensureDeviceConfigMigrated();
  const spec = configKeySpec(name);
  assertValidValue(spec, value);
  if (spec.scope === 'user') {
    if (opts?.fleet) {
      throw new Error(`Config key '${spec.name}' is user-scope (already fleet-wide) — --fleet does not apply.`);
    }
    updateMeta((m) => ({ ...m, config: { ...m.config, [spec.yamlKey]: value } }));
    return;
  }
  if (opts?.fleet) {
    setInFleetDefaults(spec, value);
    return;
  }
  const device = targetDevice(opts);
  assertLocalTarget(spec, device);
  setInDeviceDoc(device, spec, value);
}

/** Unset a config key — restores the next layer down (fleet default, then the
 * built-in default). No-op when already unset at that layer. */
export function unsetConfigValue(name: string, opts?: ConfigTarget): void {
  ensureDeviceConfigMigrated();
  const spec = configKeySpec(name);
  if (spec.scope === 'user') {
    if (opts?.fleet) {
      throw new Error(`Config key '${spec.name}' is user-scope (already fleet-wide) — --fleet does not apply.`);
    }
    updateMeta((m) => {
      if (!m.config || !(spec.yamlKey in m.config)) return m;
      const next = { ...m.config };
      delete next[spec.yamlKey];
      return { ...m, config: Object.keys(next).length > 0 ? next : undefined };
    });
    return;
  }
  if (opts?.fleet) {
    unsetInFleetDefaults(spec);
    return;
  }
  const device = targetDevice(opts);
  assertLocalTarget(spec, device);
  unsetInDeviceDoc(device, spec);
}

// ─── Device roles + the automatic-placement pool ──────────────────────────────

/** A role an operator marked a device with (`agents devices role <name> <role>`). */
export type ConfiguredDeviceRole = (typeof DEVICE_ROLES)[number];

/** Which devices automatic placement may pick (`auto.pool`). */
export type AutoPoolMode = (typeof AUTO_POOL_MODES)[number];

/**
 * The role marked on one device, or undefined when the operator never marked it.
 *
 * Undefined is meaningful and is NOT the same as `worker`: an unmarked device is
 * eligible for automatic placement only while no device anywhere carries an
 * explicit `worker` mark (see {@link listConfiguredDeviceRoles}).
 */
export function configuredDeviceRole(name: string): ConfiguredDeviceRole | undefined {
  assertValidDeviceName(name);
  return getConfigValue('role', { device: name }).value as ConfiguredDeviceRole | undefined;
}

/**
 * The role marked on THIS machine — the one running the CLI — or undefined when
 * it was never marked. Keyed off {@link machineId} (overridable via
 * AGENTS_SYNC_MACHINE_ID), so it matches the device's own config-folder key.
 *
 * The auth strategy reads this: a `personal` device (the user's own interactive
 * box) holds a real per-version login and MUST authenticate from it for EVERY
 * run, interactive or headless; only a `worker` uses the file-based setup-token
 * (RUSH-2395). `undefined` is treated as non-personal (worker-equivalent) by
 * that gate — an unmarked box has no login to defer to.
 */
export function selfConfiguredDeviceRole(): ConfiguredDeviceRole | undefined {
  return configuredDeviceRole(machineId());
}

/** Mark a device's role fleet-wide; `undefined` clears the mark. */
export function setConfiguredDeviceRole(name: string, role: ConfiguredDeviceRole | undefined): void {
  assertValidDeviceName(name);
  if (role === undefined) unsetConfigValue('role', { device: name });
  else setConfigValue('role', role, { device: name });
}

/**
 * Every device with an effective role, keyed by device name. Layers like every
 * other device-scope key: the fleet default (central fleet.defaults.config)
 * applies fleet-wide and the per-device doc wins on conflict. `roster` (the
 * registered device names) lets a fleet default reach devices that have no doc
 * of their own; without it only devices with docs are considered — so a
 * fleet-wide `role` default would silently miss a doc-less device and drop it
 * from the worker allowlist. Mirrors {@link loadAutoLaunchPreferences}.
 */
export function listConfiguredDeviceRoles(roster?: string[]): Record<string, ConfiguredDeviceRole> {
  ensureDeviceConfigMigrated();
  const out: Record<string, ConfiguredDeviceRole> = {};
  const fleetRole = readFleetConfigDefaults().role;
  const names = new Set(roster ?? []);
  if (!roster) {
    const devicesRoot = path.join(getUserAgentsDir(), 'devices');
    try {
      for (const entry of fs.readdirSync(devicesRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) names.add(entry.name);
      }
    } catch { /* no devices/ tree — roster stays empty */ }
  }
  for (const name of names) {
    const role = readDeviceDocConfig(name).role ?? fleetRole;
    if (typeof role === 'string' && (DEVICE_ROLES as readonly string[]).includes(role)) {
      out[name] = role as ConfiguredDeviceRole;
    }
  }
  return out;
}

/** The configured automatic-placement pool mode. Unset means `workers`. */
export function autoPoolMode(): AutoPoolMode {
  const value = getConfigValue('auto.pool').value;
  return value === 'all' ? 'all' : 'workers';
}

// ─── Auto-launch preferences (Factory auto-host selection) ────────────────────

/** A device's auto-launch flags, as read by Factory's launch ranking. */
export interface AutoLaunchPreference {
  enabled?: boolean;
  preferred?: boolean;
}

/** True if the device is enabled for auto-launch. Unset defaults to true. */
export function isAutoLaunchEnabled(name: string): boolean {
  assertValidDeviceName(name);
  return getConfigValue('auto-launch.enabled', { device: name }).value !== false;
}

/** Set whether a device is enabled for auto-launch. Setting the default
 * (enabled) removes the key to keep the doc minimal. */
export function setAutoLaunchEnabled(name: string, enabled: boolean): void {
  assertValidDeviceName(name);
  if (enabled) unsetConfigValue('auto-launch.enabled', { device: name });
  else setConfigValue('auto-launch.enabled', false, { device: name });
}

/** True if the device is preferred for auto-launch ranking. */
export function isAutoLaunchPreferred(name: string): boolean {
  assertValidDeviceName(name);
  return getConfigValue('auto-launch.preferred', { device: name }).value === true;
}

/** Set whether a device is preferred for auto-launch. Setting the default
 * (not preferred) removes the key to keep the doc minimal. */
export function setAutoLaunchPreferred(name: string, preferred: boolean): void {
  assertValidDeviceName(name);
  if (preferred) setConfigValue('auto-launch.preferred', true, { device: name });
  else unsetConfigValue('auto-launch.preferred', { device: name });
}

/**
 * Every device's effective auto-launch flags, keyed by device name — the shape
 * the menu-bar snapshot consumes. Layers like every other device-scope key: the
 * fleet default (central fleet.defaults.config) applies fleet-wide and the
 * per-device doc wins on conflict. `roster` (the registered device names) lets
 * a fleet default reach devices that have no doc of their own; without it only
 * devices with docs are listed.
 */
export function loadAutoLaunchPreferences(roster?: string[]): Record<string, AutoLaunchPreference> {
  ensureDeviceConfigMigrated();
  const fleet = readFleetConfigDefaults();
  const names = new Set(roster ?? []);
  if (!roster) {
    const devicesRoot = path.join(getUserAgentsDir(), 'devices');
    try {
      for (const entry of fs.readdirSync(devicesRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) names.add(entry.name);
      }
    } catch { /* no devices/ tree — roster stays empty */ }
  }
  const out: Record<string, AutoLaunchPreference> = {};
  for (const name of names) {
    const doc = readDeviceDocConfig(name);
    const enabled = (doc.autoLaunchEnabled ?? fleet.autoLaunchEnabled) as boolean | undefined;
    const preferred = (doc.autoLaunchPreferred ?? fleet.autoLaunchPreferred) as boolean | undefined;
    const pref: AutoLaunchPreference = {};
    if (enabled === false) pref.enabled = false;
    if (preferred === true) pref.preferred = true;
    if (pref.enabled !== undefined || pref.preferred !== undefined) out[name] = pref;
  }
  return out;
}

// ─── Consumers' helpers ───────────────────────────────────────────────────────

/** True unless this machine's config disables the routines scheduler. */
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
      `Re-enable with: agents devices config ${machineId()} scheduler.enabled on`,
  );
}

/**
 * True unless this machine's config turns off the managed tmux wrap for
 * interactive `agents run` launches (`tmux.enabled=false`).
 *
 * Read as one of the guards in `shouldWrapInTmux` (lib/exec.ts) — the durable,
 * per-machine form of `--no-tmux` / `AGENTS_NO_TMUX=1`, for a box whose tmux is
 * broken or unwanted. Unset means today's behavior: wrap.
 */
export function isTmuxEnabled(): boolean {
  return getConfigValue('tmux.enabled').value !== false;
}

/** True unless this machine's config disables the daemon outright (top-level kill switch). */
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
 * Idle window (ms) the browser-task reaper (`browser/hygiene.ts`) uses on THIS
 * machine, or `null` when idle reaping is off (`browser.task-idle-minutes=0`)
 * — session-dead reaping is unaffected either way. Unset means the default 30
 * minutes. Read by the daemon's periodic tick and, as the fallback when a
 * caller omits `--idle-minutes`, by the `gc` IPC action.
 */
export function resolveBrowserTaskIdleMs(): number | null {
  const minutes = (getConfigValue('browser.task-idle-minutes').value as number | undefined) ?? 30;
  return minutes === 0 ? null : minutes * 60_000;
}

/**
 * Read the effective `agents.max-concurrent` cap for each named device (fleet
 * defaults layered under the per-device doc; no SSH). Devices without a cap
 * are omitted — uncapped is the default. Used as an input to host ranking
 * (teams placement, AGI EXT auto-launch), never as a remote probe.
 */
export function readMaxConcurrentCaps(devices: string[]): Record<string, number> {
  const caps: Record<string, number> = {};
  for (const device of devices) {
    const value = getConfigValue('agents.max-concurrent', { device }).value;
    if (typeof value === 'number') caps[device] = value;
  }
  return caps;
}
