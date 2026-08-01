- **`agents repo pull` now reloads the routines daemon so device pins refresh.**
  The scheduler froze each routine's config — device pins included — in memory at
  daemon start. A `repo pull` rewrites the synced routine YAML on disk (a routine
  re-pinned to another host, say), but without a reload the daemon kept firing the
  pre-pull pins, so a routine moved to another device still fired on the old host
  too — a phantom double-fire across the fleet. A successful pull now SIGHUPs the
  running daemon (`scheduler.reloadAll()`), re-reading the YAML so pins refresh. A
  no-op when the daemon isn't running or on Windows (no SIGHUP). Source:
  `apps/cli/src/commands/repo.ts`.
