/**
 * Harness scoping for an unlocked bundle — the shared vocabulary of the broker
 * (agent.ts), the durable session store (session-store.ts), and the read path
 * (bundles.ts).
 *
 * A grant is stored under a scope and read under a scope; the two must agree or
 * the bundle is invisible. `agents secrets unlock --for <agent>` exists to NARROW
 * a grant to one harness, so an unlock without it is global by definition.
 *
 * This module deliberately has NO imports: agent.ts and session-store.ts already
 * import each other, and hanging the scope constants off either one would close
 * that cycle — under ESM a cyclic `const` read can land in the temporal dead zone
 * and throw at runtime even though tsc is happy.
 */

/**
 * Scope of an unlock that was not narrowed with `--for`: readable by every
 * harness. Not a valid harness name, so it can never collide with one.
 */
export const GLOBAL_HARNESS = '*';

/**
 * Scopes a reader consults, most specific first: its own harness, then the global
 * grant. This is the resolution order of the scoped-grant model — a narrow
 * `--for claude` unlock stays claude-only while an unscoped unlock serves
 * everyone — not a fallback papering over a miss.
 */
export function bundleScopeChain(harness: string | undefined): string[] {
  const own = harness || GLOBAL_HARNESS;
  return own === GLOBAL_HARNESS ? [GLOBAL_HARNESS] : [own, GLOBAL_HARNESS];
}
