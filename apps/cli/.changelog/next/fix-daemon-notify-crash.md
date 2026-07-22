- **The daemon no longer crash-loops on headless Linux when a routine is overdue.**
  On an overdue routine the daemon fires a best-effort desktop notification via
  `notify-send` (Linux) / `osascript` (macOS). A missing notifier binary — the
  default on a headless box without `libnotify-bin` — surfaces as an asynchronous
  `spawn` `'error'` event, not the synchronous throw the surrounding `try/catch`
  expected, so Node re-threw it as an uncaught exception and killed the daemon.
  systemd then restart-looped it every ~10s, which also tore down the browser IPC
  socket (`agents browser start` failed with "Timeout waiting for browser daemon
  socket"). Both notifier spawns now carry an `'error'` listener so the failure is
  swallowed as the "best-effort" contract already promised. Source:
  `apps/cli/src/lib/overdue.ts`, `apps/cli/src/lib/overdue.test.ts`.
