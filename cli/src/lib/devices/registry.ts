/**
 * Device registry.
 *
 * Manages the persistent registry of SSH device profiles stored at
 * ~/.agents/.history/devices/registry.json. Each profile records what we had
 * to re-derive by hand the first time we reached a host: its platform (so we
 * know PowerShell vs POSIX), the login user, how to address it (Tailscale
 * DNS name / IP), and how to authenticate (pubkey, or a password pulled from
 * a secrets bundle).
 *
 * Like the team registry this is per-machine runtime state (it embeds a host
 * list + addresses) and lives under .history/ so it is NOT pulled in by
 * `agents repo push`. The load/save/lock plumbing is a deliberate clone of
 * src/lib/teams/registry.ts so the data-loss guarantees match exactly.
 */
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import lockfile from 'proper-lockfile';
import { getDevicesRegistryPath, readMeta, updateMeta } from '../state.js';
import { atomicWriteJsonSync } from '../fs-atomic.js';
import { machineId } from '../machine-id.js';
import type { Meta } from '../types.js';
import type { FleetManifest, IgnoredDeviceEntry } from '../fleet/types.js';

/** Operating-system family of a device, used to pick the remote shell. */
export type DevicePlatform = 'windows' | 'linux' | 'macos' | 'unknown';

/** Remote shell dialect derived from the platform. */
export type DeviceShell = 'powershell' | 'posix';

/** How `agents ssh` authenticates to a device. Both are first-class, fully
 * non-interactive: `key` uses the ssh agent / on-disk keys, `password` pulls
 * the secret from a Keychain-backed secrets bundle via an askpass shim. */
export type DeviceAuthMethod = 'key' | 'password';

/** How to reach a device on the network. */
export interface DeviceAddress {
  /** Where the address came from: a Tailscale node, or a manual entry. */
  via: 'tailscale' | 'manual';
  /** Fully-qualified DNS name (Tailscale MagicDNS), without a trailing dot. */
  dnsName?: string;
  /** Raw IP address (IPv4 preferred). */
  ip?: string;
}

/** Authentication settings for a device. */
export interface DeviceAuth {
  method: DeviceAuthMethod;
  /** Explicit private-key path passed to OpenSSH for key authentication. */
  identityFile?: string;
  /** Secrets bundle holding the password (when method === 'password'). */
  bundle?: string;
  /** Key within the bundle whose value is the password. Defaults to 'password'. */
  bundleKey?: string;
}

/** Last-known Tailscale reachability snapshot for a device. */
export interface DeviceTailscale {
  online: boolean;
  /** True when the last handshake was a direct (non-relayed) connection. */
  direct: boolean;
  /** DERP relay region code (e.g. 'sfo'); empty when direct. */
  relay?: string;
  lastSeen?: string;
}

/**
 * Verdict of the last live SSH reachability probe (RUSH-1965).
 *
 * The live `agents devices` probe already learns whether a box answered right
 * now; this persists that answer so the online/offline word is read from a
 * fresh probe instead of the potentially-stale {@link DeviceTailscale.online}
 * snapshot (which only `agents devices sync` / the daemon ever writes). A
 * `via:"manual"` device — which never gets a tailscale peer entry — gets a
 * reachability verdict this way too, so it stops rendering "offline forever".
 */
export interface DeviceReachability {
  /** Whether the last live probe reached the device. */
  reachable: boolean;
  /** Transport the verdict came through — the address kind used to dial it. */
  via?: DeviceAddress['via'];
  /** ISO-8601 timestamp of the probe that produced this verdict. */
  checkedAt: string;
}

/** A single registered device. */
export interface DeviceProfile {
  name: string;
  platform: DevicePlatform;
  shell: DeviceShell;
  user?: string;
  address: DeviceAddress;
  auth: DeviceAuth;
  tailscale?: DeviceTailscale;
  /** Last live SSH-probe reachability verdict (RUSH-1965). Preferred over the
   * cached {@link DeviceTailscale.online} snapshot when rendering online/offline,
   * because the live probe reflects whether the box answered right now. */
  reachability?: DeviceReachability;
  createdAt: string;
  updatedAt: string;
}

