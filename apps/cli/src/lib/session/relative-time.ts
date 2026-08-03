/**
 * Human-readable "time since" formatting for session timestamps. Lives here (not
 * inline in `sessions.ts`) so both the session list renderer and the remote
 * offline-cache banner (`remote.ts`) share one formatter — `sessions.ts` imports
 * `remote.ts`, so a back-import would cycle.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Calendar label for a timestamp older than the relative window. A 2-digit year
 * is appended outside the current year so "Jun 28" is never ambiguous across
 * years (e.g. "Jun 28 '25").
 */
function calendarLabel(thenMs: number, nowMs: number): string {
  const d = new Date(thenMs);
  const label = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(nowMs).getFullYear()
    ? label
    : `${label} '${String(d.getFullYear()).slice(-2)}`;
}

export function formatRelativeTime(isoTimestamp: string): string {
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();
  if (isNaN(then)) return isoTimestamp;

  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHrs = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffHrs < 24) return `${diffHrs} hour${diffHrs === 1 ? '' : 's'} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;

  // Older: show the date.
  return calendarLabel(then, now);
}

/**
 * Compact age — `now`, `45m`, `3h`, `2d`, then the calendar date. This is the
 * *creation* half of a session's time cell: it renders right next to the long
 * last-activity label, and one row can afford one long form, not two.
 */
export function formatCompactAge(isoTimestamp: string): string {
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();
  if (isNaN(then)) return isoTimestamp;

  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHrs = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  if (diffHrs < 24) return `${diffHrs}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return calendarLabel(then, now);
}

/**
 * Shortest creation→last-activity gap worth rendering as two fields. Below it
 * both halves name the same minute, so the row would carry a duplicate instead
 * of information.
 */
const SPAN_MIN_MS = 60_000;

/** The two time fields a session listing shows for one row. */
export interface SessionAgeParts {
  /**
   * Compact age of the session's creation, set only when the session ran long
   * enough (>= a minute) for it to say something `last` does not.
   */
  created?: string;
  /** Last-activity label — the long relative form the listing sorts by. */
  last: string;
}

/**
 * Split a session's timestamps into the two fields a listing renders: when it
 * was created and when it was last active. One last-activity label answers
 * neither "is this the old session I'm looking for" nor "how long did it run" —
 * a session touched an hour ago may have started last week.
 */
export function sessionAgeParts(createdIso: string, lastActivityIso?: string): SessionAgeParts {
  const lastIso = lastActivityIso ?? createdIso;
  const last = formatRelativeTime(lastIso);
  const createdMs = new Date(createdIso).getTime();
  const lastMs = new Date(lastIso).getTime();
  if (isNaN(createdMs) || isNaN(lastMs) || lastMs - createdMs < SPAN_MIN_MS) return { last };
  return { created: formatCompactAge(createdIso), last };
}
