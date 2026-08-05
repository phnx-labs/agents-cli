/**
 * Percentile of a sorted-ascending array, linear interpolation. p in [0,100].
 *
 * Deliberately its own file with zero imports: `perf/db.ts` (the SQLite
 * warehouse), `hooks/profile.ts` (the legacy JSONL hook profile), and
 * `routines.ts` (routineStats) all need this exact formula, but `routines.ts`
 * and `hooks/profile.ts` must NOT pull in `perf/db.ts`'s `../sqlite.js`
 * dependency just to round a percentile — sqlite is a heavier, perf-warehouse-
 * specific dependency that has no business loading into every routines- or
 * hooks-touching code path.
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}
