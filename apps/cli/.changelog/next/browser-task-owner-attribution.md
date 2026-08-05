- **`agents browser` tasks are now attributed to the caller that ran `start`, not
  to the browser daemon.** `Task.owner` (RUSH-2020) was resolved with
  `resolveActor()` *inside* the shared, long-lived browser daemon, so every task —
  no matter which agent or person opened it — was stamped with the identity of
  whoever happened to start the daemon. The caller's identity is now forwarded over
  IPC: the CLI (the caller's own process) puts `actor` (`resolveActor().id`) and
  `launchId` (`$AGENT_LAUNCH_ID`, the per-run id `exec.ts` injects for every harness)
  on the `start` request, and the daemon stamps exactly those. Adds `Task.launchId` —
  which run created a task — the scope a later `browser status --mine` and the
  no-flag current-task default will filter on. Source:
  `apps/cli/src/lib/browser/types.ts`, `apps/cli/src/lib/browser/service.ts`,
  `apps/cli/src/lib/browser/ipc.ts`, `apps/cli/src/commands/browser.ts`.
