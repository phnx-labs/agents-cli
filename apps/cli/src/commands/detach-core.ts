/**
 * Pure core of `agents detach` — the nudge, the resumed-run argv, and the id
 * resolver. Kept import-light (only a type import) so it is unit-tested without
 * loading the live-session discovery graph.
 */
import type { ActiveSession } from '../lib/session/active.js';

/**
 * The prompt the backgrounded run resumes with. Its whole job is to stop a
 * now-unwatched agent from stalling on a confirmation nobody will answer: it
 * tells the agent it is headless and to drive to done, or to stop and state a
 * blocker (which surfaces as a waiting session the user can `attach`).
 */
export const BACKGROUND_NUDGE =
  "You've been sent to the background — nobody is watching this session now. " +
  'Continue the current task and drive it to completion end-to-end. ' +
  "Don't ask for confirmation; make the reasonable call and keep going. " +
  'If you genuinely cannot proceed safely, stop and state the blocker plainly in one message.';

/**
 * Build the argv for the headless continuation `detach` spawns. Agent-agnostic
 * and version-pinned by construction — it goes through the same `agents run
 * --resume` path `attach` reverses.
 */
export function buildBackgroundArgv(agent: string, sessionId: string, cwd?: string): string[] {
  const argv = ['run', agent, BACKGROUND_NUDGE, '--resume', sessionId, '--headless'];
  if (cwd) argv.push('--cwd', cwd);
  return argv;
}

/**
 * Resolve `<id>` to exactly one live session by prefix. Mirrors `focus`'s match
 * so the two verbs accept the same ids.
 */
export function resolveOne(
  activeById: Map<string, ActiveSession>,
  id: string,
): ActiveSession | { error: string } {
  const q = id.toLowerCase();
  const matches = [...activeById.values()].filter((s) => (s.sessionId ?? '').toLowerCase().startsWith(q));
  if (matches.length === 0) return { error: `No live session matching "${id}".` };
  if (matches.length > 1) {
    return { error: `"${id}" is ambiguous (${matches.length} live matches). Use more of the id.` };
  }
  return matches[0];
}
