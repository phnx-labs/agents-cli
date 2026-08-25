/**
 * Canonical derivation of a session's 8-char `shortId`.
 *
 * Every session parser used to inline `id.slice(0, 8)` — some with a
 * `.replace(prefix, '')` strip first (`session_`, `api-`, `ses_`). That strip is
 * the bug: an id that is *only* its prefix (a bare `session_` directory, an id of
 * exactly `api-`) strips to `''`, and `''.slice(0, 8)` is still `''`. An empty
 * shortId then passes the `short_id TEXT NOT NULL` constraint (empty string is not
 * NULL) yet matches nothing in the `short_id LIKE ?` picker lookups — a silently
 * corrupt index row.
 *
 * This helper is the single source of truth: it strips the optional prefix, takes
 * the first 8 chars, and — the whole point — guarantees a NON-EMPTY result by
 * falling back to the unstripped id when the strip empties it, so a row always
 * stays addressable by its shortId.
 */
export function deriveShortId(id: string, stripPrefix?: RegExp): string {
  const stripped = stripPrefix ? id.replace(stripPrefix, '') : id;
  return stripped.slice(0, 8) || id.slice(0, 8) || id;
}
