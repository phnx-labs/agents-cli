/**
 * Host provider registry.
 *
 * Mirrors the cloud provider registry: a Map of provider id → implementation,
 * instantiated once. v1 registers only `local`; adding `rush`/`tailscale`/
 * `crabbox` later is a one-line `providers.set(...)` with no caller changes.
 */

import type { Host, HostProvider, HostProviderId } from './types.js';
import { LocalHostProvider } from './providers/local.js';

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
 * Resolve a host name to a single host across providers, or null if unknown.
 * First provider that owns the name wins (only `local` in v1).
 */
export async function resolveHost(name: string): Promise<Host | null> {
  for (const provider of getAllProviders()) {
    const host = await provider.resolve(name);
    if (host) return host;
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
