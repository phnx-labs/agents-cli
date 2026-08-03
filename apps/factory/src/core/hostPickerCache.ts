import { normalizeHost } from '../shared/project';
import type { HostUsageScore } from './agentUsage';

/**
 * The persisted snapshot behind the host picker's stale-while-revalidate flow.
 * The picker renders from this instantly (even minutes or restarts old), fires
 * one background refresh, and swaps the items in place when fresh data lands —
 * the menu never blocks on the fleet-wide SSH sweep again.
 *
 * `devices` mirrors the vscode-side `Device` (deviceHealth.vscode.ts), which is
 * JSON-serializable; the extra fields ride along for pickers that need them.
 */
export interface HostPickerDevice {
  name: string;
  host: string;
  secretRef?: string;
  user?: string;
  platform?: string;
  online?: boolean;
  registeredAt?: number;
}

export interface HostPickerCache {
  devices: HostPickerDevice[];
  /** Usage scores keyed by normalized host name ('this-mac' for the local box). */
  usage: Record<string, HostUsageScore>;
  /** When the device rows (names + reachability) were last read from the registry. Drives the row freshness label. */
  fetchedAt: number;
  /**
   * When the fleet usage sweep last ran. Drives `isHostPickerStale`, kept SEPARATE
   * from `fetchedAt` so a cheap device-only refresh (which bumps `fetchedAt`) can
   * never mask stale usage scores as fresh and skip the sweep.
   */
  usageFetchedAt: number;
}

export const HOST_PICKER_CACHE_KEY = 'agents.hostPicker.v1';

/** Revalidate at most this often — a fresher snapshot is reused as-is. */
export const HOST_PICKER_STALE_MS = 60_000;

export function serializeUsage(scores: Map<string, HostUsageScore>): Record<string, HostUsageScore> {
  return Object.fromEntries(scores);
}

/** Shape-check a value read back from globalState; returns undefined on drift. */
export function parseHostPickerCache(raw: unknown): HostPickerCache | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Partial<HostPickerCache>;
  if (!Array.isArray(c.devices) || typeof c.fetchedAt !== 'number') return undefined;
  if (!c.usage || typeof c.usage !== 'object' || Array.isArray(c.usage)) return undefined;
  // Legacy caches (pre two-phase split) carried one timestamp; it WAS the combined
  // device+usage refresh time, so read it as the usage time.
  if (typeof c.usageFetchedAt !== 'number') c.usageFetchedAt = c.fetchedAt;
  return c as HostPickerCache;
}

export function isHostPickerStale(cache: HostPickerCache | null | undefined, now = Date.now()): boolean {
  // Gate on the USAGE sweep time, not the device-row time: a cheap device-only
  // refresh keeps `usageFetchedAt` old, so the picker still runs the sweep on
  // the next open instead of trusting a "fresh"-looking device snapshot.
  return !cache || now - cache.usageFetchedAt >= HOST_PICKER_STALE_MS;
}

/**
 * The picker's device order: online first, then how much the box is actually
 * used, then name. Pure so the stale render and the revalidated render sort
 * identically — the item swap never reshuffles a row the scores didn't move.
 */
export function sortHostPickerDevices<T extends Pick<HostPickerDevice, 'name' | 'online'>>(
  devices: readonly T[],
  usage: Record<string, HostUsageScore>,
): T[] {
  const scoreOf = (name: string) => usage[normalizeHost(name)]?.score ?? 0;
  return [...devices].sort(
    (a, b) =>
      Number(b.online) - Number(a.online) ||
      scoreOf(b.name) - scoreOf(a.name) ||
      a.name.localeCompare(b.name),
  );
}

/** Short age label appended to picker rows so a stale snapshot reads as stale. */
export function freshnessSuffix(fetchedAt: number, now = Date.now()): string {
  const ageMs = Math.max(0, now - fetchedAt);
  if (ageMs < 60_000) return 'updated just now';
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 60) return `updated ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  return `updated ${Math.floor(hours / 24)}d ago`;
}

/**
 * Fold a fresh fetch into the previous snapshot. An EMPTY device list is a
 * failed registry read (CLI timeout on a loaded box, a hiccup mid-upgrade),
 * never a real empty fleet — so it must never overwrite rows the user saw a
 * minute ago. Returns null when there is no confident data at all, in which
 * case the caller persists nothing and the picker stays in cold-start mode.
 *
 * Keeping the previous rows also keeps their TRUE age (`previous.fetchedAt` AND
 * `previous.usageFetchedAt`): a failed refresh must not stamp the snapshot fresh,
 * or the rows' age label would read "updated just now" while showing hour-old
 * data and the staleness gate would stop retrying. (Known edge: a registry
 * emptied down to zero devices can never clear the picker — "empty" is treated as
 * never real.)
 *
 * The two timestamps are separate on purpose: the cheap device-only phase
 * (`refreshHostPickerDevices`) calls this with fresh `devices` but carries the
 * PRIOR `usageFetchedAt` forward, so a device refresh never masks stale usage
 * scores as fresh — `isHostPickerStale` keys off `usageFetchedAt` and still runs
 * the sweep on the next open.
 */
export function mergeHostPickerSnapshot(
  previous: HostPickerCache | null,
  devices: HostPickerDevice[],
  usage: Record<string, HostUsageScore>,
  fetchedAt: number,
  usageFetchedAt: number,
): HostPickerCache | null {
  if (devices.length === 0) {
    if (previous && previous.devices.length > 0) {
      return {
        devices: previous.devices,
        usage: Object.keys(usage).length > 0 ? usage : previous.usage,
        fetchedAt: previous.fetchedAt,
        usageFetchedAt: previous.usageFetchedAt,
      };
    }
    return null;
  }
  return { devices, usage, fetchedAt, usageFetchedAt };
}
