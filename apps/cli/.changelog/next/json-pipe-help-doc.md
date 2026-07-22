- **`--json` help text now notes that piping stdout also forces JSON.** For commands
  that resolve output mode via `isJsonMode()` (teams, cloud), machine-readable JSON is
  emitted whenever `--json` is passed **or** stdout is not a TTY — the help strings now
  say so, so the pipe-triggers-JSON behavior is discoverable. Source:
  `apps/cli/src/commands/teams.ts`, `apps/cli/src/commands/cloud.ts`. (RUSH-1831)
