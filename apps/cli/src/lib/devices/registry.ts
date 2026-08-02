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
import { randomBytes } from 'crypto';
import lockfile from 'proper-lockfile';
import { getDevicesRegistryPath, getDevicesIgnoredPath, getDevicesAutoLaunchPath } from '../state.js';

/** Operating-system family of a device, used to pick the remote shell. */
export type DevicePlatform = 'windows' | 'linux' | 'macos' | 'unknown';

/**
 * What a device is *for*. A `worker` (the default) can run agents — it's dialed
 * over SSH for sessions and eligible for run/team placement. A `control` device
 * is a cockpit that drives the fleet but never executes agents itself (an
 * iPhone/iPad running the companion app): it appears in the fleet but is never
 * dialed for SSH nor scheduled work. Absent `role` means `worker`.
 */
export type DeviceRole = 'worker' | 'control';

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
  /** What the device is for. Absent means `worker` (see {@link DeviceRole}). */
  role?: DeviceRole;
  createdAt: string;
  updatedAt: string;
}

/** A device's effective role, defaulting to `worker` when unset. */
export function deviceRole(d: DeviceProfile): DeviceRole {
  return d.role ?? 'worker';
}

/** True for a control-only device (a cockpit) that must never be dialed/scheduled. */
export function isControlDevice(d: DeviceProfile): boolean {
  return deviceRole(d) === 'control';
}

/** Map of device name to profile. */
export type DeviceRegistry = Record<string, DeviceProfile>;

function registryPath(): string {
  return getDevicesRegistryPath();
}

/** Valid logical device name: the ssh-alias charset, so it renders into an
 * unambiguous `Host` stanza and is safe as an ssh target. */
