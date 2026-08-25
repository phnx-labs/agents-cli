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
 * Weight one candidate by remaining routing capacity, deprioritized by how soon
 * it is projected to cap. The base is weekly headroom (`max(1, 100 - used)`);
 * an account with no live snapshot is treated as full-capacity (100) since there
 * is no signal to deprioritize it. `minutesToLimit` (the daemon's burn-rate
 * projection on the 5h session window) then scales that base: >= horizon (or
 * unknown) keeps full weight, and closer-to-cap scales toward the floor of 1 —
 * so a launch avoids an account projected to cap soon, not just a 100%-maxed
 * one. Pure + exported so the deprioritization is unit-tested directly (a
 * weighted-random draw is not).
 */
export function capacityWeight(
  usedPercent: number | null,
  minutesToLimit: number | null,
): number {
  const base = usedPercent === null ? 100 : Math.max(1, 100 - usedPercent);
  if (minutesToLimit === null || !Number.isFinite(minutesToLimit)) return base;
  const factor = Math.max(0, Math.min(1, minutesToLimit / PROJECTION_HORIZON_MIN));
  return Math.max(1, base * factor);
}
