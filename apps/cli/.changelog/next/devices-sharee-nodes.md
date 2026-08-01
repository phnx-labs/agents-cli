- **`agents devices sync` no longer auto-registers tailnet nodes another user
  shared into the tailnet.** `tailscale status` includes ShareeNode peers (for
  example a tagged relay shared in by a teammate); the parser ignored that flag,
  so bootstrap registered them as your own boxes and they surfaced in `agents
  fleet ls`. Parsing now carries a `sharee` flag, `runDeviceSync` filters those
  peers out of auto-registration and suggestions, and the interactive picker
  leaves them unchecked (labeled `shared`). Deliberate paths — `devices
  register`/`add` and a `fleet:` manifest — still reach shared nodes when you name
  them. Source: `apps/cli/src/lib/devices/sync.ts`,
  `apps/cli/src/lib/devices/tailscale.ts`.
