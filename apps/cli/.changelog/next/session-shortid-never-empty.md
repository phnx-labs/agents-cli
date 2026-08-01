- **`agents sessions` no longer corrupts the index with empty `shortId` rows.**
  Session ids that are only a known prefix — a bare `session_` Rush directory, an
  id of exactly `api-` (Hermes) or `ses_` (OpenCode) — used to strip to `''`
  (`'session_'.replace(/^session_/, '').slice(0, 8) === ''`). An empty `shortId`
  passes the `short_id TEXT NOT NULL` constraint (empty string is not NULL) yet
  matches nothing in the `short_id LIKE ?` picker lookups, so the row was silently
  unaddressable. All shortId derivation is now routed through one helper,
  `deriveShortId`, that guarantees a non-empty result by falling back to the
  unstripped id when the strip empties it. Every producer — the twelve parsers in
  `discover.ts`, `session/cloud.ts`, `cloud/session-index.ts`, `hosts/session-index.ts`,
  `session/fork.ts`, and `commands/go.ts` — uses it, replacing the duplicated inline
  `.slice(0, 8)` (some with a `.replace(prefix, '')`). Source:
  `apps/cli/src/lib/session/short-id.ts`.