/**
 * Whether a fan-out should dial this device, honouring the preference stated on
 * {@link DeviceProfile.reachability}: the live SSH probe wins over the cached
 * {@link DeviceTailscale.online} snapshot.
 *
 * Reading only `tailscale.online` is wrong in both directions, and both were
 * live on a real fleet. A `via:"manual"` device never gets a tailscale peer
 * entry at all, so its `online` is permanently `undefined` and a strict
 * `=== true` test skipped it forever — every session on that box was invisible
 * to the cross-fleet sweep. Conversely a box that has since gone to sleep keeps
 * a stale `online:true` and gets dialed, burning a full ConnectTimeout and
 * reporting a false "unreachable" that callers treat as doubt.
 */
export function isDialableDevice(d: DeviceProfile): boolean {
  // Union, deliberately: either signal saying "go" is enough. A probe may only
  // ADD a peer to the sweep, never remove one.
  //
  // The probe is not trustworthy enough to exclude on. It runs with a short SSH
  // budget, so on a congested tailnet it returns false negatives — observed
  // marking the LOCAL machine unreachable, and flipping a live worker box from
  // reachable to unreachable nine minutes apart. Letting that shrink the sweep
  // would hide sessions on healthy boxes, a worse failure than the one below.
  //
  // The snapshot alone is not enough either: a device registered with
  // `address.via: "manual"` never gets a tailscale peer entry, so `online`
  // stays undefined and a strict `=== true` test skipped it forever, making
  // every session on that box unresolvable from any other machine.
  //
  // So: no tailscale block at all is unknown-not-offline (the rule `ssh.ts`
  // renderDeviceTable and the ext's `isDeviceOnline` already use, so the picker
  // and the sweep agree on who exists), and a positive probe rescues a device
  // whose snapshot says offline. The cost of dialing a box that is actually
  // asleep is one ConnectTimeout — the pre-existing behaviour, not a regression.
  if (d.reachability?.reachable) return true;
  return !d.tailscale || d.tailscale.online === true;
}
// Two more fan-outs still gate on the bare `tailscale.online === true` and so
// still skip manual devices: `commands/apply.ts` (`devices: all` config-sync
// targeting) and `commands/output.ts` (`--all-hosts`). They are left alone here
// deliberately — neither is a session surface, and changing what `agents apply`
// targets is a config-sync behaviour change that deserves its own PR rather
// than riding along on a sessions fix. `devices/fleet.ts` planFleetTargets and
// `smart-launch.ts` listOnlineDeviceNames already treat a missing tailscale
// block as a candidate, so they need no change.

/** Map of device name to profile. */
export type DeviceRegistry = Record<string, DeviceProfile>;

function registryPath(): string {
  return getDevicesRegistryPath();
}

/** Valid logical device name: the ssh-alias charset, so it renders into an
 * unambiguous `Host` stanza and is safe as an ssh target. */
const DEVICE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * `--device` values that mean "resolve me", not "connect to a box with this
 * name". A real device registered under one of these would be unreachable,
 * and pinning `interactive.host` to one is a misconfiguration that has to fail
 * at WRITE time — otherwise the read side can only report "none is set", which
 * tells the user to run the command they just ran.
 */
export const RESERVED_DEVICE_NAMES = new Set(['auto', 'interactive', 'all']);

/**
 * Throw if `name` is not usable as an ssh alias (no spaces, quotes, etc.).
 *
 * SHAPE ONLY. Safe on read paths, which must keep working for a name that is
 * already registered — including one this version would refuse to create.
 */
