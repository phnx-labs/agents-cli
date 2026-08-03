/**
 * Human-readable "time since" formatting for session timestamps. Lives here (not
 * inline in `sessions.ts`) so both the session list renderer and the remote
 * offline-cache banner (`remote.ts`) share one formatter — `sessions.ts` imports
 * `remote.ts`, so a back-import would cycle.
 */
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

  // Older: show the date. Append a 2-digit year for anything outside the current
  // year so "Jun 28" is never ambiguous across years (e.g. "Jun 28 '25").
  const d = new Date(then);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const label = `${months[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear()
    ? label
    : `${label} '${String(d.getFullYear()).slice(-2)}`;
}

/**
 * Parse a time filter string (relative like '7d' or an ISO timestamp) into epoch
 * milliseconds. Backs `--since` on `sessions`, `cost`, `teams`, and `output`, and
 * `--unused` on `secrets list`.
 *
 * It lives here, in a module with no imports, rather than in `discover.ts` where
 * it started: `discover.ts` loads `../sqlite.js`, so importing this one function
 * from there pulls `node:sqlite` into the caller's module graph and Node prints
 * `ExperimentalWarning: SQLite …` on stderr. That is invisible in a command that
 * already touches the session DB, and a broken contract in one that doesn't —
 * `monitors --json` asserts a clean stderr. `discover.ts` re-exports it, so
 * existing importers are unaffected.
 */
export function parseTimeFilter(input: string): number {
  // Units: m=minute, h=hour, d=day, w=week, mo=month(30d), y=year(365d). `mo`
  // must precede the single-letter alternatives so "1mo" isn't read as "1m"+"o".
  const relativeMatch = input.match(/^(\d+)(mo|[mhdwy])$/i);
  if (relativeMatch) {
    const value = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2].toLowerCase();
    if (unit === 'm') return Date.now() - value * 60_000;
    if (unit === 'h') return Date.now() - value * 3_600_000;
    if (unit === 'd') return Date.now() - value * 86_400_000;
    if (unit === 'w') return Date.now() - value * 7 * 86_400_000;
    if (unit === 'mo') return Date.now() - value * 30 * 86_400_000;
    if (unit === 'y') return Date.now() - value * 365 * 86_400_000;
  }
  const ts = new Date(input).getTime();
  return Number.isNaN(ts) ? 0 : ts;
}
