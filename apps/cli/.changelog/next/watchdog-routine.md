- **The always-on watchdog is now a daemon-fired routine, not a hand-rolled loop + sentinel.**
  `agents watchdog enable` used to flip a private `~/.agents/.cache/state/watchdog/enabled`
  sentinel that only meant anything to a manually-launched `agents watchdog --watch` loop —
  so the auto-nudge only ran while some shell was babysitting it. It now creates and enables a
  plain `watchdog` command routine (`agents watchdog --nudge`, every 2 minutes) and reloads
  the daemon, so the always-on watchdog is fired by the same scheduler that runs every other
  routine: it survives reboots, catches up if the daemon was down, and shows up in
  `agents routines list`. `disable` pauses that routine; `status` reports whether it is
  enabled. The Swift menu-bar toggle and `watchdog status --json` are unchanged. Bare
  `agents watchdog` (dry) and `agents watchdog --watch` (now dry unless `--nudge`) still work
  for ad-hoc runs. Source: `apps/cli/src/lib/watchdog/routine.ts`,
  `apps/cli/src/commands/watchdog.ts`.
