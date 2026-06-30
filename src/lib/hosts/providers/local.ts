/**
 * Local host provider: the v1 directory.
 *
 * `list()` is the union of ssh-config `Host` stanzas (read-only, connection
 * details owned by ssh) and inline entries the user registered in agents.yaml.
 * The `Meta.hosts` overlay (caps/os, keyed by name) is merged onto both. We
 * never copy or rewrite ssh config.
 */

import { readMeta, updateMeta } from '../../state.js';
import type { HostEntry } from '../../types.js';
import type { Host, HostProvider, HostProviderCapabilities } from '../types.js';
import { listSshConfigHosts, isSshConfigHost } from '../ssh-config.js';

function entries(): Record<string, HostEntry> {
  return readMeta().hosts ?? {};
}

function toHost(name: string, entry: HostEntry, enrolled: boolean): Host {
  return {
    name,
    provider: 'local',
    enrolled,
    source: entry.source,
    address: entry.address,
    user: entry.user,
    os: entry.os,
    caps: entry.caps,
    addedAt: entry.addedAt,
  };
}

export class LocalHostProvider implements HostProvider {
  readonly id = 'local' as const;

  capabilities(): HostProviderCapabilities {
    return { directory: true, mutate: true, presence: false, relay: false, lease: false };
  }

  async list(): Promise<Host[]> {
    const overlay = entries();
    const out: Host[] = [];
    const seen = new Set<string>();

    // Inline + overlaid hosts from the registry.
    for (const [name, entry] of Object.entries(overlay)) {
      out.push(toHost(name, entry, true));
      seen.add(name);
    }
    // ssh-config hosts not already carrying an overlay → available, not enrolled.
    for (const name of listSshConfigHosts()) {
      if (seen.has(name)) continue;
      out.push(toHost(name, { source: 'ssh-config' }, false));
      seen.add(name);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async resolve(name: string): Promise<Host | null> {
    const entry = entries()[name];
    if (entry) return toHost(name, entry, true);
    if (isSshConfigHost(name)) return toHost(name, { source: 'ssh-config' }, false);
    return null;
  }

  async register(spec: Host): Promise<Host> {
    const entry: HostEntry = {
      source: spec.source,
      ...(spec.source === 'inline' ? { address: spec.address, user: spec.user } : {}),
      ...(spec.os ? { os: spec.os } : {}),
      ...(spec.caps && spec.caps.length ? { caps: spec.caps } : {}),
      addedAt: spec.addedAt ?? new Date().toISOString(),
    };
    updateMeta((meta) => ({ ...meta, hosts: { ...(meta.hosts ?? {}), [spec.name]: entry } }));
    return toHost(spec.name, entry, true);
  }

  async remove(name: string): Promise<void> {
    updateMeta((meta) => {
      const hosts = { ...(meta.hosts ?? {}) };
      delete hosts[name];
      // Drop the key entirely when empty so we don't leave `hosts: {}` behind.
      if (Object.keys(hosts).length === 0) {
        const { hosts: _omit, ...rest } = meta;
        return rest;
      }
      return { ...meta, hosts };
    });
  }
}
