/**
 * The one place a `--host` / `--device` token becomes a real ssh target.
 *
 * A device and a host are the same thing addressed two ways, so resolution must
 * go through the device registry — the single source of truth. A token that
 * names a registered device dials that device's real address (its Tailscale
 * dnsName/ip + user, via `sshTargetFor`), *identical* to the auto-discovery
 * sweep and `agents ssh`. Before this module, the explicit `--host` fan-out
 * instead passed the bare token straight to `ssh`, so `--host yosemite-s0`
 * dialed whatever `~/.ssh/config`/LAN DNS resolved `yosemite-s0` to — a
 * different route than the sweep's `yosemite-s0.<tailnet>.ts.net`. That
 * divergence broke ControlMaster socket reuse (different target → different
 * `%C` hash → a cold dial every time) and could read a perfectly reachable box
 * as "unreachable" when only the non-Tailscale route was down.
 *
 * The grammar is uniform across the fleet: `mac-mini` (device name), and
 * `muqsit@mac-mini` (same device, login user overridden) both resolve through
 * the registry to the device's Tailscale route — the `user@` form no longer
 * short-circuits to a bare `ssh muqsit@mac-mini` (LAN DNS). A `user@host` that
 * matches no registered device falls back to a literal target so ad-hoc boxes
 * still work.
 */
import chalk from 'chalk';
import { assertValidSshTarget } from '../ssh-exec.js';
import { normalizeHost } from '../machine-id.js';
import { resolveRemoteOsSync } from '../hosts/remote-os.js';
import { sshTargetFor } from './connect.js';
import { loadDevices, type DeviceProfile, type DeviceRegistry } from './registry.js';

/** A dialable peer: the ssh target, the machine id used to tag its rows, a
 * display name, and the OS family that picks the remote shell dialect. */
export interface ResolvedSshTarget {
  target: string;
  machine: string;
  name: string;
  os?: string;
}

/** Split a `user@host` / `host` token into its login user (if any) and host part. */
export function splitUserHost(token: string): { user?: string; host: string } {
  const at = token.indexOf('@');
  return at === -1 ? { host: token } : { user: token.slice(0, at), host: token.slice(at + 1) };
}

/**
 * Match a host part (the piece after any `user@`) to a registered device: exact
 * registry key first, then a normalized-host match so `yosemite-s0` and
 * `yosemite-s0.<tailnet>.ts.net` land on the same profile. The single source of
 * truth both `resolveSshTarget` (fan-out) and `resolveDeviceTarget` (`agents
 * ssh`) share, so a `user@device` can never resolve two different routes.
 */
function matchDevice(host: string, reg: DeviceRegistry): DeviceProfile | undefined {
  return reg[host] ?? Object.values(reg).find((d) => normalizeHost(d.name) === normalizeHost(host));
}

/**
 * Resolve one `--host`/`--device` token to a concrete ssh target through the
 * registry. Registry hit → the device's real address + platform (so the machine
 * id, route, and OS all match the auto-discovery sweep), with any `user@`
 * overriding the login account. Miss → a literal `user@host` fallback, its OS
 * taken from the host overlay if enrolled. Returns undefined only when the token
 * fails the shared ssh-target injection guard.
 */
export function resolveSshTarget(token: string, reg: DeviceRegistry): ResolvedSshTarget | undefined {
  try {
    assertValidSshTarget(token);
  } catch {
    return undefined;
  }
  const { user, host } = splitUserHost(token);
  // A device and a `user@device` are the same box; resolve the host part through
  // the registry so both dial the Tailscale route, and let an explicit `user@`
  // override only the login account.
  const device = matchDevice(host, reg);
  if (device) {
    try {
      const effective = user ? { ...device, user } : device;
      return { target: sshTargetFor(effective), machine: normalizeHost(device.name), name: device.name, os: device.platform };
    } catch {
      // Registered but has no address to dial — fall through to the literal token.
    }
  }
  return { target: token, machine: normalizeHost(host), name: token, os: resolveRemoteOsSync(token) };
}

/** Timestamps for a synthesized ad-hoc profile — never persisted, so a constant
 * keeps the value deterministic (and side-effect free) without reading the clock. */
const SYNTH_TS = '1970-01-01T00:00:00.000Z';

/** True when a token is clearly a network target (a `user@`, or a dotted/IPv6
 * host / IP) rather than a bare alias. A bare unknown word is a typo, so `agents
 * ssh foo` still says "Unknown device" instead of dialing a literal `foo`. */
function looksLikeHostLiteral(token: string): boolean {
  return token.includes('@') || token.includes('.') || token.includes(':');
}

/** Synthesize a throwaway device profile for an ad-hoc `user@host` / `host`
 * literal so `agents ssh` can dial a box that was never registered. */
function adHocDevice(token: string, host: string, user?: string): DeviceProfile {
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  return {
    name: token,
    platform: 'unknown',
    shell: 'posix',
    user,
    address: { via: 'manual', dnsName: isIp ? undefined : host, ip: isIp ? host : undefined },
    auth: { method: 'key' },
    createdAt: SYNTH_TS,
    updatedAt: SYNTH_TS,
  };
}

/**
 * Resolve a target token to a full {@link DeviceProfile} for `agents ssh`. Same
 * grammar as {@link resolveSshTarget}, but returns the whole profile (auth,
 * shell, tailscale metadata) `buildSshInvocation` needs — not just a target
 * string. A registered `name` or `user@device` yields that profile (with the
 * login user overridden by any `user@`); an ad-hoc `user@host`/`host` literal
 * yields a synthesized key-auth profile. A bare unregistered alias (no `@`/dot)
 * returns undefined so the caller reports "Unknown device" rather than dialing a
 * literal — the strict behaviour the interactive wrapper has always had.
 */
export function resolveDeviceTarget(token: string, reg: DeviceRegistry): DeviceProfile | undefined {
  try {
    assertValidSshTarget(token);
  } catch {
    return undefined;
  }
  const { user, host } = splitUserHost(token);
  const device = matchDevice(host, reg);
  if (device) return user ? { ...device, user } : device;
  if (looksLikeHostLiteral(token)) return adHocDevice(token, host, user);
  return undefined;
}

/**
 * Resolve an explicit `--host`/`--device` list to dialable targets, reading the
 * registry once. A token that fails the injection guard is skipped with a
 * stderr note (never fatal — one bad token must not blank the fan-out). Shared
 * by every cross-machine fan-out so they can never diverge onto two routes.
 */
export async function resolveExplicitTargets(hosts: string[]): Promise<ResolvedSshTarget[]> {
  let reg: DeviceRegistry;
  try {
    reg = await loadDevices();
  } catch {
    reg = {};
  }
  const out: ResolvedSshTarget[] = [];
  for (const h of hosts) {
    const resolved = resolveSshTarget(h, reg);
    if (!resolved) {
      process.stderr.write(chalk.gray(`  ${h}: not a valid ssh target — skipped\n`));
      continue;
    }
    out.push(resolved);
  }
  return out;
}
