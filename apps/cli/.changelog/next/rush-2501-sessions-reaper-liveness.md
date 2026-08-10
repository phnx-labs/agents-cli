- **Dead tmux sessions are now reaped automatically every 5 minutes.** Sessions
  stay open after their process exits because `remain-on-exit on` is set so the
  harness can inspect the exit status. Previously they accumulated indefinitely —
  127 tmux sessions with 48 dead (~38%) observed on a production fleet machine.
  The daemon now cleans them up on a 5-minute timer (same cadence as the keychain
  reaper) and immediately on startup to clear the backlog. Safety invariant: only
  sessions where **all** panes are dead (`pane_dead=1`) are killed; any session
  with a live pane is never touched. On-demand cleanup is also available:
  `agents sessions reap [--json] [--socket <path>]`. Source: `apps/cli/src/lib/tmux/session.ts`, `apps/cli/src/lib/daemon.ts`, `apps/cli/src/commands/sessions-reap.ts`.

- **`agents sessions --active` now attributes cursor/grok/kimi/droid sessions.**
  The ps-scan identity path fell back to `loadHookSessionIndex()`, which scans
  `terminals/sessions/` — a directory populated only by the `@agents/session-tracker`
  package, which is not deployed on most fleet machines. The SessionStart hook that
  IS deployed writes `state/sessions/<pid>.json` instead. The ps-scan path now also
  tries `readStateSessionRecord(pid)` after the index lookup finds nothing, so
  non-Claude harnesses that carry no `--session-id` argv can be attributed from the
  deployed hook's state file. Source: `apps/cli/src/lib/session/active.ts`.

