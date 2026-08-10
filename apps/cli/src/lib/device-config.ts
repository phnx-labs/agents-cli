/**
 * Device/user config keys — typed read/write over the central agents.yaml store.
 *
 * One registry (`CONFIG_KEYS`) maps each CLI dotted name to where it lives:
 *   - user scope   → central `~/.agents/agents.yaml` under `config:` (syncs
 *                    fleet-wide via `agents repo push/pull`)
 *   - device scope → central `~/.agents/agents.yaml` under
 *                    `fleet.devices.<name>.config` — the ONE store for
 *                    per-device operator settings. Central means a setting is
 *                    readable/writable from any box, syncs with the repo, and
 *                    is backed up with it. Names and non-secret values only
 *                    (a secrets-bundle NAME is fine; a credential never is).
 *
 * The device registry (`~/.agents/.history/devices/registry.json`) stays the
 * DISCOVERY cache (address, tailscale snapshot, reachability); the profile
 * fields config can override (ssh.*, platform, user) are overlaid onto it at
 * read time by `lib/devices/resolve-profile.ts`.
 *
 * Legacy stores (per-device `devices/<host>/agents.yaml` config and
 * `.history/devices/auto-launch.json`) are folded into the central block once
 * by `lib/devices/config-migration.ts`, invoked on the first read/write in a
 * process — after migration there is ONE read path, no fallback branches.
 *
 * Unset always means today's behavior (the documented default).
 */

import { readMeta, updateMeta } from './state.js';
import { machineId } from './machine-id.js';
import { assertValidDeviceName } from './devices/registry.js';
import { fleetDevicesMapForWrite, migrateDeviceConfigToCentral } from './devices/config-migration.js';

/** Which tier of the agents.yaml store a key lives in. */
export type ConfigScope = 'user' | 'device';

/** Value type of a config key — drives validation and `--json` rendering. */
export type ConfigType = 'string' | 'int' | 'bool' | 'string-list';

