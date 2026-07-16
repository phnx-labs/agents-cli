/**
 * Host provider registry.
 *
 * Mirrors the cloud provider registry: a Map of provider id → implementation,
 * instantiated once. Registers `local` then `devices` (order is precedence:
 * an enrolled host shadows a same-name device); adding `rush`/`crabbox` later
 * is a one-line `providers.set(...)` with no caller changes.
 */

import type { Host, HostProvider, HostProviderId } from './types.js';
import { DeviceOffloadUnsupportedError } from './types.js';
import { LocalHostProvider } from './providers/local.js';
import { DevicesHostProvider } from './providers/devices.js';
import { assertValidSshTarget } from '../ssh-exec.js';

// Re-export so existing importers (tests, commands) keep their path; the class
// itself lives in types.ts so providers can throw it without a circular import.
export { DeviceOffloadUnsupportedError };

const providers: Map<HostProviderId, HostProvider> = new Map();

function initProviders(): void {
  if (providers.size > 0) return;
  providers.set('local', new LocalHostProvider());
  providers.set('devices', new DevicesHostProvider());
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
 * Resolve a host name to a single host, or null if unknown. Resolution order:
 *   1. host providers, in registration order — the `agents hosts` registry
 *      (`local`: agents.yaml overlay + ssh-config), then the devices registry
 *      (`devices`: a machine registered once with `agents devices sync` is
 *      reachable by `--host`/`--device` with no second enroll)
 *   2. an ad-hoc `user@host` (must contain `@`, validated) — nothing to register
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
  // Non-dispatchable hosts (password-auth devices) are listed for honesty but
  // must never be picked as a run target.
  const matches = (await listAllHosts()).filter((h) => h.caps?.includes(cap) && h.dispatchable !== false);
  if (matches.length === 0) throw new Error(`No host tagged "${cap}". Tag one with: agents hosts add <name> --cap ${cap}`);
  if (matches.length > 1 && !any) {
    throw new Error(`Multiple hosts tagged "${cap}": ${matches.map((h) => h.name).join(', ')}. Name one, or pass --any.`);
  }
  return matches[0];
}
