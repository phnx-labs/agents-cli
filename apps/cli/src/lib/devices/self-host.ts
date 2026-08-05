/**
 * "Is this hostname the local machine?" — matched against every identity the box
 * answers to, not just its short id.
 *
 * The self-checks that gate `--host` dispatch and the fleet-health fan-out used to
 * compare only against {@link machineId} (the lowercased short hostname, e.g.
 * `zion`). A caller that referenced the box by its **tailscale MagicDNS name**
 * (`zion.tail1a85a1.ts.net`) — which is exactly what `fleetDialTarget` and the
 * Factory floor's `--host` probes use — slipped past the check and SSH'd to the
 * LOCAL box over its own tailscale name. On a loaded machine that self-SSH'd
 * `doctor --json` orphaned on timeout and piled up until the host was crushed
 * (RUSH-2114). Matching the full identity set closes that gap at the source.
 */
import { machineId } from '../machine-id.js';
import { loadDevicesSync } from './registry.js';

const LOOPBACK = ['localhost', '127.0.0.1', '::1'];

/** Lowercase + strip a trailing dot (FQDNs are equivalent with or without it). */
function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, '');
}

let cached: Set<string> | null = null;

/**
 * Every name that resolves to THIS machine: the short id, loopback, and the self
 * device's tailscale dnsName plus its short form. Computed once per process — the
 * self identity does not change under a running CLI — and reads the registry
 * best-effort (an unreadable registry still leaves the short id + loopback).
 */
function selfAliases(): Set<string> {
  if (cached) return cached;
  const aliases = new Set<string>([machineId(), ...LOOPBACK]);
  try {
    const dns = loadDevicesSync()[machineId()]?.address?.dnsName;
    if (dns) {
      const d = normalize(dns);
      aliases.add(d);
      aliases.add(d.split('.')[0]); // the short form of the FQDN
    }
  } catch {
    /* registry unreadable — the short id + loopback aliases still hold */
  }
  cached = aliases;
  return cached;
}

/**
 * True when `name` refers to the local machine. Case-insensitive and
 * trailing-dot-tolerant. Use this everywhere a `--host`/fleet target is compared
 * against "self" so a tailscale-name reference short-circuits to a local run
 * instead of self-SSHing.
 */
export function isSelfHost(name: string | undefined | null): boolean {
  if (!name) return false;
  const n = normalize(name);
  return n.length > 0 && selfAliases().has(n);
}

/** Test hook: drop the memoized alias set so a fresh registry/env is re-read. */
export function resetSelfHostCache(): void {
  cached = null;
}
