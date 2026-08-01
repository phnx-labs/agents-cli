- **`sessions --active` now stamps a start and last-activity time on every
  interactive session.** Terminal, tmux, and headless agents discovered by the
  process scan carried no `startedAtMs` — so the Factory Floor rendered every
  running agent as "0s ago" even when its transcript, topic, and progress had
  resolved. The scan now stamps `startedAtMs` (the SessionStart hook's own
  timestamp, else the transcript's creation time) and a new `lastActivityMs` (the
  transcript's last-write) on each row, and the Floor renders "Xs ago" off the
  real last-activity instead of the session's age. Source:
  `apps/cli/src/lib/session/active.ts`, `apps/cli/src/lib/session/hook-sessions.ts`.
