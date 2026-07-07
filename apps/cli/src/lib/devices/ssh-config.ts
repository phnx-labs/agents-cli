/**
 * Render the device registry into an OpenSSH `ssh_config` include block.
 *
 * Writing a managed include (e.g. `~/.ssh/config.d/agents`) makes every tool
 * that speaks ssh — plain `ssh`/`scp`/`rsync`/`git`, and `agents sessions
 * --host` — resolve the registry's logical device names transparently, without
 * each of them learning about the registry. `agents ssh` stays the value-add
 * layer (preflight, password-from-bundle auth, platform-aware exec) on top.
 *
 * `renderSshConfig` is a pure function (registry in, config text out) so the
 * exact rendering is unit-testable.
 */
import { type DeviceProfile, type DeviceRegistry } from './registry.js';

const HEADER = [
  '# Managed by `agents devices` — do not edit by hand.',
  '# Regenerate with: agents devices render',
  '# Include from ~/.ssh/config with:  Include config.d/agents',
].join('\n');

/** The HostName an ssh client should dial for a device: DNS name first, then IP. */
export function hostNameFor(device: DeviceProfile): string | undefined {
  return device.address.dnsName ?? device.address.ip;
}

/** Render a single device into an ssh_config `Host` stanza, or null if it has no address. */
function renderHost(device: DeviceProfile): string | null {
  const hostName = hostNameFor(device);
  if (!hostName) return null;
  const lines = [`Host ${device.name}`, `    HostName ${hostName}`];
  if (device.user) lines.push(`    User ${device.user}`);
  return lines.join('\n');
}

/**
 * Render the whole registry into ssh_config text. Devices are emitted in
 * stable alphabetical order (so the file does not churn between runs) and
 * addressless devices are skipped.
 */
export function renderSshConfig(reg: DeviceRegistry): string {
  const stanzas: string[] = [];
  for (const name of Object.keys(reg).sort()) {
    const stanza = renderHost(reg[name]);
    if (stanza) stanzas.push(stanza);
  }
  return [HEADER, '', ...stanzas, ''].join('\n');
}
