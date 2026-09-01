/**
 * Rush session freshness — the ONE judgment shared by every consumer of
 * ~/.rush/user.yaml (cloud dispatch, cloud session source, secrets sync driver).
 *
 * A Rush session stores `expires_at` as Unix seconds. Two values mean "never
 * expires" and MUST NOT be read as an absolute timestamp:
 *   - `0`         — an opaque Phoenix `pid_` bearer written by `rush login`;
 *                   `0` = non-expiring by contract (mirrors rush/cli's isFresh,
 *                   the same fix RUSH-1310 landed for the daemon-less freshness
 *                   check and PHNX-3637 landed for the release endpoints).
 *   - `undefined` — a token written without an expiry.
 *
 * Reading `expires_at: 0` as epoch-1970 was PHNX-3645: every Phoenix-authed box
 * had its valid, non-expiring session rejected as "Rush session expired at
 * 1970-01-01", so `agents run --cloud`, `agents secrets push/pull` over Rush,
 * and cloud session discovery all refused to run. Every consumer that parses
 * freshness routes through this predicate so the special-case lives in one place.
 */
export function isRushSessionExpired(expiresAt: number | undefined): boolean {
  // `0` (non-expiring pid_ bearer) and a missing value are never expired.
  if (typeof expiresAt !== 'number' || expiresAt === 0) return false;
  return expiresAt <= Date.now() / 1000;
}
