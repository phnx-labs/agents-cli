/**
 * Fleet distribution of lightweight per-session preview/metadata (PHNX-3792).
 *
 * On the interactive/personal device, a session that originated on another host
 * used to render as a bare `[host/<peer>]` row with no topic, and its preview
 * pane fetched the peer's digest LIVE over SSH per row — slow, and blank when
 * the peer is asleep. This module mirrors each box's own session digests into
 * its conflict-free `~/.agents/devices/<device>/daemon-state.json`, which the
 * daemon's existing bounded Git transport (`fleet-shared-repo-sync.ts`) already
 * delivers fleet-wide with no operator step. The consuming device folds peer
 * digests into its local `sessions` index as mirror rows, so the picker/list/
 * focus read a LOCAL row instead of dialing the peer. No transcript is shipped —
 * only topic/label, a first-user-message snippet, last-activity, agent+version,
 * cwd, ticket, and PR — and the mirror is bounded and pruned by age.
 *
 * Direction is deliberately the inverse of usage-sync: EVERY box publishes its
 * own local sessions (workers are exactly where the remote sessions the personal
 * box lacks previews for are created), and every box EXCEPT a marked worker folds
 * peers' digests in (the picker is an interactive surface). A worker skips the
 * consume so its DB is not written with rows it never renders.
 */
import { selfConfiguredDeviceRole, type ConfiguredDeviceRole } from '../device-config.js';
import {
  readFleetSharedDeviceStates,
  updateFleetSharedDeviceStateAsync,
  type SessionMirrorRow,
} from '../fleet-shared-state.js';
import { getUserAgentsDir } from '../state.js';
import { machineId, normalizeHost } from './sync/config.js';
import {
  pruneMirrorSessions,
  queryLocalOriginSessionsForMirror,
  upsertMirrorSession,
} from './db.js';

/** Cap on sessions published per device — the payload stays what a picker shows. */
export const SESSION_MIRROR_MAX_ROWS = 200;
/** First-user-message snippet ceiling; the full turn stays on the owning box. */
export const SESSION_MIRROR_SNIPPET_MAX = 280;
/** Mirror rows older than this since their last sync are pruned (staleness/size ceiling). */
export const SESSION_MIRROR_MAX_AGE_MS = 14 * 24 * 60 * 60_000;

export interface PublishSessionMirrorOptions {
  userAgentsDir?: string;
  device?: string;
  limit?: number;
}

export interface PublishSessionMirrorResult {
  published: boolean;
  changed: boolean;
  count: number;
  skipped: string | null;
  error: string | null;
  path: string | null;
}

function snippet(value: string | null | undefined, max = SESSION_MIRROR_SNIPPET_MAX): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Publish this device's most-recent local sessions into its owned shared-state file. */
export async function publishSessionMirrorToSharedStore(
  options: PublishSessionMirrorOptions = {},
): Promise<PublishSessionMirrorResult> {
  const result: PublishSessionMirrorResult = {
    published: false, changed: false, count: 0, skipped: null, error: null, path: null,
  };
  const device = options.device ?? machineId();
  const self = normalizeHost(device);
  const limit = options.limit ?? SESSION_MIRROR_MAX_ROWS;
  const capturedAt = Date.now();
  const sources = queryLocalOriginSessionsForMirror(self, limit);
  const rows: SessionMirrorRow[] = sources.map((s) => ({
    id: s.id,
    shortId: s.shortId,
    agent: s.agent,
    ...(s.version ? { version: s.version } : {}),
    machine: s.machine?.trim() || self,
    ...(s.cwd ? { cwd: s.cwd } : {}),
    ...(snippet(s.topic, 200) ? { topic: snippet(s.topic, 200) } : {}),
    ...(s.label ? { label: s.label } : {}),
    ...(snippet(s.firstUserMessage) ? { firstUser: snippet(s.firstUserMessage) } : {}),
    ...(s.lastActivity ? { lastActivity: s.lastActivity } : {}),
    timestamp: s.timestamp,
    ...(s.ticketId ? { ticketId: s.ticketId } : {}),
    ...(s.prUrl ? { prUrl: s.prUrl } : {}),
    capturedAt,
  }));
  try {
    const write = await updateFleetSharedDeviceStateAsync(
      device,
      { sessions: { rows } },
      options.userAgentsDir ?? getUserAgentsDir(),
    );
    result.published = true;
    result.changed = write.changed;
    result.count = rows.length;
    result.path = write.path;
  } catch (err) {
    result.error = (err as Error).message;
  }
  return result;
}

