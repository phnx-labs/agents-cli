/**
 * Contract every resource staleness checker implements. Each checker owns
 * the layer-resolution and entry-shape rules for one resource type. The
 * aggregator in `../index.ts` doesn't know any of those details — it just
 * calls these three methods.
 *
 * Why three methods (not just "isStale"):
 *   - `listNames`   feeds both the manifest writer (what to record) and the
 *     name-set diff (`stored` vs. `current` reveals adds/removes).
 *   - `build`       produces the entry for a single name; called per name
 *     after listing. Pure — no comparison logic.
 *   - `isFresh`     checks one stored entry against current state; called
 *     when the name set already matches and we need content-level certainty.
 *
 * The `unknown` entry type is intentional — each checker round-trips its
 * own concrete shape through JSON (commands/hooks/mcp use FileEntry; skills
 * /subagents/workflows/plugins use DirEntry; rules/permissions use their
 * own composite entries).
 */

export interface ResourceChecker {
  /** Stable identifier; matches the manifest field name. */
  readonly type: string;

  /** Names of every resource currently available across this checker's layers. */
  listNames(cwd: string): string[];

  /**
   * Build a manifest entry for one name. Returns null when no source file is
   * found — the aggregator drops nulls so name-set diff stays accurate.
   */
  build(name: string, cwd: string): unknown | null;

  /**
   * Check whether a stored entry still reflects current source. Called only
   * after the name-set already matches. Returns true when fresh, false when
   * the entry should trigger a re-sync.
   */
  isFresh(name: string, stored: unknown, cwd: string): boolean;
}

/**
 * Helper for checkers whose entry shape varies. Strict-typed convenience
 * wrapper that callers can use to avoid `unknown` casts in their own code.
 */
export interface TypedResourceChecker<TEntry> extends ResourceChecker {
  build(name: string, cwd: string): TEntry | null;
  isFresh(name: string, stored: TEntry, cwd: string): boolean;
}
