- **Unknown / typo'd top-level commands no longer load every command module (RUSH-2329).**
  A misspelled name used to call `registerAllEagerCommands` (and the lazy
  sessions/teams/cloud tree) solely to build the "did you mean" candidate list —
  ~250–330ms of dynamic import on cold start. Spellcheck now walks the
  plain-string `KNOWN_TOP_LEVEL_COMMANDS` set (same first-seen order for
  tie-breaks) and registers only the auto-corrected command before reparse.
  Distance-1 auto-correct and `--host` re-routing after correction are
  unchanged. Source: `apps/cli/src/index.ts`, `apps/cli/src/lib/startup/spellcheck.ts`.
