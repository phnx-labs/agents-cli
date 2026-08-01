- **`agents sessions migrate` (alias `relocate`) relocates a RUNNING session onto
  another machine, then stops the source here (RUSH-1977).** `--auto` scores the
  fleet and picks a target, `--host <name>` names one explicitly, and `--lease`
  provisions a fresh ephemeral box; `--mode resume|rehydrate` chooses whether the
  target resumes the native transcript or replays it via `/continue`. Every
  migration is written to an append-only ledger, viewable with `agents sessions
  migrations`. Load-bearing invariant: the source session is never stopped until
  the transcript is confirmed live on the target, so a failed hop leaves the
  original running. (Not to be confused with `agents sessions detach`/`attach`,
  the unrelated background/foreground pair.) Source:
  `apps/cli/src/commands/sessions-migrate.ts`,
  `apps/cli/src/lib/session/migrate-targets.ts`,
  `apps/cli/src/lib/session/migrations.ts`.
