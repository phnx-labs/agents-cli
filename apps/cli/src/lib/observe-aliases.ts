/**
 * Observe-umbrella aliases (Phase 3 surface consolidation).
 *
 * Thin name → real command expansion. No store merge — feed / sessions / events
 * remain the stores; these are doors that point at the right reader.
 *
 *   inbox    → feed                  (needs-you default)
 *   timeline → feed --filter updates (agent progress stream)
 *
 * `roster` was removed — use `agents sessions --active`.
 * `audit` is NOT an alias here — `agents audit` is already the tamper-evident
 * run-dispatch log. Ops trail = `agents events` (optionally `--audit`).
 */

export type ObserveAlias = 'inbox' | 'timeline';

export const OBSERVE_ALIASES: readonly ObserveAlias[] = ['inbox', 'timeline'] as const;

export interface ObserveExpandResult {
  /** argv for the real command (no program name): e.g. ['feed', '--filter', 'updates'] */
  argv: string[];
  /** One-line note for stderr (optional); empty when silent. */
  note: string;
}

/** True when `rest` already carries a `--filter` / `--filter=…` flag. */
export function hasFilterFlag(rest: readonly string[]): boolean {
  return rest.some((a) => a === '--filter' || a.startsWith('--filter='));
}

/** True when `rest` already carries `--active`. */
export function hasActiveFlag(rest: readonly string[]): boolean {
  return rest.some((a) => a === '--active');
}

/**
 * Expand an observe alias + remaining user args into the real command argv.
 * Returns null when `alias` is not an observe alias.
 */
export function expandObserveAlias(
  alias: string,
  rest: readonly string[] = [],
): ObserveExpandResult | null {
  const tail = [...rest];
  switch (alias) {
    case 'inbox':
      return {
        argv: ['feed', ...tail],
        note: 'agents inbox → agents feed (needs-you inbox)',
      };
    case 'timeline': {
      const argv = hasFilterFlag(tail)
        ? ['feed', ...tail]
        : ['feed', '--filter', 'updates', ...tail];
      return {
        argv,
        note: 'agents timeline → agents feed --filter updates',
      };
    }
    default:
      return null;
  }
}
