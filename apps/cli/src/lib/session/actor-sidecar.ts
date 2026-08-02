/**
 * Durable sessionId -> actor sidecar (RUSH-2019, P3 lineage).
 *
 * The actor behind a run is resolved at spawn (`resolveActor()`), but the session
 * transcript on disk carries no record of it — so the scanner that indexes those
 * transcripts into `sessions.db` (`discover.ts` -> `upsertSessionsBatch`) has
 * nothing to attribute a session to a person with. The pid-registry answers this
 * for LIVE processes (`--active` owner, RUSH-2018), but it lives under `.cache`
 * and is pruned when the pid dies, so it can't back a DURABLE, historical listing.
 *
 * This module writes one small, durable record per launched session — keyed by
 * session id, under `~/.agents/.history` (never pruned) — that the scanner joins
 * on to fill the write-once `actor` / `initiated_by` columns. Best-effort
 * throughout: a failed write or a corrupt file degrades to an unattributed row,
 * never throws into the launch or the scan path.
 */
import fs from 'fs';
import path from 'path';
import { getHistoryDir } from '../state.js';

export interface SessionActorRecord {
  sessionId: string;
  /** Resolved actor id (`resolveActor().id`) — the responsible human/agent. */
  actor: string;
  /** Actor kind (`resolveActor().kind`). */
  initiatedBy: 'human' | 'agent';
  startedAtMs: number;
}

function sidecarDir(): string {
  return path.join(getHistoryDir(), 'by-session');
}

function recordPath(sessionId: string): string {
  return path.join(sidecarDir(), `${sessionId}.json`);
}

/**
 * Record the actor a session was launched under. Never throws — the sidecar is
 * an attribution optimization; a session with no record simply scans unattributed.
 * No-ops without a concrete session id (nothing to key on).
 */
export function writeSessionActorRecord(record: SessionActorRecord): void {
  if (!record.sessionId) return;
  try {
    fs.mkdirSync(sidecarDir(), { recursive: true });
    fs.writeFileSync(recordPath(record.sessionId), JSON.stringify(record), 'utf8');
  } catch {
    /* degrade to an unattributed row */
  }
}

/** Read one session's actor record. Returns undefined if absent/corrupt. */
export function readSessionActorRecord(sessionId: string): SessionActorRecord | undefined {
  if (!sessionId) return undefined;
  let raw: string;
  try {
    raw = fs.readFileSync(recordPath(sessionId), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.sessionId === 'string' && typeof parsed.actor === 'string') {
      return parsed as SessionActorRecord;
    }
  } catch {
    /* unparseable */
  }
  return undefined;
}

/**
 * Load every session actor record into a `sessionId -> record` map, for the scan
 * path to join a whole batch of sessions in one directory read instead of a
 * stat-per-row. Best-effort: unreadable/corrupt files are skipped, a missing dir
 * yields an empty map.
 */
export function loadSessionActorIndex(): Map<string, SessionActorRecord> {
  const out = new Map<string, SessionActorRecord>();
  let files: string[];
  try {
    files = fs.readdirSync(sidecarDir()).filter(f => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(sidecarDir(), f), 'utf8'));
      if (parsed && typeof parsed === 'object' && typeof parsed.sessionId === 'string' && typeof parsed.actor === 'string') {
        out.set(parsed.sessionId, parsed as SessionActorRecord);
      }
    } catch {
      /* raced with a writer, or corrupt — skip */
    }
  }
  return out;
}
