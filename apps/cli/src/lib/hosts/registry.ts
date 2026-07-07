/**
 * Host provider registry.
 *
 * Mirrors the cloud provider registry: a Map of provider id → implementation,
 * instantiated once. v1 registers only `local`; adding `rush`/`tailscale`/
 * `crabbox` later is a one-line `providers.set(...)` with no caller changes.
 */

import type { Host, HostProvider, HostProviderId } from './types.js';
import { LocalHostProvider } from './providers/local.js';
import { getDevice, type DeviceProfile } from '../devices/registry.js';
import { assertValidSshTarget } from '../ssh-exec.js';

const providers: Map<HostProviderId, HostProvider> = new Map();

function initProviders(): void {
  if (providers.size > 0) return;
  providers.set('local', new LocalHostProvider());
}

export function getProvider(id: HostProviderId): HostProvider {
  initProviders();
  const provider = providers.get(id);
  if (!provider) {
    throw new Error(`Unknown host provider: ${id}. Available: ${[...providers.keys()].join(', ')}`);
  }
  return provider;
}

export function getAllProviders(): HostProvider[] {
  initProviders();
  return [...providers.values()];
}

/** Every host across all registered providers, deduped by name (first wins). */
export async function listAllHosts(): Promise<Host[]> {
  const seen = new Set<string>();
  const out: Host[] = [];
  for (const provider of getAllProviders()) {
    for (const host of await provider.list()) {
      if (seen.has(host.name)) continue;
      seen.add(host.name);
      out.push(host);
    }
  }
  return out;
}

/**
 * Thrown when a device resolves but can't be used as an offload target because
 * it authenticates with a password. The offload path runs over `sshExec`, whose
 * `SSH_OPTS` force `BatchMode=yes` (no password prompts), so only key / ssh-config
 * auth can carry a `--host` run. Named so the top-level catch prints the message
 * cleanly instead of a stack trace.
 */
export class DeviceOffloadUnsupportedError extends Error {
  constructor(name: string) {
    super(
      `Device "${name}" uses password auth, which --host offload can't use yet ` +
        `(runs go over ssh with BatchMode=yes). Switch it to key auth with ` +
        `\`agents devices set ${name} --auth key\`, or enroll it as a host with ` +
        `\`agents hosts add ${name}\`.`,
    );
    this.name = 'DeviceOffloadUnsupportedError';
  }
}

/**
 * Bridge a registered device into a `Host` so `--host <device>` just works.
 * A device's dnsName (preferred) or ip becomes the ssh address; `source: 'inline'`
 * makes `sshTargetFor` emit `user@address`.
 */
function deviceToHost(device: DeviceProfile): Host {
  if (device.auth.method === 'password') {
    throw new DeviceOffloadUnsupportedError(device.name);
  }
  const address = device.address.dnsName ?? device.address.ip;
  if (!address) {
    throw new Error(`Device "${device.name}" has no address (Tailscale DNS name or IP) to reach it by.`);
  }
  return {
    name: device.name,
    provider: 'local',
    source: 'inline',
    address,
    user: device.user,
    ...(device.platform !== 'unknown' ? { os: device.platform } : {}),
    enrolled: true,
  };
}

/**
 * Resolve a host name to a single host, or null if unknown. Resolution order:
 *   1. host providers — the `agents hosts` registry (agents.yaml overlay + ssh-config)
 *   2. the devices registry (`agents devices`) — a machine registered once with
 *      `agents devices sync` is reachable by `--host`/`--device` with no second enroll
 *   3. an ad-hoc `user@host` (must contain `@`, validated) — nothing to register
 *
 * A bare unknown name returns null so capability-tag routing (`resolveHostByCap`)
 * stays reachable: `--host gpu` must fall through to a cap lookup, not be misread
 * as an ad-hoc target.
 */
export async function resolveHost(name: string): Promise<Host | null> {
  for (const provider of getAllProviders()) {
    const host = await provider.resolve(name);
    if (host) return host;
  }
  const device = await getDevice(name);
  if (device) return deviceToHost(device);
  if (name.includes('@')) {
    assertValidSshTarget(name);
    const at = name.indexOf('@');
    return { name, provider: 'local', source: 'inline', user: name.slice(0, at), address: name.slice(at + 1) };
  }
  return null;
}

/**
 * Resolve a host by capability tag (e.g. `--host gpu`). Returns the single
 * matching host, or throws on 0 or >1 matches unless `any` is set (then first).
 */
export async function resolveHostByCap(cap: string, any = false): Promise<Host> {
  const matches = (await listAllHosts()).filter((h) => h.caps?.includes(cap));
  if (matches.length === 0) throw new Error(`No host tagged "${cap}". Tag one with: agents hosts add <name> --cap ${cap}`);
  if (matches.length > 1 && !any) {
    throw new Error(`Multiple hosts tagged "${cap}": ${matches.map((h) => h.name).join(', ')}. Name one, or pass --any.`);
  }
  return matches[0];
}