/** One known config key. */
export interface ConfigKeySpec {
  /** CLI dotted name, e.g. `interactive.host`. */
  name: string;
  /** camelCase key under the YAML config block. */
  yamlKey: string;
  scope: ConfigScope;
  type: ConfigType;
  /** One-line description for help/list output. */
  description: string;
  /** The effective value when the key is unset (bool keys; drives the interactive menu's default). */
  defaultValue?: unknown;
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

/** Options scoping a read/write to a specific device (default: this machine). */
export interface ConfigTarget {
  device?: string;
}

const DEVICE_PLATFORMS = ['windows', 'linux', 'macos', 'unknown'] as const;
const SSH_AUTH_METHODS = ['key', 'password'] as const;

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
      'AGI EXT auto-launch counts device-wide running agents; teams placement counts the team’s own roster on the device.',
    validate: (v) => ((v as number) >= 1 ? null : 'agents.max-concurrent must be >= 1.'),
  },
  {
    name: 'scheduler.enabled',
    yamlKey: 'schedulerEnabled',
    scope: 'device',
    type: 'bool',
    defaultValue: true,
    description: 'Whether the routines scheduler (daemon) may fire on this device.',
  },
  {
    name: 'daemon.enabled',
    yamlKey: 'daemonEnabled',
    scope: 'device',
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
    type: 'bool',
    defaultValue: false,
    description: 'Whether the daemon runs the watchdog pass on this device.',
  },
  {
    name: 'browser.remote-control',
    yamlKey: 'browserRemoteControl',
    scope: 'device',
    type: 'bool',
    defaultValue: false,
    description:
      "Whether other fleet machines may drive THIS device's browser over `browser --host <this-device>`. " +
      'Default off — a fleet-remote drive is refused until the owner runs `agents browser remote-control on`.',
  },
  {
    name: 'notes',
    yamlKey: 'notes',
    scope: 'device',
    type: 'string-list',
    description: 'Free-form operator notes about this device (one entry per `agents devices config <name> notes <text>`).',
  },
  {
    name: 'ssh.user',
    yamlKey: 'sshUser',
    scope: 'device',
    type: 'string',
    description: 'SSH login user for the device — overrides the registry profile’s user at dial time.',
  },
  {
    name: 'ssh.auth',
    yamlKey: 'sshAuth',
    scope: 'device',
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
    type: 'string',
    description: 'Secrets bundle holding the SSH password (for ssh.auth=password). A bundle NAME — never a secret value.',
  },
  {
    name: 'ssh.bundle-key',
    yamlKey: 'sshBundleKey',
    scope: 'device',
    type: 'string',
    description: "Key within the bundle whose value is the password (default 'password').",
  },
  {
    name: 'ssh.identity-file',
    yamlKey: 'sshIdentityFile',
    scope: 'device',
    type: 'string',
    description: 'Explicit private-key path for key auth (passed to OpenSSH with IdentitiesOnly=yes).',
  },
  {
    name: 'platform',
    yamlKey: 'platform',
    scope: 'device',
    type: 'string',
    description: 'OS family of the device — picks PowerShell vs POSIX on the remote end. Overrides the discovered platform.',
    validate: (v) =>
      (DEVICE_PLATFORMS as readonly string[]).includes(v as string)
        ? null
        : `platform must be one of ${DEVICE_PLATFORMS.join(' | ')}.`,
  },
  {
    name: 'auto-launch.enabled',
    yamlKey: 'autoLaunchEnabled',
    scope: 'device',
    type: 'bool',
    defaultValue: true,
    description: 'Whether AGI EXT auto-launch may pick this device (default on).',
  },
  {
    name: 'auto-launch.preferred',
    yamlKey: 'autoLaunchPreferred',
    scope: 'device',
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
 * Fold the legacy per-device config stores into the central block, once per
 * process. A failure is loud but non-fatal — config reads must keep working,
 * and the next process retries the fold. Honors AGENTS_SKIP_MIGRATION=1, the
 * same gate bootstrap's runMigration uses (tests pin it so a fork never folds
 * the developer's real ~/.agents as a side effect).
 *
 * Call this ONLY from a lifecycle entry point (daemon boot, `runMigration`).
 * It must never hang off a config read or write: `~/.agents/agents.yaml` is a
 * tracked file shared by every machine in the fleet, so a migration on the read
 * path means an ordinary `agents config get` can dirty the shared file. That is
 * what left yosemite-s0 unable to pull — 13 machines each rewriting one tracked
 * path, on nearly every command.
 */
export function ensureDeviceConfigMigrated(): void {
  if (migrationDone || process.env.AGENTS_SKIP_MIGRATION === '1') return;
  try {
    migrateDeviceConfigToCentral();
    migrationDone = true;
  } catch (err: any) {
    console.error(`device config migration failed (${err?.message ?? err}); a later run retries`);
  }
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * The raw device-scope config block for `device` from the central
 * `fleet.devices.<name>.config` map ({} when unset). This is the single read
 * path post-migration — the profile resolver (`lib/devices/resolve-profile.ts`)
 * goes through here. Deliberately does NOT auto-trigger the migration: it
 * serves the hot dial/render paths, and the keys it resolves (ssh.*, platform)
 * are new — they never existed in the legacy stores. Keys with legacy data are
 * read through the public API below, which triggers the fold.
 */
export function readDeviceConfigValues(device: string): Record<string, unknown> {
  const devices = readMeta().fleet?.devices;
  if (!devices || devices === 'all') return {};
  const config = devices[device]?.config;
  return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
}

/** The device a targeted read/write applies to (default: this machine). */
function targetDevice(opts?: ConfigTarget): string {
  return opts?.device ?? machineId();
}

/** Get one config key's value and the layer that set it. */
export function getConfigValue(name: string, opts?: ConfigTarget): ConfigEntry {
  const spec = configKeySpec(name);
  if (spec.scope === 'user') {
    const value = readMeta().config?.[spec.yamlKey];
    return { spec, value, layer: value !== undefined ? 'user' : undefined };
  }
  const value = readDeviceConfigValues(targetDevice(opts))[spec.yamlKey];
  return { spec, value, layer: value !== undefined ? 'device' : undefined };
}

/** List every known key with its value and the layer that set it. */
export function listConfig(opts?: ConfigTarget): ConfigEntry[] {
  return CONFIG_KEYS.map((spec) => getConfigValue(spec.name, opts));
}

/** List user-scope config keys with their values. Used to show inherited settings
 * in per-device views without implying those keys are device-local. */
export function listUserConfig(): ConfigEntry[] {
  return CONFIG_KEYS.filter((spec) => spec.scope === 'user').map((spec) => getConfigValue(spec.name));
}

// ─── Writes ───────────────────────────────────────────────────────────────────

function setInCentralBlock(device: string, spec: ConfigKeySpec, value: unknown): void {
  updateMeta((m) => {
    const devices = fleetDevicesMapForWrite(m.fleet);
    const prev = devices[device] ?? {};
    devices[device] = { ...prev, config: { ...prev.config, [spec.yamlKey]: value } };
    return { ...m, fleet: { ...m.fleet, devices } };
  });
}

function unsetInCentralBlock(device: string, spec: ConfigKeySpec): void {
  updateMeta((m) => {
    const stored = m.fleet?.devices;
    if (!stored || stored === 'all') return m; // nothing stored — unset is a no-op (never upgrade 'all' for one)
    const prev = stored[device];
    if (!prev?.config || !(spec.yamlKey in prev.config)) return m; // key not present — no write needed
    const config = { ...prev.config };
    delete config[spec.yamlKey];
    const override = { ...prev };
    if (Object.keys(config).length > 0) override.config = config;
    else delete override.config;
    const devices = { ...stored };
    if (Object.keys(override).length > 0) devices[device] = override;
    else delete devices[device];
    const fleet = { ...m.fleet, devices };
    // Drop the fleet block entirely when the unset emptied a block that holds
    // nothing else — don't leave a vestigial `fleet: {devices: {}}` behind.
    if (Object.keys(devices).length === 0 && !fleet.defaults && !fleet.secrets && !fleet.routines) {
      const { fleet: _, ...rest } = m;
      void _;
      return rest;
    }
    return { ...m, fleet };
  });
}

/** Set a config key (validated). Device-scope keys target this machine unless `opts.device` names a peer. */
export function setConfigValue(name: string, value: unknown, opts?: ConfigTarget): void {
  const spec = configKeySpec(name);
  assertValidValue(spec, value);
  if (spec.scope === 'user') {
    updateMeta((m) => ({ ...m, config: { ...m.config, [spec.yamlKey]: value } }));
    return;
  }
  setInCentralBlock(targetDevice(opts), spec, value);
}

/** Unset a config key — restores default behavior. No-op when already unset. */
export function unsetConfigValue(name: string, opts?: ConfigTarget): void {
  const spec = configKeySpec(name);
  if (spec.scope === 'user') {
    updateMeta((m) => {
      if (!m.config || !(spec.yamlKey in m.config)) return m;
      const next = { ...m.config };
      delete next[spec.yamlKey];
      return { ...m, config: Object.keys(next).length > 0 ? next : undefined };
    });
    return;
  }
  unsetInCentralBlock(targetDevice(opts), spec);
}

// ─── Auto-launch preferences (Factory auto-host selection) ────────────────────

/** A device's auto-launch flags, as read by the ext's launch ranking. */
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
 * (enabled) removes the key to keep the block minimal. */
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
 * (not preferred) removes the key to keep the block minimal. */
export function setAutoLaunchPreferred(name: string, preferred: boolean): void {
  assertValidDeviceName(name);
  if (preferred) setConfigValue('auto-launch.preferred', true, { device: name });
  else unsetConfigValue('auto-launch.preferred', { device: name });
}

/** Every device's auto-launch flags, keyed by device name (set flags only) —
 * the shape the ext's launch ranking consumes. */
export function loadAutoLaunchPreferences(): Record<string, AutoLaunchPreference> {
  ensureDeviceConfigMigrated();
  const devices = readMeta().fleet?.devices;
  const out: Record<string, AutoLaunchPreference> = {};
  if (!devices || devices === 'all') return out;
  for (const [name, override] of Object.entries(devices)) {
    const config = override?.config;
    if (!config) continue;
    const pref: AutoLaunchPreference = {};
    if (config.autoLaunchEnabled === false) pref.enabled = false;
    if (config.autoLaunchPreferred === true) pref.preferred = true;
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
    `The routines scheduler is disabled on this device (scheduler.enabled=false in ~/.agents/agents.yaml fleet.devices.${machineId()}.config). ` +
      `Re-enable with: agents devices config ${machineId()} scheduler.enabled on`,
  );
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
    `The daemon is disabled on this device (daemon.enabled=false in ~/.agents/agents.yaml fleet.devices.${machineId()}.config). ` +
      `Re-enable with: agents daemon enable`,
  );
}

/**
 * Read the `agents.max-concurrent` cap for each named device from the central
 * config block (no SSH). Devices without a cap are omitted — uncapped is the
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
