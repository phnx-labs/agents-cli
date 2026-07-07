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
 * A raw `user@host` that matches no registered device falls back to a literal
 * target so ad-hoc boxes still work.
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

/**
 * Resolve one `--host`/`--device` token to a concrete ssh target through the
 * registry. Registry hit → the device's real address + platform (so the machine
 * id, route, and OS all match the auto-discovery sweep). Miss → a literal
 * `user@host` fallback, its OS taken from the host overlay if enrolled. Returns
 * undefined only when the token fails the shared ssh-target injection guard.
 */
export function resolveSshTarget(token: string, reg: DeviceRegistry): ResolvedSshTarget | undefined {
  try {
    assertValidSshTarget(token);
  } catch {
    return undefined;
  }
  const bare = token.split('@').pop() || token;
  // An explicit `user@host` names an exact account/target — honour it literally.
  // A bare alias (`yosemite-s0`) resolves through the registry to the device's
  // real address, so it never diverges from the auto-discovery sweep.
  const device: DeviceProfile | undefined = token.includes('@')
    ? undefined
    : reg[token] ?? Object.values(reg).find((d) => normalizeHost(d.name) === normalizeHost(bare));
  if (device) {
    try {
      return { target: sshTargetFor(device), machine: normalizeHost(device.name), name: device.name, os: device.platform };
    } catch {
      // Registered but has no address to dial — fall through to the literal token.
    }
  }
  return { target: token, machine: normalizeHost(bare), name: token, os: resolveRemoteOsSync(token) };
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
