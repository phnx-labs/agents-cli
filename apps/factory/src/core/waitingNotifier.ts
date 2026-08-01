/**
 * Waiting/approval notification transition logic (RUSH-2039).
 *
 * The Factory Floor already knows when a session is blocked waiting for input
 * (`TerminalDetail.waitingForInput`, fed by the CLI's own state engine — for
 * Codex this is now driven by the PermissionRequest feed hook). But knowing it
 * and telling the user are two different things: before this, a blocked Codex
 * agent stalled silently. This module turns the per-poll waiting state into
 * edge-triggered notifications: fire once when a session ENTERS the waiting
 * state, never again until it leaves and re-enters.
 *
 * Pure on purpose (no VS Code deps) so the edge detection is unit-testable; the
 * VS Code surface (showInformationMessage + "Focus terminal") lives in
 * waitingNotifier.vscode.ts.
 */

/** The minimal per-session shape the transition logic needs. */
export interface WaitingSessionInput {
  sessionId: string | null;
  agentType: string;
  label?: string | null;
  waitingForInput?: boolean;
}

/** A session that just transitioned into the waiting state this poll. */
export interface NewlyWaiting {
  sessionId: string;
  agentType: string;
  label: string;
}

/**
 * Given the set of session ids that were waiting last poll and the current
 * floor sessions, compute:
 *   - `newlyWaiting`: sessions that entered the waiting state this poll (edge)
 *   - `nextWaiting`: the set to carry into the next poll
 *
 * A session only appears in `newlyWaiting` on the rising edge — the poll where
 * it flips false→true. It is dropped from the carried set once it stops
 * waiting, so a later re-entry fires again.
 */
export function detectNewlyWaiting(
  previousWaiting: ReadonlySet<string>,
  current: readonly WaitingSessionInput[],
): { newlyWaiting: NewlyWaiting[]; nextWaiting: Set<string> } {
  const nextWaiting = new Set<string>();
  const newlyWaiting: NewlyWaiting[] = [];

  for (const s of current) {
    if (!s.sessionId || s.waitingForInput !== true) continue;
    nextWaiting.add(s.sessionId);
    if (previousWaiting.has(s.sessionId)) continue; // already notified this cycle
    newlyWaiting.push({
      sessionId: s.sessionId,
      agentType: s.agentType,
      label: (s.label && s.label.trim()) || `${s.agentType} session`,
    });
  }

  return { newlyWaiting, nextWaiting };
}

/** Human notification text for a session blocked on approval/input. */
export function formatWaitingMessage(s: NewlyWaiting): string {
  return `${s.label} is waiting for your approval.`;
}
