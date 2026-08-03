import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';

export interface AutoLaunchPreference {
  enabled?: boolean;
  preferred?: boolean;
}

export interface AutoLaunchPreferences {
  devices: Record<string, AutoLaunchPreference>;
  updatedAt?: string;
}

function autoLaunchPath(): string {
  const dir =
    process.env.AGENTS_DEVICES_DIR ??
    path.join(os.homedir(), '.agents', '.history', 'devices');
  return path.join(dir, 'auto-launch.json');
}

/**
 * Root of the user DotAgents repo (`~/.agents`), overridable for tests. The
 * per-device config docs (`devices/<host>/agents.yaml`) live here — a
 * different tree from the AGENTS_DEVICES_DIR registry dir above.
 */
function userAgentsDir(): string {
  return process.env.AGENTS_USER_AGENTS_DIR ?? path.join(os.homedir(), '.agents');
}

/**
 * Load auto-launch preferences written by `agents devices enable/disable/prefer`.
 * Synchronous because callers need it during ranking without awaiting another turn.
 *
 * Corruption handling deliberately differs from the CLI's reader of this same
 * file (`apps/cli/src/lib/devices/registry.ts loadAutoLaunchPreferences`, which
 * throws): there, the user typed a command and can act on the error. Here, the
 * caller is a launch the user just triggered, and a bad prefs file must not stop
 * them getting a terminal — so this degrades to "every device enabled, none
 * preferred" (the documented default) and says so on the extension log. It is a
 * stated fallback to a defined state, not a silent swallow.
 */
export function loadAutoLaunchPreferences(): Record<string, AutoLaunchPreference> {
  try {
    const raw = fs.readFileSync(autoLaunchPath(), 'utf-8');
    const parsed = JSON.parse(raw) as AutoLaunchPreferences;
    return parsed.devices && typeof parsed.devices === 'object' ? parsed.devices : {};
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return {};
    console.error('[deviceAutoLaunch] failed to load preferences:', err?.message ?? err);
    return {};
  }
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
 * Read a device's `agents.max-concurrent` cap from its synced device doc
 * (`~/.agents/devices/<name>/agents.yaml`, `config.maxAgents`) — written by
 * `agents devices configure <name> --max-agents N`. Local file read, no SSH;
 * the devices/ tree syncs via the DotAgents repo so the cap the operator set
 * on any box is visible here.
 *
 * Returns undefined when uncapped (the default). Same corruption contract as
 * loadAutoLaunchPreferences above: a malformed doc degrades to "uncapped" with
 * a log line rather than blocking a launch the user just triggered.
 */
export function readDeviceMaxConcurrent(name: string): number | undefined {
  const docPath = path.join(userAgentsDir(), 'devices', name, 'agents.yaml');
  let raw: string;
  try {
    raw = fs.readFileSync(docPath, 'utf-8');
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return undefined;
    console.error('[deviceAutoLaunch] failed to read device doc:', err?.message ?? err);
    return undefined;
  }
  try {
    const parsed = yaml.parse(raw) as { config?: { maxAgents?: unknown } } | null;
    const cap = parsed?.config?.maxAgents;
    return typeof cap === 'number' && Number.isInteger(cap) && cap >= 1 ? cap : undefined;
  } catch (err: any) {
    console.error('[deviceAutoLaunch] failed to parse device doc:', err?.message ?? err);
    return undefined;
  }
}
