/**
 * Devices host provider: the Tailscale fleet as dispatch targets.
 *
 * Bridges the devices registry (`agents devices`, ~/.agents/.history/devices/
 * registry.json) into the host pool behind the same `HostProvider` seam as
 * `local` — the "tailscale provider" fast-follow named in docs/hosts.md. With
 * it, a machine registered once via `agents devices sync` shows up in
 * `agents hosts list`, participates in capability routing, and is enumerable
 * by target pickers — not just resolvable by exact name.
 *
 * Password-auth devices are listed (the pool stays honest about what exists)
 * but marked `dispatchable: false`; resolving one for dispatch throws the same
 * typed `DeviceOffloadUnsupportedError` as before — offload rides `sshExec`,
 * whose SSH_OPTS force `BatchMode=yes`.
 *
 * Precedence is unchanged: this provider registers AFTER `local`, so an
 * enrolled host shadows a same-name device in both list dedup and resolve
 * order, exactly like the old tier-2 devices fall-through in resolveHost.
 */

import { loadDevices, getDevice, isControlDevice, type DeviceProfile } from '../../devices/registry.js';
import type { Host, HostProvider, HostProviderCapabilities, HostStatus } from '../types.js';
import { DeviceOffloadUnsupportedError } from '../types.js';

/** Tailscale's own presence bit, when the sync captured one. */
function statusOf(device: DeviceProfile): HostStatus {
  if (!device.tailscale) return 'unknown';
  return device.tailscale.online ? 'online' : 'offline';
}

/**
 * Bridge a device profile into a `Host`. dnsName (stable across IP churn) is
 * preferred over ip; `source: 'inline'` makes `sshTargetFor` emit `user@address`.
 * Capability tags attach by enrolling the device (`agents hosts add <device>
 * --cap …` sources the target from this profile) — the enrolled entry then
 * shadows this row by provider precedence, carrying the caps.
 */
function deviceToPoolHost(device: DeviceProfile): Host | null {
  // A control device (a cockpit, e.g. a paired iPhone) drives the fleet but
  // never runs agents — it must never enter the host pool or be resolvable as a
  // dispatch target, whatever platform it reports (an iPhone syncs as `unknown`,
  // which remoteShellFor would otherwise default to POSIX and try to SSH).
  if (isControlDevice(device)) return null;
  const address = device.address.dnsName ?? device.address.ip;
  if (!address) return null; // unreachable profile — nothing to dispatch to
  return {
    name: device.name,
    provider: 'devices',
    source: 'inline',
    address,
    user: device.user,
    ...(device.platform !== 'unknown' ? { os: device.platform } : {}),
    enrolled: true,
    status: statusOf(device),
    dispatchable: device.auth.method !== 'password',
  };
}

export class DevicesHostProvider implements HostProvider {
  readonly id = 'devices' as const;

  capabilities(): HostProviderCapabilities {
    // mutate stays false: `agents devices sync/add/set` own the registry.
    return { directory: true, mutate: false, presence: true, relay: false, lease: false };
  }

  async list(): Promise<Host[]> {
    const devices = await loadDevices();
    const out: Host[] = [];
    for (const device of Object.values(devices)) {
      const host = deviceToPoolHost(device);
      if (host) out.push(host);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async resolve(name: string): Promise<Host | null> {
    const device = await getDevice(name);
    if (!device) return null;
    // Resolving is asking to dispatch. A control device can't run agents — fail
    // loud with a clear message instead of attempting an SSH dispatch onto a
    // phone (which remoteShellFor would treat as a POSIX host).
    if (isControlDevice(device)) {
      throw new Error(
        `Device "${device.name}" is a control device (a cockpit), not an executor — it can't run agents. Dispatch to a worker device instead.`,
      );
    }
    // Keep the long-standing typed refusal for password auth (BatchMode=yes
    // can't answer a prompt).
    if (device.auth.method === 'password') {
      throw new DeviceOffloadUnsupportedError(device.name);
    }
    const host = deviceToPoolHost(device);
    if (!host) {
      throw new Error(`Device "${device.name}" has no address (Tailscale DNS name or IP) to reach it by.`);
    }
    return host;
  }

  async presence(name: string): Promise<HostStatus> {
    const device = await getDevice(name);
    return device ? statusOf(device) : 'unknown';
  }
}
