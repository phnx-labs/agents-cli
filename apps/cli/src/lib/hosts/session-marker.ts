/**
 * Relate a remote-created session id back to the launching agent.
 *
 * A host dispatch (`agents run --host`) launches `agents run` on the remote box.
 * Only Claude accepts a forced `--session-id`, so for every OTHER agent the
 * remote run coins its OWN session id (via its SessionStart hook) and the
 * launcher never learns it — the run is orphaned in `agents sessions`.
 *
 * This module closes that gap without an extra SSH round-trip: the dispatch
 * forwards `--emit-session-id`, which makes the remote `agents run` print its
 * resolved session id as a stable one-line sentinel to stdout. That line rides
 * the same combined log the follow already mirrors locally, so the launcher
 * parses the id straight out of the streamed output and stamps it on the task.
 *
 * The marker is a fixed ASCII frame with the id on its own line. A real session
 * id (`[A-Za-z0-9._-]`) never contains the marker's own bytes, so the parser can
 * scan for the LAST occurrence and stay robust to an agent echoing the token in
 * its own output.
 */

const MARKER_PREFIX = '@@AGENTS_SESSION_ID ';
const MARKER_SUFFIX = '@@';

/** Only characters a real agent session id can hold — no marker bytes, no spaces. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

/**
 * The single line the remote run prints to stdout so the launcher can capture
 * the session id the remote coined. Newline-framed on both sides so it lands on
 * its own line regardless of what the agent last wrote.
 */
export function sessionIdMarkerLine(sessionId: string): string {
  return `\n${MARKER_PREFIX}${sessionId}${MARKER_SUFFIX}\n`;
}

/**
 * Extract the session id from a chunk of followed remote output, or null when no
 * marker is present. Scans for the LAST marker (so an id echoed into the log
 * earlier can never mask the real trailing sentinel) and validates the captured
 * token against the session-id charset — a malformed frame yields null rather
 * than a bogus id that could never match a real session.
 */
export function parseSessionIdMarker(text: string): string | null {
  const last = text.lastIndexOf(MARKER_PREFIX);
  if (last === -1) return null;
  const start = last + MARKER_PREFIX.length;
  const end = text.indexOf(MARKER_SUFFIX, start);
  if (end === -1) return null;
  const id = text.slice(start, end).trim();
  if (!SESSION_ID_RE.test(id)) return null;
  return id;
}
