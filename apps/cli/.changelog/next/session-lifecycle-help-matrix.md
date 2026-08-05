- **`agents sessions --help` and `05-sessions.md` now teach one session-lifecycle
  matrix.** `focus` / `focus --attach-only` / `detach` / `attach` / `resume` are
  listed as distinct intents (not synonyms), so operators stop guessing among
  `go` / `focus` / `attach` / `resume`. Source: `apps/cli/src/commands/sessions.ts`,
  `apps/cli/src/commands/focus.ts`, `apps/cli/docs/05-sessions.md`.
