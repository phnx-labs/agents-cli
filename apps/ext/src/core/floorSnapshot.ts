// Pure Floor snapshot cache — last-good retention + per-host freshness.
//
// The extension host persists a successful normalized Floor snapshot in
// VS Code globalState and serves it immediately on panel open / poll. Remote
// refresh is user-triggered only; a failed refresh must NEVER wipe rows the
// user already saw. All merge / staleness / shape-check logic lives here so
// the vscode I/O layer and tests share one source of truth.

import type { HostGroup, HostInfo, RemoteSession } from './remoteSessions';

/** globalState key for the last successful Floor host/sessions snapshot. */
export const FLOOR_SNAPSHOT_KEY = 'agents.floorSnapshot.v1';

/** globalState key for the last successful devices registry read. */
export const FLOOR_DEVICES_KEY = 'agents.floorDevices.v1';

/** globalState key for the last successful agent inventory read. */
export const FLOOR_INVENTORY_KEY = 'agents.floorInventory.v1';

/**
 * How long a non-force local seed may stand before a bounded local-only
 * backstop revalidates (`sessions --active --local --json` only — never SSH).
 */
export const LOCAL_SESSIONS_BACKSTOP_MS = 60_000;

/** Shared agent-inventory SWR window for panel + dispatch only (not SnapshotDetector). */
export const INVENTORY_CACHE_TTL_MS = 60_000;

/** Normalized host/sessions payload the Floor and Dispatch consume. */
export interface FloorHostSessionsSnapshot {
  hosts: HostInfo[];
  sessions: RemoteSession[];
  groups: HostGroup[];
  fetchedAt: number;
  /**
   * Per-host last-success epoch ms. Remote hosts only advance on a successful
   * bare fleet fetch; local advances on a successful local seed/backstop.
   */
  hostFreshness: Record<string, number>;
  /** True when this result was served from cache without a fresh CLI call. */
  fromCache?: boolean;
}

/** Persisted registry row. Kept core-only so parsing does not depend on VS Code. */
export interface FloorDevice {
  name: string;
  host: string;
  platform?: string;
  online?: boolean;
  registeredAt: number;
}

export interface FloorDevicesSnapshot {
  devices: FloorDevice[];
  fetchedAt: number;
}

export interface FloorInventorySnapshot {
  data: Record<string, unknown>;
  fetchedAt: number;
}

/** Shape-check persisted device registry data before hydrating the module cache. */
export function parseFloorDevicesSnapshot(raw: unknown): FloorDevicesSnapshot | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as Partial<FloorDevicesSnapshot>;
  if (!Array.isArray(candidate.devices)) return undefined;
  if (typeof candidate.fetchedAt !== 'number' || !Number.isFinite(candidate.fetchedAt)) return undefined;
  const devices: FloorDevice[] = [];
  for (const value of candidate.devices) {
    if (!value || typeof value !== 'object') return undefined;
    const device = value as Partial<FloorDevice>;
    if (
      typeof device.name !== 'string'
      || !device.name
      || typeof device.host !== 'string'
      || !device.host
      || typeof device.registeredAt !== 'number'
      || !Number.isFinite(device.registeredAt)
    ) {
      return undefined;
    }
    devices.push({
      name: device.name,
      host: device.host,
      platform: typeof device.platform === 'string' ? device.platform : undefined,
      online: typeof device.online === 'boolean' ? device.online : undefined,
      registeredAt: device.registeredAt,
    });
  }
  return { devices, fetchedAt: candidate.fetchedAt };
}

/** Shape-check persisted agent inventories without assuming vendor-specific fields. */
export function parseFloorInventorySnapshot(raw: unknown): FloorInventorySnapshot | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as Partial<FloorInventorySnapshot>;
  if (!candidate.data || typeof candidate.data !== 'object' || Array.isArray(candidate.data)) return undefined;
  if (typeof candidate.fetchedAt !== 'number' || !Number.isFinite(candidate.fetchedAt)) return undefined;
  return { data: candidate.data as Record<string, unknown>, fetchedAt: candidate.fetchedAt };
}

/** Shape-check a value read back from globalState; returns undefined on drift. */
export function parseFloorSnapshot(raw: unknown): FloorHostSessionsSnapshot | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Partial<FloorHostSessionsSnapshot>;
  if (!Array.isArray(c.hosts) || !Array.isArray(c.sessions) || !Array.isArray(c.groups)) {
    return undefined;
  }
  if (typeof c.fetchedAt !== 'number' || !Number.isFinite(c.fetchedAt)) return undefined;
  const hostFreshness =
    c.hostFreshness && typeof c.hostFreshness === 'object' && !Array.isArray(c.hostFreshness)
      ? (c.hostFreshness as Record<string, number>)
      : {};
  return {
    hosts: c.hosts as HostInfo[],
    sessions: c.sessions as RemoteSession[],
    groups: c.groups as HostGroup[],
    fetchedAt: c.fetchedAt,
    hostFreshness,
    fromCache: c.fromCache === true ? true : undefined,
  };
}

/** Build per-host freshness stamps from a successful fetch. */
export function buildHostFreshness(
  hosts: readonly HostInfo[],
  fetchedAt: number,
  previous?: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = { ...(previous ?? {}) };
  for (const h of hosts) {
    if (!h || typeof h.name !== 'string' || !h.name) continue;
    // Offline hosts keep their prior successful stamp (do not claim "just now").
    if (h.online) out[h.name] = fetchedAt;
    else if (out[h.name] === undefined) out[h.name] = previous?.[h.name] ?? 0;
  }
  return out;
}