const DEVICE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Throw if `name` is not usable as an ssh alias (no spaces, quotes, etc.). */
export function assertValidDeviceName(name: string): void {
  if (!DEVICE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid device name ${JSON.stringify(name)}. Use letters, digits, '.', '_', '-' (no spaces) — e.g. 'win-mini'.`,
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
 * Atomic JSON write: write to a unique sibling tmp file then rename over the
 * target. rename(2) is atomic on POSIX, so a crashed write leaves the old file
 * untouched instead of producing a half-written registry that loadDevices()
 * would reject.
 */
async function atomicWriteJson(p: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  try {
    await fs.rename(tmp, p);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
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
 * `agents sessions --host` fan-out builds its ssh command strings synchronously
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
  await atomicWriteJson(registryPath(), reg);
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
  role?: DeviceRole;
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
      role: input.role ?? prev?.role,
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
 * auto-discovery. A dismissed node is NOT a device (it never enters the
 * registry), so it lives in a sibling file. Auto-discovery (`runDeviceSync`'s
 * pending diff) subtracts this set, so an ignored node never re-surfaces as a
 * suggestion. Stored under the same devices/ dir, guarded by the same lock and
 * atomic-write plumbing as the registry.
 */
interface IgnoredFile {
  ignored: string[];
  updatedAt: string;
}

function ignoredPath(): string {
  return getDevicesIgnoredPath();
}

/** Load the set of ignored node names. Missing file => empty set. A malformed
 * file is a hard error for the same reason the registry is: silently returning
 * [] would let the next write wipe the user's dismissals. */
export async function loadIgnored(): Promise<Set<string>> {
  const p = ignoredPath();
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf-8');
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return new Set();
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as IgnoredFile;
    return new Set(Array.isArray(parsed.ignored) ? parsed.ignored : []);
  } catch (err: any) {
    throw new Error(
      `Device ignore-list corrupted at ${p}: ${err?.message ?? err}. Inspect and restore from backup.`,
    );
  }
}

/** True if `name` is on the ignore-list. */
export async function isIgnored(name: string): Promise<boolean> {
  return (await loadIgnored()).has(name);
}

/** Add a node name to the ignore-list. Idempotent. Returns the resulting set. */
export async function addIgnored(name: string): Promise<Set<string>> {
  assertValidDeviceName(name);
  const p = ignoredPath();
  return withRegistryLock(p, async () => {
    const set = await loadIgnored();
    set.add(name);
    await atomicWriteJson(p, { ignored: [...set].sort(), updatedAt: new Date().toISOString() });
    return set;
  });
}

/** Remove a node name from the ignore-list (un-ignore). Returns false if it was
 * not ignored. */
export async function removeIgnored(name: string): Promise<boolean> {
  const p = ignoredPath();
  return withRegistryLock(p, async () => {
    const set = await loadIgnored();
    if (!set.delete(name)) return false;
    await atomicWriteJson(p, { ignored: [...set].sort(), updatedAt: new Date().toISOString() });
    return true;
  });
}

/**
 * Auto-launch preferences: which registered devices are eligible for Factory's
 * auto-host selection, and which are preferred. Stored as a sibling to the
 * registry and ignore-list under ~/.agents/.history/devices/.
 */
export interface AutoLaunchPreference {
  enabled?: boolean;
  preferred?: boolean;
}

export interface AutoLaunchPreferences {
  devices: Record<string, AutoLaunchPreference>;
  updatedAt: string;
}

function autoLaunchPath(): string {
  return getDevicesAutoLaunchPath();
}

/** Load auto-launch preferences. Missing or malformed file => empty map. */
export async function loadAutoLaunchPreferences(): Promise<Record<string, AutoLaunchPreference>> {
  const p = autoLaunchPath();
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf-8');
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as AutoLaunchPreferences;
    return parsed.devices && typeof parsed.devices === 'object' ? parsed.devices : {};
  } catch (err: any) {
    throw new Error(
      `Device auto-launch preferences corrupted at ${p}: ${err?.message ?? err}. Inspect and restore from backup.`,
    );
  }
}

/** True if the device is enabled for auto-launch. Missing entry defaults to true. */
export async function isAutoLaunchEnabled(name: string): Promise<boolean> {
  assertValidDeviceName(name);
  const prefs = await loadAutoLaunchPreferences();
  return prefs[name]?.enabled !== false;
}

/** Set whether a device is enabled for auto-launch. Setting to the default
 * (enabled) removes the entry to keep the file minimal. */
export async function setAutoLaunchEnabled(name: string, enabled: boolean): Promise<void> {
  assertValidDeviceName(name);
  const p = autoLaunchPath();
  await withRegistryLock(p, async () => {
    const prefs = await loadAutoLaunchPreferences();
    if (enabled) {
      if (prefs[name]) {
        const { enabled: _, ...rest } = prefs[name];
        if (Object.keys(rest).length === 0) {
          delete prefs[name];
        } else {
          prefs[name] = rest;
        }
      }
    } else {
      prefs[name] = { ...prefs[name], enabled: false };
    }
    await atomicWriteJson(p, { devices: prefs, updatedAt: new Date().toISOString() });
  });
}

/** True if the device is preferred for auto-launch ranking. */
export async function isAutoLaunchPreferred(name: string): Promise<boolean> {
  assertValidDeviceName(name);
  const prefs = await loadAutoLaunchPreferences();
  return prefs[name]?.preferred === true;
}

/** Set whether a device is preferred for auto-launch. Setting to the default
 * (not preferred) removes the flag to keep the file minimal. */
export async function setAutoLaunchPreferred(name: string, preferred: boolean): Promise<void> {
  assertValidDeviceName(name);
  const p = autoLaunchPath();
  await withRegistryLock(p, async () => {
    const prefs = await loadAutoLaunchPreferences();
    if (preferred) {
      prefs[name] = { ...prefs[name], preferred: true };
    } else if (prefs[name]) {
      const { preferred: _, ...rest } = prefs[name];
      if (Object.keys(rest).length === 0) {
        delete prefs[name];
      } else {
        prefs[name] = rest;
      }
    }
    await atomicWriteJson(p, { devices: prefs, updatedAt: new Date().toISOString() });
  });
}
