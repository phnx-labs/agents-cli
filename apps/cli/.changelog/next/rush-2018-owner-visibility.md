- **`agents sessions --active` shows who launched each run (RUSH-2018).** New
  **owner** column on the active-sessions table (and an `owner` field in
  `--active --json`), sourced from the resolved actor stamped at spawn into the
  per-pid registry and onto each teammate record. Displays the actor's short id
  (an email's local-part) and stays honest — an unresolved local run shows `-`,
  never a guessed box owner. The session index (`sessions.db`) also gains
  write-once `actor` / `initiated_by` columns, kept out of the upsert
  `ON CONFLICT` set so a content rescan never clobbers the original owner.
  Source: `apps/cli/src/lib/session/pid-registry.ts`,
  `apps/cli/src/lib/session/active.ts`, `apps/cli/src/commands/sessions.ts`
  (`ownerLabel`), `apps/cli/src/lib/session/db.ts`, `apps/cli/src/lib/exec.ts`.
