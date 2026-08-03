- **Per-device and fleet-wide config keys now have a home: the `config:` block in
  the two-tier agents.yaml store.** Three new subcommands under `agents devices`
  (no new top-level noun): `agents devices set-interactive <name>` records the one
  device agents show YOU artifacts on (browser opens, dashboards) as
  `config.interactiveHost` in the central, synced agents.yaml — skills no longer
  guess "the online macOS box", and the host is marked `★ interactive` in
  `agents devices list`. `agents devices configure <name> --max-agents N
  --scheduler on|off` and `agents devices note <name> "…"` (repeat
  to append, `--clear` to empty) write device-scope keys under `config:` in
  `~/.agents/devices/<name>/agents.yaml` — targetable for any device from any box
  (the devices/ tree syncs; each machine reads only its own). The default browser
  profile joins the same registry as `browser.profile`, routed to the existing
  device-local `defaultBrowserProfile` field (no duplicate key, resolution order
  unchanged). Unset keys always mean today's behavior; everything is scriptable
  with `--json`, and `devices list --json` now carries each row's `config` and an
  `interactive` flag. agents.yaml files the CLI writes now carry a
  `yaml-language-server` hint pointing at the new
  `apps/cli/schema/agents-yaml.schema.json`.

  The keys are live inputs, not just stored values. `--scheduler off` stops the
  routines scheduler from starting on that device — `routines add` skips the
  auto-start with the reason, a manual `routines start` refuses, and the daemon
  re-evaluates the gate on every SIGHUP reload (boot it again with
  `agents devices configure <host> --scheduler on` + any reload, no daemon
  restart). `--max-agents` feeds host ranking: Factory auto-launch excludes a
  device at its cap (counting device-wide running agents) and names the cap when
  a pool is exhausted; teams placement excludes it from the least-loaded
  auto-pick (counting the team's own roster, local teammates included) and an
  all-capped pool fails loud instead of over-filling a machine. Setup asks
  instead of guessing: bare `agents setup` ends with a skippable preferences
  step (which machine you sit at → interactive host; which browser agents drive
  here → device default), `agents setup fleet` offers the interactive host after
  a sync, and the `agents setup browser` picker highlights the auto-detect
  winner. Source: `apps/cli/src/lib/device-config.ts`,
  `apps/cli/src/lib/state.ts`, `apps/cli/src/lib/daemon.ts`,
  `apps/cli/src/lib/teams/scheduler.ts`, `apps/cli/src/commands/ssh.ts`,
  `apps/cli/src/commands/setup-preferences.ts`,
  `apps/factory/src/core/launchHost.ts`,
  `apps/cli/schema/agents-yaml.schema.json`.
