- **`agents sessions` indexes again from the standalone binary.** Every session
  write went through a named-parameter bind (`INSERT ... VALUES (@id, @short_id,
  ...)` in `apps/cli/src/lib/session/db.ts`), and `bun:sqlite` matches such an
  object only when its keys carry the SQL sigil — bare keys bound nothing, so all
  columns landed NULL and `sessions.short_id` (NOT NULL) rejected the row. The
  shims exec the Bun-compiled `dist/bin/agents`, so no session reached the index
  from the CLI: `agents sessions` printed `Warning: skipped unindexable session
  <id>: NOT NULL constraint failed: sessions.short_id` per session and then
  listed only rows indexed earlier by the Node entrypoint. The suite runs under
  Node (vitest), where `node:sqlite` accepts bare keys, which is why CI stayed
  green. `apps/cli/src/lib/sqlite.ts` now opens the DB with `strict: true` under
  Bun so both runtimes take the same bind shape, and `sqlite.test.ts` exercises
  the named bind in a real `bun` subprocess.
