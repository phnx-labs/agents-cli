- **Branded, actionable daemon notifications on the routine lifecycle (RUSH-2030).**
  Daemon desktop notifications (overdue routines, config heal, the no-credential
  warning) now route through the `MenubarHelper.app` companion instead of raw
  AppleScript, so they carry the agents-cli mark rather than the generic Script
  Editor icon; they degrade to `osascript`/`notify-send` only when the helper is
  not installed. The daemon also notifies when a routine **starts** and
  **finishes** (success/failure, with the report's first line or the error reason
  folded in), suppressing command-housekeeping start/success pings to avoid spam.
  Clicking a finish notification opens the run report/log; start/overdue open the
  runs folder. Source: `apps/cli/src/lib/menubar/notify-desktop.ts`,
  `apps/cli/src/lib/routine-notify.ts`, `apps/cli/src/lib/daemon.ts`,
  `apps/cli/menubar/Sources/MenubarHelper/PromptPanel.swift`.
