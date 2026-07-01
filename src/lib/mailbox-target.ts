/**
 * Resolve an `agents message <target>` argument to exactly one destination —
 * a cloud task, one live local/teams/loop agent, or an error. The anti-misroute
 * rule lives here: a target that matches zero or more-than-one live agent is
 * NEVER guessed; the caller reports it. Pure (no I/O) so it is unit-testable.
 */
import type { ActiveSession } from './session/active.js';

export type MessageResolution =
  | { kind: 'cloud'; id: string }
  | { kind: 'local'; id: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: Array<{ id: string; label: string }> };

/**
 * The mailbox id a live session's box is keyed by. Teams stamp a durable
 * `agentId` (== the Claude session id for Claude teammates); a bare run has
 * only its `sessionId`. The spawn-time `AGENTS_MAILBOX_DIR` wiring must key the
 * box by this same id — this is the single source of truth for both sides.
 */
export function mailboxIdForActiveSession(s: ActiveSession): string | undefined {
  return s.agentId ?? s.sessionId;
}

function labelFor(s: ActiveSession): string {
  return s.label ?? s.topic ?? s.teamName ?? s.host ?? s.context;
}

/**
 * Resolve `target` against the live sessions. Exact id matches win over prefix
 * matches; results are de-duped by canonical mailbox id (collapsed subagents
 * share one). `isCloudTask` is consulted first so a cloud task id routes to the
 * cloud provider.
 */
export function resolveMessageTarget(
  target: string,
  sessions: ActiveSession[],
  isCloudTask: (id: string) => boolean,
): MessageResolution {
  if (isCloudTask(target)) return { kind: 'cloud', id: target };

  const exact = sessions.filter(
    (s) => s.sessionId === target || s.agentId === target || s.cloudTaskId === target,
  );
  const chosen =
    exact.length > 0
      ? exact
      : sessions.filter(
          (s) => Boolean(s.sessionId?.startsWith(target)) || Boolean(s.agentId?.startsWith(target)),
        );

  // De-dupe by canonical mailbox id (one box per logical agent).
  const byId = new Map<string, ActiveSession>();
  for (const s of chosen) {
    const id = mailboxIdForActiveSession(s);
    if (id && !byId.has(id)) byId.set(id, s);
  }

  const ids = [...byId.keys()];
  if (ids.length === 0) return { kind: 'none' };
  if (ids.length === 1) return { kind: 'local', id: ids[0] };
  return {
    kind: 'ambiguous',
    candidates: [...byId.entries()].map(([id, s]) => ({ id, label: labelFor(s) })),
  };
}
