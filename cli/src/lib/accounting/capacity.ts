/**
 * Remaining-capacity weighting for account selection — a pure, dependency-free
 * primitive shared by the version-home router (`rotate.ts`) and the account pool
 * (`account-pool.ts`). Kept in its own module so either can import it without
 * dragging in the heavy usage/secrets graph.
 */

/**
 * How far from its projected cap an account must be to keep its FULL headroom
 * weight. Inside this horizon the weight is scaled down linearly toward the
 * floor, so an account racing toward its 5h cap loses priority before it maxes.
 */
export const PROJECTION_HORIZON_MIN = 30;

/**
 * The weight an account with NO usage snapshot draws. Absence of a usage signal
 * is NOT capacity (specifications.md GWT-E5c, SING-1a): a null snapshot means
 * "unverifiable", not "empty" — on a worker box every account reads null
 * (setup-token lacks the `user:profile` scope, RUSH-2392), so scoring null as
 * full capacity made the blind pool's top pick an account that was actually
 * weekly-exhausted (PHNX-3392). Floored at 1, never 0: an all-unverified pool
 * must still draw a pick rather than strand the launch.
 */
export const UNVERIFIED_WEIGHT = 1;

/**
 * Weight one candidate by remaining routing capacity, deprioritized by how soon
 * it is projected to cap. The base is weekly headroom (`max(1, 100 - used)`);
 * an account with no live snapshot is NOT full-capacity — absence of a usage
 * signal is not evidence of headroom, so it draws `UNVERIFIED_WEIGHT` and any
 * verified-healthy account outranks it (GWT-E5c). `minutesToLimit` (the daemon's
 * burn-rate projection on the 5h session window) then scales that base: >=
 * horizon (or unknown) keeps full weight, and closer-to-cap scales toward the
 * floor of 1 — so a launch avoids an account projected to cap soon, not just a
 * 100%-maxed one. Pure + exported so the deprioritization is unit-tested
 * directly (a weighted-random draw is not).
 */
export function capacityWeight(
  usedPercent: number | null,
  minutesToLimit: number | null,
): number {
  const base = usedPercent === null ? UNVERIFIED_WEIGHT : Math.max(1, 100 - usedPercent);
  if (minutesToLimit === null || !Number.isFinite(minutesToLimit)) return base;
  const factor = Math.max(0, Math.min(1, minutesToLimit / PROJECTION_HORIZON_MIN));
  return Math.max(1, base * factor);
}
