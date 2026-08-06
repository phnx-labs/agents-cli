- **Use one three-minute AGI Menu snapshot and one watchdog executor (RUSH-2260).**
  The menu bar now reads routines, 40 indexed recent sessions, the daemon-warmed
  active-session cache, and persisted watchdog state in one subprocess every three
  minutes; `doctor --json` remains independently limited to 15 minutes. The menu no
  longer executes watchdog ticks. The daemon is the sole automatic watchdog executor,
  warms active sessions on the same three-minute cadence, is gated by device-local
  `watchdog.enabled`, and cleans failed/timeout routine process groups that are still
  alive before they can overlap a replacement run. Source:
  `apps/cli/src/lib/menubar/snapshot.ts`, `apps/cli/src/lib/daemon.ts`,
  `apps/cli/src/lib/routine-process-cleanup.ts`.
