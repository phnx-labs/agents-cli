import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
