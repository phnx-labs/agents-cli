- **Session tab titles no longer go missing or stale.** A rescan that carried an
  empty or whitespace-only label used to clobber a good stored label, because
  `upsertSession`/`upsertSessionsBatch` wrote `label = excluded.label`
  unconditionally on conflict. The `ON CONFLICT` clause now preserves an existing
  non-empty label and only overwrites when a real label arrives, so a `/rename`,
  agent-generated title, or `--name` handle survives later rescans. Headless runs
  launched with `--name` now also surface that name as the session label (matching
  the terminal path) instead of showing only the topic. Source:
  `apps/cli/src/lib/session/db.ts`, `apps/cli/src/lib/session/active.ts`.
