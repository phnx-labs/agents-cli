- **`agents sessions` now heals any pre-existing empty-`shortId` rows on upgrade.**
  The prior fix stopped *producing* empty shortIds (bare-prefix ids like a `session_`
  directory stripped to `''`), but a row already poisoned in the index did not
  self-heal — an empty shortId is not re-parsed unless its transcript changes, and an
  orphaned row whose file is gone never re-parses at all, so it stayed unaddressable in
  the `short_id LIKE ?` picker lookups. A one-time schema migration (v16) repairs every
  such row in place (`short_id = substr(id, 1, 8)`), so upgrading users get a clean
  index without a full rescan. Source: `apps/cli/src/lib/session/db.ts`.
