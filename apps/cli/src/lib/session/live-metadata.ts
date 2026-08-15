// ---------------------------------------------------------------------------
// Live-registry → SessionMeta bridge (RUSH-2682)
// ---------------------------------------------------------------------------
//
// A session the live registry (`getActiveSessions`) already knows about can be
// minutes ahead of the transcript index on the SAME box: indexing is lazy and
// only runs inside `discoverSessions`, so a session this machine JUST started is
// "running" in `agents sessions --active` while `agents sessions preview <id>`
// answers "No session matching" until an unrelated `agents sessions*` call
// happens to scan (measured 7.6 min blind on zion, agents-cli 1.22.39).
//
// This module converts a running `ActiveSession` into a `SessionMeta` candidate
// so the id resolver behind `preview` / `resume` / `focus` can resolve and render
// a running session with no transcript row yet, instead of claiming it does not
// exist. It parses no transcript and renders nothing — it only reshapes process
// state the live registry already computed. When the transcript IS on disk, the
// synthesized row carries its path, so the downstream `buildPreview` renders the
// real digest; otherwise it renders the header + a "not indexed here" note.

import { deriveShortId } from './short-id.js';
import { isSessionTrackedAgent, type SessionMeta } from './types.js';
import type { ActiveSession } from './active.js';

/**
 * Reshape one live `ActiveSession` into a `SessionMeta` candidate for the id
 * resolver. Returns `null` for a row that cannot back a durable session — no
 * `sessionId`, or a `kind` that is not a session-tracked harness (cloud/team
 * rows without a real agent transcript). Pure: the caller supplies `self` (the
 * local machine id) and `nowMs` so the row is deterministic and testable.
 */
export function activeSessionToSessionMeta(
  active: ActiveSession,
  self: string,
  nowMs: number,
): SessionMeta | null {
  const id = active.sessionId;
  if (!id) return null;
  if (!isSessionTrackedAgent(active.kind)) return null;

  const startedMs = active.startedAtMs ?? nowMs;
  const lastMs = active.lastActivityMs ?? startedMs;

  return {
    id,
    shortId: deriveShortId(id),
    agent: active.kind,
    timestamp: new Date(startedMs).toISOString(),
    lastActivity: new Date(lastMs).toISOString(),
    // An empty file path is honest — a just-created session may have no
    // transcript on disk yet, and `buildPreview` renders the header + a live
    // note for that case rather than trying to parse a missing file.
    filePath: active.sessionFile ?? '',
    cwd: active.cwd,
    project: active.project ?? undefined,
    label: active.label,
    topic: active.topic,
    version: active.version,
    messageCount: undefined,
    // The row runs HERE — the local live registry is machine-local, so a match
    // resolves without an SSH hop back to a peer.
    machine: active.machine ?? self,
    ticketId: active.ticket?.id,
    prUrl: active.pr?.url,
    prNumber: active.pr?.number,
    worktreeSlug: active.worktree?.slug,
    gitBranch: active.worktree?.branch,
    origin: active.origin,
    routineName: active.routineName,
  };
}

/**
 * Map every eligible live session to a `SessionMeta` candidate. Ineligible rows
 * (no id, non-agent kind) are dropped. Order follows the input.
 */
export function liveSessionMetas(
  active: ActiveSession[],
  self: string,
  nowMs: number,
): SessionMeta[] {
  const out: SessionMeta[] = [];
  for (const a of active) {
    const meta = activeSessionToSessionMeta(a, self, nowMs);
    if (meta) out.push(meta);
  }
  return out;
}
