- **Desktop notifications now show the agent on the right, not a second copy of
  the app icon.** macOS draws two images on a banner: the sending app's icon on
  the left and `contentImage` on the right (a YouTube notification uses the slots
  for "YouTube" plus the channel avatar). agents-cli was putting its own lime mark
  in the right slot, so both slots said the same thing. The right slot now carries
  the harness the notification is *about* — a brand-colored tile with a two-letter
  mark (`CL` claude, `CX` codex, `GK` grok, …), two letters because four harnesses
  start with `c` and two with `g`. `agents run --notify` and agent/workflow
  routines pass their harness through; a daemon heal, an overdue sweep, a command
  routine, or a fan-out across several agents has no single agent and leaves the
  right slot empty. Source:
  `apps/cli/menubar/Sources/MenubarHelper/AgentAvatar.swift`,
  `apps/cli/src/lib/menubar/notify-desktop.ts`, `apps/cli/src/lib/run-notify.ts`,
  `apps/cli/src/lib/routine-notify.ts`, `apps/cli/docs/menubar.md`.

- **`MenubarHelper --notify` gains `--agent <id>`.** The one-shot notifier accepts
  the harness id that drives the right-hand avatar; omitting it is how a caller
  says "no single agent owns this event".
