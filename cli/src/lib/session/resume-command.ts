/**
 * The one public command used by UI and lifecycle consumers to reopen a session.
 * `agents sessions resume` owns identity resolution, source-device routing,
 * version/home selection, and harness-specific continuation; callers must not
 * recreate it.
 */
export function buildCanonicalResumeCommand(sessionId: string): string[] {
  return ['agents', 'sessions', 'resume', sessionId];
}
