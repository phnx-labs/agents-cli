- **Honest live status: report `unknown` instead of a fake `idle` (RUSH-1976).** `agents
  sessions --active` now reports an explicit `unknown` status (`◌`) for a live agent whose
  activity it cannot introspect — a running gemini/droid/cursor/opencode whose transcript
  format is not parsed — instead of the misleading `idle` it showed before. Status resolution
  is standardized in one place (`resolveFallbackStatus`): a vanished transcript file no longer
  flips to a false `running`, an unanswered prose question with no mtime signal no longer
  sticks as "waiting on you" forever (the RUSH-1522 null-mtime hole), and the `ps`/`lsof`
  probes behind the scan now have hard timeouts so a hung syscall can't silently drop live
  sessions. Source: `apps/cli/src/lib/session/active.ts` (`resolveFallbackStatus`),
  `apps/cli/src/lib/session/state.ts`, `apps/cli/src/commands/sessions.ts`.
