import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';

export interface AutoLaunchPreference {
  enabled?: boolean;
  preferred?: boolean;
}

/**
 * Key in the preferences map carrying the FLEET-WIDE defaults layer (central
 * `fleet.defaults.config`). A per-device entry always wins over it; a device
 * with no entry inherits it.
 */
export const FLEET_DEFAULTS_KEY = '*';

/**
 * Root of the user DotAgents repo (`~/.agents`), overridable for tests. The
 * device-config store lives here in two layers: the tracked per-device docs
 * `devices/<name>/agents.yaml` (`config:` block, written by
 * `agents devices config <name> …`) and the central `agents.yaml`
 * `fleet.defaults.config` block (fleet-wide defaults, written by
 * `agents devices config --fleet …`). Both sync via the DotAgents repo, so a
 * cap or flag set on any box is visible here.
 */
function userAgentsDir(): string {
  return process.env.AGENTS_USER_AGENTS_DIR ?? path.join(os.homedir(), '.agents');
}

function isConfigMap(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Corruption handling deliberately differs from the CLI's readers of these
 * files (which throw): there, the user typed a command and can act on the
 * error. Here, the caller is a launch the user just triggered, and a bad
 * config file must not stop them getting a terminal — so every read degrades
 * to "no config" (every device enabled, none preferred, uncapped — the
 * documented defaults) and says so on the extension log. It is a stated
 * fallback to a defined state, not a silent swallow.
 */

/** The central fleet-defaults config layer (`fleet.defaults.config`). */
function readFleetDefaultsConfig(): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(userAgentsDir(), 'agents.yaml'), 'utf-8');
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return {};
    console.error('[deviceAutoLaunch] failed to read central agents.yaml:', err?.message ?? err);
    return {};
  }
  try {
    const parsed = yaml.parse(raw) as {
      fleet?: { defaults?: { config?: Record<string, unknown> } };
    } | null;
    const config = parsed?.fleet?.defaults?.config;
    return isConfigMap(config) ? config : {};
  } catch (err: any) {
    console.error('[deviceAutoLaunch] failed to parse central agents.yaml:', err?.message ?? err);
    return {};
  }
}

/** One device's own config layer (`devices/<name>/agents.yaml` `config:`). */
function readDeviceDocConfig(name: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(userAgentsDir(), 'devices', name, 'agents.yaml'), 'utf-8');
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return {};
    console.error(`[deviceAutoLaunch] failed to read device doc for '${name}':`, err?.message ?? err);
    return {};
  }
  try {
    const parsed = yaml.parse(raw) as { config?: Record<string, unknown> } | null;
    return isConfigMap(parsed?.config) ? parsed.config : {};
  } catch (err: any) {
    console.error(`[deviceAutoLaunch] failed to parse device doc for '${name}':`, err?.message ?? err);
    return {};
  }
}

/** Every device doc's config, keyed by device name. */
function readAllDeviceConfigs(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(userAgentsDir(), 'devices'), { withFileTypes: true });
  } catch {
    return out; // no devices/ tree — no flags
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const config = readDeviceDocConfig(entry.name);
    if (Object.keys(config).length > 0) out[entry.name] = config;
  }
  return out;
}

function flagsFromConfig(config: Record<string, unknown>): AutoLaunchPreference {
  const pref: AutoLaunchPreference = {};
  // Record any boolean the operator actually wrote — including an explicit
  // `true`, which is how a device overrides a fleet-wide `false`.
  if (typeof config.autoLaunchEnabled === 'boolean') pref.enabled = config.autoLaunchEnabled;
  if (typeof config.autoLaunchPreferred === 'boolean') pref.preferred = config.autoLaunchPreferred;
  return pref;
}

/**
 * Auto-launch preferences, keyed by device name — the shape launch ranking
 * consumes. Per-device flags come from the device docs; the fleet-wide
 * defaults layer (if it sets auto-launch flags) rides under
 * {@link FLEET_DEFAULTS_KEY} and a device entry always wins over it.
 * Synchronous because callers need it during ranking without awaiting another
 * turn.
 */
export function loadAutoLaunchPreferences(): Record<string, AutoLaunchPreference> {
  const out: Record<string, AutoLaunchPreference> = {};
  const fleetPref = flagsFromConfig(readFleetDefaultsConfig());
  if (fleetPref.enabled !== undefined || fleetPref.preferred !== undefined) {
    out[FLEET_DEFAULTS_KEY] = fleetPref;
  }
  for (const [name, config] of Object.entries(readAllDeviceConfigs())) {
    const pref = flagsFromConfig(config);
    if (pref.enabled !== undefined || pref.preferred !== undefined) out[name] = pref;
  }
  return out;
}

/** True if the device is enabled for auto-launch. Defaults to true. */
export function isAutoLaunchEnabled(
  preferences: Record<string, AutoLaunchPreference>,
  name: string,
): boolean {
  return (preferences[name]?.enabled ?? preferences[FLEET_DEFAULTS_KEY]?.enabled) !== false;
}

/** True if the device is preferred for auto-launch ranking. */
export function isAutoLaunchPreferred(
  preferences: Record<string, AutoLaunchPreference>,
  name: string,
): boolean {
  return (preferences[name]?.preferred ?? preferences[FLEET_DEFAULTS_KEY]?.preferred) === true;
}

/**
 * Read a device's effective `agents.max-concurrent` cap — its own doc's
 * `config.maxAgents`, falling back to the fleet-wide default
 * (`fleet.defaults.config.maxAgents`). Written by
 * `agents devices config <name> agents.max-concurrent N` (or with `--fleet`).
 * Local file reads, no SSH; both files sync via the DotAgents repo so the cap
 * the operator set on any box is visible here.
 *
 * Returns undefined when uncapped (the default). Same corruption contract as
 * loadAutoLaunchPreferences above: a malformed file degrades to "uncapped"
 * rather than blocking a launch the user just triggered.
 */
export function readDeviceMaxConcurrent(name: string): number | undefined {
  const cap = readDeviceDocConfig(name).maxAgents ?? readFleetDefaultsConfig().maxAgents;
  return typeof cap === 'number' && Number.isInteger(cap) && cap >= 1 ? cap : undefined;
}
