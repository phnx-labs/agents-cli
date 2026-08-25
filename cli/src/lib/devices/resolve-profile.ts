/**
 * The effective device profile: the registry's discovery record overlaid with
 * the operator's config (the per-device doc `devices/<name>/agents.yaml`
 * `config:` block over central `fleet.defaults.config`).
 *
 * The registry (`~/.agents/.history/devices/registry.json`) stays the
 * discovery cache — address, Tailscale snapshot, reachability, createdAt. The
 * central config owns the operator-set profile fields: `ssh.user`, `ssh.auth`,
 * `ssh.bundle`, `ssh.bundle-key`, `ssh.identity-file`, and `platform`. A config
 * value WINS over the registry field so `agents devices config <name>` takes
 * effect from any box without re-discovery; an unset key falls back to the
 * registry value.
 *
 * Sync and cheap (readMeta is cached), so dial/render call sites apply it at
 * their entry point rather than threading a resolved profile through every
 * signature. Resolving an already-resolved profile is idempotent.
 */

import {
  shellForPlatform,
  type DeviceAuthMethod,
  type DevicePlatform,
  type DeviceProfile,
} from './registry.js';
import { readDeviceConfigValues } from '../device-config.js';

/** Overlay the central config's ssh.* / platform / user keys onto a registry profile. */
export function resolveDeviceProfile(device: DeviceProfile): DeviceProfile {
  const config = readDeviceConfigValues(device.name);
  const platform = (config.platform as DevicePlatform | undefined) ?? device.platform;
  const method = (config.sshAuth as DeviceAuthMethod | undefined) ?? device.auth.method;
  const user = (config.sshUser as string | undefined) ?? device.user;
  const identityFile = (config.sshIdentityFile as string | undefined) ?? device.auth.identityFile;
  const bundle = (config.sshBundle as string | undefined) ?? device.auth.bundle;
  const bundleKey = (config.sshBundleKey as string | undefined) ?? device.auth.bundleKey;
  if (
    platform === device.platform &&
    method === device.auth.method &&
    user === device.user &&
    identityFile === device.auth.identityFile &&
    bundle === device.auth.bundle &&
    bundleKey === device.auth.bundleKey
  ) {
    return device;
  }
  return {
    ...device,
    platform,
    shell: shellForPlatform(platform),
    user,
    auth: { method, identityFile, bundle, bundleKey },
  };
}