export interface ConsumeSessionMirrorOptions {
  userAgentsDir?: string;
  device?: string;
  role?: ConfiguredDeviceRole;
  now?: number;
  maxAgeMs?: number;
}

export interface ConsumeSessionMirrorResult {
  sources: string[];
  merged: number;
  pruned: number;
  skipped: string | null;
  errors: Array<{ device: string; message: string }>;
}

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Validate one untrusted peer-supplied row into a DB upsert (or null when it is
 * missing a load-bearing field). Terminal-escape scrubbing is NOT done here —
 * the render path (`sanitizeMeta` in sessions-picker) scrubs every meta string
 * before it reaches a TTY, exactly as it does for live fan-out rows — this only
 * enforces shape and bounds so a malformed/hostile peer can't poison the index.
 */
function toUpsert(raw: unknown): {
  id: string; shortId: string; agent: string; version?: string; machine: string;
  cwd?: string; topic?: string; firstUser?: string; label?: string;
  lastActivity?: string; timestamp: string; ticketId?: string; prUrl?: string;
} | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isString(r.id) || !isString(r.agent) || !isString(r.machine)) return null;
  const timestamp = isString(r.timestamp) ? r.timestamp : (isString(r.lastActivity) ? r.lastActivity : null);
  if (!timestamp) return null;
  const shortId = isString(r.shortId) ? r.shortId : r.id.slice(0, 8);
  const cap = (v: unknown, max: number): string | undefined =>
    isString(v) ? (v.length > max ? v.slice(0, max) : v) : undefined;
  return {
    id: r.id,
    shortId,
    agent: r.agent,
    version: cap(r.version, 64),
    machine: r.machine,
    cwd: cap(r.cwd, 1024),
    topic: cap(r.topic, 400),
    firstUser: cap(r.firstUser, SESSION_MIRROR_SNIPPET_MAX),
    label: cap(r.label, 400),
    lastActivity: isString(r.lastActivity) ? r.lastActivity : undefined,
    timestamp,
    ticketId: cap(r.ticketId, 64),
    prUrl: cap(r.prUrl, 512),
  };
}

/**
 * Fold peers' published session digests into this box's local `sessions` index
 * as mirror rows, then prune stale ones. Reads only the local user-repo checkout
 * (the daemon's Git transport already delivered peers' files) — no network. A
 * marked worker skips: the mirror feeds an interactive picker it never renders.
 */
export function consumeSessionMirrorFromSharedStore(
  options: ConsumeSessionMirrorOptions = {},
): ConsumeSessionMirrorResult {
  const result: ConsumeSessionMirrorResult = { sources: [], merged: 0, pruned: 0, skipped: null, errors: [] };
  const role = options.role ?? selfConfiguredDeviceRole();
  const now = options.now ?? Date.now();
  if (role === 'worker') {
    // A worker never renders the picker, so it does not consume peers' digests.
    // But if this box was previously a non-worker it may still hold mirror rows,
    // which it will never refresh or render — prune them all now (cutoff = now
    // drops every row synced before this tick) rather than leave a demoted box's
    // index permanently bloated with stale peer rows (PHNX-3792).
    result.pruned = pruneMirrorSessions(now);
    result.skipped = 'this device is a worker; the session mirror feeds the interactive picker';
    return result;
  }
  const read = readFleetSharedDeviceStates(options.userAgentsDir ?? getUserAgentsDir());
  result.errors.push(...read.errors);
  const self = normalizeHost(options.device ?? machineId());
  for (const state of read.states) {
    if (normalizeHost(state.device) === self || !state.sessions?.rows) continue;
    let mergedForDevice = 0;
    for (const raw of state.sessions.rows) {
      const row = toUpsert(raw);
      if (!row) continue;
      if (upsertMirrorSession(row, state.device, now)) mergedForDevice++;
    }
    if (mergedForDevice > 0) {
      result.sources.push(state.device);
      result.merged += mergedForDevice;
    }
  }
  result.sources.sort();
  result.pruned = pruneMirrorSessions(now - (options.maxAgeMs ?? SESSION_MIRROR_MAX_AGE_MS));
  return result;
}
