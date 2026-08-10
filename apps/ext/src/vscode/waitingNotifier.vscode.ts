/**
 * VS Code surface for waiting/approval notifications (RUSH-2039).
 *
 * Bridges the Floor's `waitingForInput` signal (which now fires for Codex
 * approval prompts via the PermissionRequest feed hook) to a native VS Code
 * notification with a "Focus terminal" action. Edge-triggered via
 * detectNewlyWaiting so a session pages once per wait, not every 10s poll.
 */
import * as vscode from 'vscode';
import * as terminals from './terminals.vscode';
import {
  detectNewlyWaiting,
  formatWaitingMessage,
  type WaitingSessionInput,
} from '../core/waitingNotifier';

// Session ids that were waiting at the previous poll — the edge-detection state.
let waitingSessions = new Set<string>();

const FOCUS_ACTION = 'Focus terminal';

/**
 * Called once per floor poll with the current terminal details. Fires a
 * notification for each session that just entered the waiting state.
 */
export function notifyNewlyWaiting(current: readonly terminals.TerminalDetail[]): void {
  const inputs: WaitingSessionInput[] = current.map((t) => ({
    sessionId: t.sessionId,
    agentType: t.agentType,
    label: t.label ?? t.autoLabel ?? null,
    waitingForInput: t.waitingForInput,
  }));

  const { newlyWaiting, nextWaiting } = detectNewlyWaiting(waitingSessions, inputs);
  waitingSessions = nextWaiting;

  for (const s of newlyWaiting) {
    const message = formatWaitingMessage(s);
    // Non-blocking: the reveal fires from the button, the poll loop never waits.
    void vscode.window.showInformationMessage(message, FOCUS_ACTION).then((choice) => {
      if (choice !== FOCUS_ACTION) return;
      const entry = terminals.getBySessionId(s.sessionId);
      if (entry) {
        entry.terminal.show(true);
      }
    });
  }
}

/** Reset the edge-detection state (deactivation / tests). */
export function resetWaitingNotifierState(): void {
  waitingSessions = new Set<string>();
}
