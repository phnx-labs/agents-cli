/**
 * Agent-host provider contract.
 *
 * A `HostProvider` answers "what are my hosts, and how do I reach them?" — the
 * pluggable directory/metadata/reachability layer. Shipped providers: `local`
 * (ssh-config ∪ inline registry) and `devices` (the Tailscale fleet from
 * `agents devices`); `rush`/`crabbox` remain additive fast-follows behind this
 * same contract. Capability-gated so partial providers are first-class
 * (mirrors the cloud provider registry).
 */

import type { HostEntry } from '../types.js';

export type HostProviderId = 'local' | 'devices';

export type HostStatus = 'online' | 'offline' | 'unknown';

/** A host as seen at runtime: its persisted entry plus name/provider/status. */
export interface Host extends HostEntry {
  name: string;
  provider: HostProviderId;
  /** True when the host has an explicit overlay/inline entry in the registry. */
  enrolled?: boolean;
  status?: HostStatus;
  /**
   * False when the host is listed for honesty but can't carry a `--host` run
   * (today: password-auth devices — offload rides BatchMode=yes ssh). Absent
   * means dispatchable. Cap routing and target pickers filter on this.
   */
  dispatchable?: boolean;
}

/**
 * Thrown when a device resolves but can't be used as an offload target because
 * it authenticates with a password. The offload path runs over `sshExec`, whose
 * `SSH_OPTS` force `BatchMode=yes` (no password prompts), so only key / ssh-config
 * auth can carry a `--host` run. Named so the top-level catch prints the message
 * cleanly instead of a stack trace. (Lives here, not registry.ts, so providers
 * can throw it without a circular import; registry.ts re-exports it.)
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
