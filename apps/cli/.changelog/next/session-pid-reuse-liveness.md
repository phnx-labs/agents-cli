- **`agents sessions --active` no longer shows zombie sessions from recycled pids.**
  Liveness was a bare `process.kill(pid, 0)` existence check, so once the OS handed a
  dead session's pid to an unrelated process, that session kept showing as alive — and
  the registry GC never pruned it. `isPidAlive` now takes the session's recorded
  `startedAtMs` and, when a start time is available, verifies the process at that pid did
  not begin meaningfully after the session started (a 60s window): a process that started
  later is a reused pid, so the session is dead. The start time is read once via
  `ps -o lstart=` (macOS + Linux); Windows and any unreadable start time fall back to the
  existence check, never worse than before. Applied to every registry-backed liveness
  path — the live-terminals filter, the terminal listing, the tmux-pane resolver, and the
  pid-registry prune. Source: `apps/cli/src/lib/session/active.ts`.
