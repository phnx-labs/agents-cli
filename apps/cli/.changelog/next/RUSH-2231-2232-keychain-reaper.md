- **A wedged keychain can no longer pile up `agents` processes (RUSH-2231, RUSH-2232).**
  A stalled macOS `coreauthd` used to hang the signed keychain helper's XPC receive
  forever, so every secrets-touching `agents` command blocked and dozens of helper
  processes plus their `<defunct>` zombies accumulated and made the machine sluggish.
  Two fixes: **(Layer 1)** every keychain-helper `spawnSync` is now bounded and
  hard-killed (SIGKILL) on timeout — 8s for never-prompt verbs (`has`/`set`/`delete`/
  `list*`), 60s for the may-prompt reads (`get`/`get-batch`/`migrate-*`) — surfacing a
  typed timeout error and arming the read back-off instead of hanging.
  **(Layer 3)** the daemon reaps the backlog: a 5-minute tick kills orphaned helpers
  (reparented to PID 1, past a 30s grace) and, two-sweep-debounced, the helper child of
  an `agents` proc stuck past 90s (child first, escalating to the parent only if it
  stays wedged) — never touching a process whose start-time can't be captured or whose
  path doesn't match the helper. Any keychain touch now also opportunistically starts
  the daemon so the reaper runs even on a secrets-only box. Source:
  `apps/cli/src/lib/secrets/index.ts`, `apps/cli/src/lib/secrets/reaper.ts`,
  `apps/cli/src/lib/daemon.ts`.
