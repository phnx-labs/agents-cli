/**
 * Agent-host provider contract.
 *
 * A `HostProvider` answers "what are my hosts, and how do I reach them?" — the
 * pluggable directory/metadata/reachability layer. v1 ships only the `local`
 * provider (ssh-config ∪ inline registry); `rush`/`tailscale`/`crabbox` are
 * additive fast-follows behind this same contract. Capability-gated so partial
 * providers are first-class (mirrors the cloud provider registry).
 */

import type { HostEntry } from '../types.js';

export type HostProviderId = 'local';

export type HostStatus = 'online' | 'offline' | 'unknown';

/** A host as seen at runtime: its persisted entry plus name/provider/status. */
export interface Host extends HostEntry {
  name: string;
  provider: HostProviderId;
  /** True when the host has an explicit overlay/inline entry in the registry. */
  enrolled?: boolean;
  status?: HostStatus;
}

export interface HostProviderCapabilities {
  /** Can list/track hosts. */
  directory: boolean;
  /** Can add/remove hosts. */
  mutate: boolean;
  /** Reports online/offline without an explicit probe. */
  presence: boolean;
  /** Can dispatch a command without an SSH address (its own relay). */
  relay: boolean;
  /** Can provision new hosts. */
  lease: boolean;
}

export interface HostProvider {
  id: HostProviderId;
  capabilities(): HostProviderCapabilities;
  /** Every host this provider knows about. */
  list(): Promise<Host[]>;
  /** Resolve one host by name, or null if unknown to this provider. */
  resolve(name: string): Promise<Host | null>;
  /** Persist a host (mutate-capable providers only). */
  register?(spec: Host): Promise<Host>;
  /** Remove a host (mutate-capable providers only). */
  remove?(name: string): Promise<void>;
  /** Presence without an explicit probe (presence-capable providers only). */
  presence?(name: string): Promise<HostStatus>;
}

/**
 * The ssh target string for a host: the bare name for ssh-config hosts (ssh
 * resolves HostName/User/Port/Identity), else `user@address` (or `address`).
 */
export function sshTargetFor(host: Host): string {
  if (host.source === 'ssh-config') return host.name;
  if (!host.address) {
    throw new Error(`Host "${host.name}" is inline but has no address.`);
  }
  return host.user ? `${host.user}@${host.address}` : host.address;
}
