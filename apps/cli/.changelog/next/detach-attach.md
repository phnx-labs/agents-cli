- **`agents detach` / `agents attach` — send a running agent to the background and
  back.** `agents detach <id>` stops a live session's interactive process (killing
  the tmux session when tmux-hosted, else SIGTERM'ing the pid) and continues it
  **headless**, detached, via the existing version-pinned `agents run --resume`
  path — so it drives its task to completion without holding a terminal. The
  resumed run carries a nudge that tells the now-unwatched agent it is headless and
  to make the call rather than stall on a confirmation nobody can answer.
  `agents attach <id>` stops that headless continuation and **resumes the session
  interactively** in the current terminal (`resumeSessionInPlace`) — the same
  session and full history, including whatever the background run did. Both verbs
  are agent-agnostic (native resume for Claude/Codex, `/continue` replay for the
  rest). `agents sessions --active --json` now carries a `presence` field
  (`attached` / `background` / `parked`), folded onto every row from a per-session
  detach record, so the menu bar and Factory show where each agent is. Source:
  `apps/cli/src/commands/detach.ts`, `apps/cli/src/commands/attach.ts`,
  `apps/cli/src/lib/session/detached.ts`.
