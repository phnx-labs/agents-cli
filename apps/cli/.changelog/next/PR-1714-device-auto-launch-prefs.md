- **`agents devices enable|disable|prefer|unprefer <name>` control which machines
  Factory auto-launches onto.** A *disabled* device is skipped by
  `New <Agent>` and the balanced launch, but stays available through
  `New <Agent> (Pick Host)`. A *preferred* device wins ties against otherwise
  equivalent machines — worth about two running agents in the ranking, so a
  preference never sends work to a box that is genuinely swamped. Every device
  is enabled and unpreferred by default, and an unregistered name is now
  rejected instead of writing a preference that matches nothing. Preferences
  live in `~/.agents/.history/devices/auto-launch.json`, written by the CLI and
  read by the extension. Source: `apps/cli/src/lib/devices/registry.ts`,
  `apps/cli/src/commands/ssh.ts`, `apps/factory/src/core/deviceAutoLaunch.ts`,
  `apps/factory/src/core/launchHost.ts`.
