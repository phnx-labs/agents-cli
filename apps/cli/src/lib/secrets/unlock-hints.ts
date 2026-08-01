// Usage-based unlock hints: surface bundles you keep getting a Touch ID prompt
// for, so `agents secrets status` can suggest unlocking them once instead of
// prompting on every read. Built on the existing `secrets.get` audit events
// (events.jsonl) — no new tracking. Pure + exported so the threshold/filter
// logic is unit-testable without the events sink or the keychain.

/** The subset of a `secrets.get` event this heuristic reads. */
export interface SecretGetRecord {
  /** Bundle name the read targeted. */
  bundle?: string;
  /** Where the value came from: `agent` (broker hit) / `session` (durable
   *  unlock) are SILENT; anything else hit the keychain and thus prompted. */
  source?: string;
}

export interface PromptedBundle {
  name: string;
  /** Number of prompting (keychain) reads in the window. */
  count: number;
}

/**
 * From recent `secrets.get` records, find bundles read often enough via the
 * keychain (i.e. NOT served silently by the broker or a durable session) to be
 * worth unlocking once. A bundle currently `held` is already silent, so it is
 * excluded; the caller further drops `never`/no-ACL bundles (which never prompt,
 * so unlocking them is a no-op).
 *
 * @param records recent `secrets.get` events (any order)
 * @param held    bundle names the broker currently holds (silent reads)
 * @param opts.minReads minimum prompting reads to surface a bundle (default 3)
 */
export function frequentlyPromptedBundles(
  records: SecretGetRecord[],
  held: Set<string>,
  opts: { minReads?: number } = {},
): PromptedBundle[] {
  const minReads = opts.minReads ?? 3;
  const counts = new Map<string, number>();
  for (const r of records) {
    if (!r.bundle) continue;
    // A broker hit or a durable-session read raised no Touch ID sheet — only a
    // read that fell through to the keychain did. Count those; they are the ones
    // an unlock would silence.
    if (r.source === 'agent' || r.source === 'session') continue;
    if (held.has(r.bundle)) continue;
    counts.set(r.bundle, (counts.get(r.bundle) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= minReads)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
