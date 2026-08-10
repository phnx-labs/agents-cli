import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';

export interface AutoLaunchPreference {
  enabled?: boolean;
  preferred?: boolean;
}

/**
 * Root of the user DotAgents repo (`~/.agents`), overridable for tests. The
 * central `agents.yaml` lives here — its `fleet.devices.<name>.config` block
 * is the ONE store for per-device operator config (written by
 * `agents devices config <name>`; it syncs via the DotAgents repo, so a cap or
 * flag set on any box is visible here).
 */
function userAgentsDir(): string {
  return process.env.AGENTS_USER_AGENTS_DIR ?? path.join(os.homedir(), '.agents');
}

/**
 * Read the central `fleet.devices` map from `~/.agents/agents.yaml`.
 *
 * Corruption handling deliberately differs from the CLI's reader of this same
 * file (which throws): there, the user typed a command and can act on the
 * error. Here, the caller is a launch the user just triggered, and a bad
 * config file must not stop them getting a terminal — so this degrades to "no
 * device config" (every device enabled, none preferred, uncapped — the
 * documented defaults) and says so on the extension log. It is a stated
 * fallback to a defined state, not a silent swallow.
 */
function readFleetDeviceConfigs(): Record<string, Record<string, unknown>> {
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
      fleet?: { devices?: 'all' | Record<string, { config?: Record<string, unknown> }> };
    } | null;
    const devices = parsed?.fleet?.devices;
    if (!devices || devices === 'all' || typeof devices !== 'object') return {};
    const out: Record<string, Record<string, unknown>> = {};
    for (const [name, override] of Object.entries(devices)) {
      const config = override?.config;
      if (config && typeof config === 'object' && !Array.isArray(config)) out[name] = config;
    }
    return out;
  } catch (err: any) {
    console.error('[deviceAutoLaunch] failed to parse central agents.yaml:', err?.message ?? err);
    return {};
  }
}

/**
 * Auto-launch preferences for every device with a flag set (enabled/preferred),
 * keyed by device name — the shape launch ranking consumes. Synchronous because
 * callers need it during ranking without awaiting another turn.
 */
export function loadAutoLaunchPreferences(): Record<string, AutoLaunchPreference> {
  const configs = readFleetDeviceConfigs();
  const out: Record<string, AutoLaunchPreference> = {};
  for (const [name, config] of Object.entries(configs)) {
    const pref: AutoLaunchPreference = {};
    if (config.autoLaunchEnabled === false) pref.enabled = false;
    if (config.autoLaunchPreferred === true) pref.preferred = true;
    if (pref.enabled !== undefined || pref.preferred !== undefined) out[name] = pref;
  }
  return out;
}

/** True if the device is enabled for auto-launch. Defaults to true. */
export function isAutoLaunchEnabled(
  preferences: Record<string, AutoLaunchPreference>,
  name: string,
): boolean {
  return preferences[name]?.enabled !== false;
}

/** True if the device is preferred for auto-launch ranking. */
export function isAutoLaunchPreferred(
  preferences: Record<string, AutoLaunchPreference>,
  name: string,
): boolean {
  return preferences[name]?.preferred === true;
}

/**
 * Read a device's `agents.max-concurrent` cap from the central config block
 * (`fleet.devices.<name>.config.maxAgents`) — written by
 * `agents devices config <name> agents.max-concurrent N`. Local file read, no
 * SSH; the block syncs via the DotAgents repo so the cap the operator set on
 * any box is visible here.
 *
 * Returns undefined when uncapped (the default). Same corruption contract as
 * loadAutoLaunchPreferences above: a malformed file degrades to "uncapped"
 * rather than blocking a launch the user just triggered.
 */
export function readDeviceMaxConcurrent(name: string): number | undefined {
  const cap = readFleetDeviceConfigs()[name]?.maxAgents;
  return typeof cap === 'number' && Number.isInteger(cap) && cap >= 1 ? cap : undefined;
}