export function assertValidDeviceName(name: string): void {
  if (!DEVICE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid device name ${JSON.stringify(name)}. Use letters, digits, '.', '_', '-' (no spaces) — e.g. 'win-mini'.`,
    );
  }
}

/**
 * Throw if `name` cannot be used for a NEW device: bad shape, or a reserved
 * routing sentinel.
 *
 * Deliberately separate from {@link assertValidDeviceName}, and called from
 * exactly two kinds of place: `agents devices add <name>`, and the config keys
 * that point AT a device (`interactive.host`, `usage.primary-host`).
 *
 * Not from `upsertDevice`, `addIgnored` or the discovery writers. Those all
 * receive tailnet node names the user never typed — `devices sync` upserts every
 * observed node in a loop with no per-node catch, so one node named `auto` would
 * abort the entire sync and register nothing after it. A name the fleet OBSERVES
 * is not a name anyone CHOSE; only the second kind is policy's business.
 */
export function assertRegistrableDeviceName(name: string): void {
  assertValidDeviceName(name);
  if (RESERVED_DEVICE_NAMES.has(name.trim().toLowerCase())) {
    throw new Error(
      `${JSON.stringify(name)} is a reserved --device value, not a device name. ` +
        `Reserved: ${[...RESERVED_DEVICE_NAMES].join(', ')}.`,
    );
  }
}

/** Map a Tailscale `OS` field to our platform enum. */
export function platformFromOs(os: string | undefined): DevicePlatform {
  switch ((os ?? '').toLowerCase()) {
    case 'windows':
      return 'windows';
    case 'linux':
      return 'linux';
    case 'macos':
    case 'darwin':
      return 'macos';
    default:
      return 'unknown';
  }
}

/** The remote shell a platform speaks. */
export function shellForPlatform(platform: DevicePlatform): DeviceShell {
  return platform === 'windows' ? 'powershell' : 'posix';
}

/**
 * Run `fn` while holding an exclusive cross-process lock on the registry file.
 * proper-lockfile requires the target to exist, so we touch it first. Stale
 * locks (from crashed callers) auto-expire after `stale` ms.
 */
async function withRegistryLock<T>(p: string, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  if (!fsSync.existsSync(p)) {
    try {
      await fs.writeFile(p, '{}', { flag: 'wx' });
    } catch (err: any) {
      if (err && err.code !== 'EEXIST') throw err;
    }
  }
  const release = await lockfile.lock(p, {
    retries: { retries: 60, minTimeout: 25, maxTimeout: 250, factor: 1.5 },
    stale: 10_000,
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * Load all devices from the registry file. Returns an empty object only when
 * the file does not exist. A malformed file is a hard error — silently
 * returning {} would let the next write wipe the user's device list.
 */
export async function loadDevices(): Promise<DeviceRegistry> {
  const p = registryPath();
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf-8');
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }
  try {
    return JSON.parse(raw) as DeviceRegistry;
  } catch (err: any) {
    throw new Error(
      `Device registry corrupted at ${p}: ${err?.message ?? err}. Inspect and restore from backup.`,
    );
  }
}

/**
 * Synchronous {@link loadDevices} for callers already on a sync path (e.g. the
 * `agents sessions --device` fan-out builds its ssh command strings synchronously
 * and only needs the target's platform to pick POSIX vs PowerShell). Same
 * missing-file/corruption contract as {@link loadDevices}.
 */
export function loadDevicesSync(): DeviceRegistry {
  const p = registryPath();
  let raw: string;
  try {
    raw = fsSync.readFileSync(p, 'utf-8');
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }
  try {
    return JSON.parse(raw) as DeviceRegistry;
  } catch (err: any) {
    throw new Error(
      `Device registry corrupted at ${p}: ${err?.message ?? err}. Inspect and restore from backup.`,
    );
  }
}

async function saveDevices(reg: DeviceRegistry): Promise<void> {
  atomicWriteJsonSync(registryPath(), reg);
}

/** Get a single device profile, or null if it is not registered. */
export async function getDevice(name: string): Promise<DeviceProfile | null> {
  const reg = await loadDevices();
  return reg[name] ?? null;
}

/** Fields a caller may supply when creating or updating a device. */
export interface DeviceInput {
  platform?: DevicePlatform;
  user?: string;
  address?: DeviceAddress;
  auth?: DeviceAuth;
  tailscale?: DeviceTailscale;
  reachability?: DeviceReachability;
}

/**
 * Create the device if absent, otherwise merge the supplied fields into the
 * existing profile. `shell` is always re-derived from the (possibly new)
 * platform so the two can never drift. Returns the resulting profile.
 */
export async function upsertDevice(name: string, input: DeviceInput): Promise<DeviceProfile> {
  assertValidDeviceName(name);
  const p = registryPath();
  return withRegistryLock(p, async () => {
    const reg = await loadDevices();
    const now = new Date().toISOString();
    const prev = reg[name];
    const platform = input.platform ?? prev?.platform ?? 'unknown';
    const merged: DeviceProfile = {
      name,
      platform,
      shell: shellForPlatform(platform),
      user: input.user ?? prev?.user,
      address: input.address ?? prev?.address ?? { via: 'manual' },
      auth: input.auth ?? prev?.auth ?? { method: 'key' },
      tailscale: input.tailscale ?? prev?.tailscale,
      reachability: input.reachability ?? prev?.reachability,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    reg[name] = merged;
    await saveDevices(reg);
    return merged;
  });
}

/**
 * Persist live reachability verdicts for many devices in one locked pass
 * (RUSH-1965). A no-op verdict (same `reachable` and not newer than what's
 * stored) is skipped, so a cache-served `agents devices` render doesn't churn
 * the registry every call; only a flip or a fresher probe writes. Unlike
 * {@link upsertDevice} this does NOT bump `updatedAt` — reachability is
 * transient liveness (like the tailscale snapshot), not a profile edit. Unknown
 * device names are ignored. Returns the names actually updated.
 */
export async function writeReachability(
  updates: Record<string, DeviceReachability>,
): Promise<string[]> {
  const names = Object.keys(updates);
  if (names.length === 0) return [];
  const p = registryPath();
  return withRegistryLock(p, async () => {
    const reg = await loadDevices();
    const changed: string[] = [];
    for (const name of names) {
      const prev = reg[name];
      if (!prev) continue; // never resurrect a device the user removed
      const next = updates[name];
      const cur = prev.reachability;
      if (
        cur &&
        cur.reachable === next.reachable &&
        Date.parse(cur.checkedAt) >= Date.parse(next.checkedAt)
      ) {
        continue; // unchanged verdict, no fresher timestamp — skip the write
      }
      reg[name] = { ...prev, reachability: next };
      changed.push(name);
    }
    if (changed.length > 0) await saveDevices(reg);
    return changed;
  });
}

/** Remove a device. Returns false if it was not registered. */
export async function removeDevice(name: string): Promise<boolean> {
  const p = registryPath();
  return withRegistryLock(p, async () => {
    const reg = await loadDevices();
    if (!reg[name]) return false;
    delete reg[name];
    await saveDevices(reg);
    return true;
  });
}

/**
 * The ignore-list: tailscale node names the user explicitly dismissed from
 * auto-discovery. A dismissed node is deliberately NOT a device (it never
 * enters the registry), so it has no per-device doc — its home is the central,
 * TRACKED `~/.agents/agents.yaml` under a `fleet.ignored` list, which syncs
 * fleet-wide via `agents repo push/pull`: a dismissal on one box stops the
 * suggestion on every box (RUSH-3062). Auto-discovery (`runDeviceSync`'s
 * pending diff) subtracts this set, so an ignored node never re-surfaces as a
 * suggestion. Writes go through `updateMeta` — the central-config write path
 * (withMetaLock + atomic write) — so two agents writing concurrently cannot
 * corrupt it, and no second lock is hand-rolled here.
 */

// The dismissal record and the `fleet.ignored` field are declared on
// FleetManifest itself (lib/fleet/types.ts) rather than as a local intersection
// here: an intersection kept the field invisible to every OTHER consumer of the
// manifest — which is exactly how the migration's emptied-block guard came to
// omit it and would have deleted the user's dismissals fleet-wide. Re-exported
// so importers of this module keep the name they already use.
export type { IgnoredDeviceEntry } from '../fleet/types.js';

/**
 * The full ignore-list entries — who dismissed a node, when, and on which box —
 * the typed read side for `agents devices ignored`. Absent `fleet.ignored` =>
 * []. A malformed block is a hard error for the same reason the registry is:
 * silently returning [] would let the next write wipe the user's dismissals.
 */
export function loadIgnoredEntries(meta: Meta = readMeta()): IgnoredDeviceEntry[] {
  const raw = meta.fleet?.ignored;
  if (raw === undefined) return [];
  if (
    !Array.isArray(raw) ||
    raw.some(
      (e) =>
        !e ||
        typeof e.name !== 'string' ||
        typeof e.ignoredAt !== 'string' ||
        typeof e.ignoredOn !== 'string',
    )
  ) {
    throw new Error(
      `Device ignore-list corrupted in agents.yaml (fleet.ignored): expected a list of { name, ignoredAt, ignoredOn } entries. Inspect and repair ~/.agents/agents.yaml.`,
    );
  }
  return raw;
}

/** Load the set of ignored node names. Same corruption contract as
 * {@link loadIgnoredEntries}. */
export async function loadIgnored(): Promise<Set<string>> {
  return new Set(loadIgnoredEntries().map((e) => e.name));
}

/** True if `name` is on the ignore-list. */
export async function isIgnored(name: string): Promise<boolean> {
  return (await loadIgnored()).has(name);
}

/**
 * Union `names` into the meta's ignore-list, stamping new entries with
 * `ignoredAt` and THIS machine's id. Existing entries keep their original
 * who/when, so re-adding a name is a true no-op. Returns the input unchanged
 * when no name is new. Exported for the one-shot legacy-store migration in
 * lib/devices/config-migration.ts.
 */
export function withIgnoredAdded(meta: Meta, names: string[], ignoredAt: string): Meta {
  const entries = loadIgnoredEntries(meta); // throws on a corrupted block — never wipe it
  const have = new Set(entries.map((e) => e.name));
  const fresh = names.filter((n) => !have.has(n));
  if (fresh.length === 0) return meta;
  const fleet = (meta.fleet ?? { devices: {} });
  const ignored: IgnoredDeviceEntry[] = [
    ...entries,
    ...fresh.map((name) => ({ name, ignoredAt, ignoredOn: machineId() })),
  ].sort((a, b) => a.name.localeCompare(b.name));
  const nextFleet: FleetManifest = { ...fleet, ignored };
  return { ...meta, fleet: nextFleet };
}

/** Add a node name to the ignore-list. Idempotent. Returns the resulting set. */
export async function addIgnored(name: string): Promise<Set<string>> {
  assertValidDeviceName(name);
  const meta = updateMeta((m) => withIgnoredAdded(m, [name], new Date().toISOString()));
  return new Set(loadIgnoredEntries(meta).map((e) => e.name));
}

/** Remove a node name from the ignore-list (un-ignore). Returns false if it was
 * not ignored. */
export async function removeIgnored(name: string): Promise<boolean> {
  let removed = false;
  updateMeta((m) => {
    const fleet = m.fleet;
    if (!fleet?.ignored) return m;
    const entries = loadIgnoredEntries(m);
    const next = entries.filter((e) => e.name !== name);
    if (next.length === entries.length) return m;
    removed = true;
    const nextFleet: FleetManifest = { ...fleet, ignored: next };
    return { ...m, fleet: nextFleet };
  });
  return removed;
}