/**
 * Fold a fresh successful fetch into the last-good snapshot.
 * Always replaces sessions/hosts when the fetch produced a confident payload
 * (any host roster or any sessions). An empty failed fetch is handled by
 * {@link retainLastGoodOnFailure}.
 */
export function acceptSuccessfulFloorFetch(
  previous: FloorHostSessionsSnapshot | null | undefined,
  next: Omit<FloorHostSessionsSnapshot, 'hostFreshness' | 'fromCache'> & {
    hostFreshness?: Record<string, number>;
  },
): FloorHostSessionsSnapshot {
  const hostFreshness = buildHostFreshness(
    next.hosts,
    next.fetchedAt,
    next.hostFreshness ?? previous?.hostFreshness,
  );
  return {
    hosts: next.hosts,
    sessions: next.sessions,
    groups: next.groups,
    fetchedAt: next.fetchedAt,
    hostFreshness,
    fromCache: false,
  };
}

/**
 * On a failed or empty remote refresh, keep the previous last-good rows and
 * mark the result as fromCache. Returns null only when there is nothing to keep.
 */
export function retainLastGoodOnFailure(
  previous: FloorHostSessionsSnapshot | null | undefined,
): FloorHostSessionsSnapshot | null {
  if (!previous) return null;
  return {
    hosts: previous.hosts,
    sessions: previous.sessions,
    groups: previous.groups,
    fetchedAt: previous.fetchedAt,
    hostFreshness: previous.hostFreshness,
    fromCache: true,
  };
}

/** Whether a non-force local backstop should re-run the local CLI. */
export function isLocalSessionsStale(
  lastLocalFetchAt: number | null | undefined,
  now = Date.now(),
  ttlMs = LOCAL_SESSIONS_BACKSTOP_MS,
): boolean {
  if (lastLocalFetchAt == null || !Number.isFinite(lastLocalFetchAt)) return true;
  return now - lastLocalFetchAt >= ttlMs;
}

/**
 * Merge a local-only session list into a full floor snapshot, preserving remote
 * rows and updating this-mac freshness.
 */
export function mergeLocalSessionsIntoSnapshot(
  previous: FloorHostSessionsSnapshot | null | undefined,
  localSessions: RemoteSession[],
  localHost: HostInfo,
  fetchedAt: number,
): FloorHostSessionsSnapshot {
  const remoteSessions = (previous?.sessions ?? []).filter((s) => s.host !== localHost.name);
  const sessions = [...remoteSessions, ...localSessions];
  const hostsMap = new Map<string, HostInfo>();
  for (const h of previous?.hosts ?? []) hostsMap.set(h.name, h);
  hostsMap.set(localHost.name, localHost);
  const hosts = [...hostsMap.values()];
  const groups = (previous?.groups ?? [])
    .filter((g) => g.host !== localHost.name)
    .concat([{
      host: localHost.name,
      online: localHost.online,
      fetchedAt,
      sessions: localSessions,
    }]);
  const hostFreshness = {
    ...(previous?.hostFreshness ?? {}),
    [localHost.name]: fetchedAt,
  };
  return {
    hosts,
    sessions,
    groups,
    fetchedAt: previous?.fetchedAt && previous.fetchedAt > fetchedAt ? previous.fetchedAt : fetchedAt,
    hostFreshness,
    fromCache: false,
  };
}

/**
 * Fold the registry roster into last-good Floor state without claiming a
 * sessions refresh. Existing counts/load/freshness survive; newly registered
 * hosts render immediately with zero counts and freshness 0.
 */
export function mergeHostRosterIntoSnapshot(
  previous: FloorHostSessionsSnapshot | null | undefined,
  roster: readonly HostInfo[],
): FloorHostSessionsSnapshot {
  const previousHosts = new Map((previous?.hosts ?? []).map((host) => [host.name, host]));
  const sessions = previous?.sessions ?? [];
  const sessionHosts = new Set(sessions.map((session) => session.host));
  const hosts = roster.map((host) => {
    const prior = previousHosts.get(host.name);
    return prior
      ? { ...prior, online: host.online }
      : host;
  });
  const rosterNames = new Set(hosts.map((host) => host.name));
  for (const prior of previous?.hosts ?? []) {
    if (!rosterNames.has(prior.name) && sessionHosts.has(prior.name)) hosts.push(prior);
  }
  const hostFreshness: Record<string, number> = { ...(previous?.hostFreshness ?? {}) };
  for (const host of hosts) {
    if (hostFreshness[host.name] === undefined) hostFreshness[host.name] = 0;
  }
  return {
    hosts,
    sessions,
    groups: previous?.groups ?? [],
    fetchedAt: previous?.fetchedAt ?? 0,
    hostFreshness,
    fromCache: true,
  };
}

/** Inventory SWR: true when a revalidate is due (or never fetched). */
export function isInventoryStale(
  fetchedAt: number | null | undefined,
  now = Date.now(),
  ttlMs = INVENTORY_CACHE_TTL_MS,
): boolean {
  if (fetchedAt == null || !Number.isFinite(fetchedAt)) return true;
  return now - fetchedAt >= ttlMs;
}

/** Only an explicit user refresh may invoke the bare fleet CLI. */
export function shouldRunBareFleetFetch(force: boolean): boolean {
  return force;
}
