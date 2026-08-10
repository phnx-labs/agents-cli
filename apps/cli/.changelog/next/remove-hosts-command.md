- **Removed the top-level `agents hosts` command group.** `agents devices` is now
  the sole user-facing fleet registry. The registry subcommands map to devices:
  `agents hosts list|add|remove` → `agents devices list|add|rm`. The per-host
  `agents hosts check <name>` probe has no standalone replacement — fleet health
  is `agents devices status` (a rollup over every registered device, no per-host
  argument), and the per-host readiness probe still runs internally via
  `ensureHostReady` at dispatch time. The
  two dispatched-task commands with no devices equivalent moved under devices:
  `agents hosts ps` → `agents devices ps` (list tasks dispatched with
  `agents run --device <name> --no-follow`; reconciles running records; `--json`),
  and `agents hosts stop <id>` → `agents devices stop <id>` (alias `kill`).
  `agents hosts logs <id>` is dropped because `agents logs <id>` already views and
  follows host-dispatch task logs. The dispatch fabric is unchanged: `agents run
  --host/--device`, teams remote, and cloud `--provider host` all still work.
  Source: `apps/cli/src/commands/ssh.ts`, `apps/cli/src/lib/startup/command-registry.ts`.
