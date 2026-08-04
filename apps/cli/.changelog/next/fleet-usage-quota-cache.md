- **`agents run` no longer stalls on a live usage fetch, and the daemon keeps the
  quota cache warm instead (RUSH-2061).** The router's candidate collection
  (`collectRunCandidates`) used to block on a live provider HTTP read whenever an
  account's usage snapshot was older than 5 minutes — one round trip per account
  added to cold-start. It now reads the usage cache **cache-only** (`readOnly`) and
  never touches the network; an unconfirmable snapshot is simply routed around by
  the existing freshness guard (`isUsageVerified`). A new daemon refresher
  (`runUsageRefresh`) keeps that cache fresh in the background: it refreshes only
  accounts signed in on THIS host (sole-writer, no cross-host coordination), on an
  adaptive cadence from each account's session-window burn rate (90s when racing
  toward the 5h cap, up to 15min when idle), capped at ~6 provider calls per
  account per hour and skipped entirely while a provider is under a 429 backoff.
  Source: `apps/cli/src/lib/usage.ts`, `apps/cli/src/lib/usage-refresh.ts`,
  `apps/cli/src/lib/rotate.ts`, `apps/cli/src/lib/daemon.ts`.

- **Balanced routing now deprioritizes an account projected to cap soon, not just
  one already maxed (RUSH-2061).** `deriveUsageHeadroom` projects minutes-to-limit
  from the session-window burn rate; balanced weighting scales an account's
  headroom weight down as that projection shortens (`capacityWeight`), so a launch
  avoids an account racing toward its 5-hour cap instead of only skipping a
  100%-maxed one. Source: `apps/cli/src/lib/usage.ts`, `apps/cli/src/lib/rotate.ts`.

- **The daemon no longer SSH-probes the whole fleet every 3 minutes — fleet status
  is publish-own / read-union now (RUSH-2061, RUSH-2114).** The daemon's fleet-cache
  warm force-probed every registered device over ssh on every tick; with N daemons
  each probing N devices that was N² remote resource probes across the fleet every
  3 minutes, and the source of the orphaned fleet-doctor probe pile-up. Each daemon
  now probes only **itself** (no ssh) and publishes its own row — resource stats
  **plus live-agent workload** (running-agent count and a per-context / per-agent
  breakdown) — to a shared local mirror (`~/.agents/.cache/.fleet-status.json`).
  Cross-host rows are unioned on demand by the reader: `agents devices status`
  gathers peers cache-first, ssh-reading a stale/missing peer via
  `agents devices status --local --json` through a bounded, kill-on-timeout
  fan-out. `agents devices status` (and `--json`) now shows how many agents are
  running on each box. Source: `apps/cli/src/lib/fleet-status.ts`,
  `apps/cli/src/lib/fleet-cache.ts`, `apps/cli/src/lib/daemon.ts`,
  `apps/cli/src/lib/devices/health-report.ts`, `apps/cli/src/commands/ssh.ts`.

- **`agents doctor --json` is no longer a ~136-second stall (RUSH-2136).** The
  overview probed every host-CLI manifest with a blocking `spawnSync` (10s timeout
  each) one after another, so a dozen-plus slow checks summed into minutes. The
  checks now run concurrently (`listCliStatusAsync`), so total time is the slowest
  single check, not their sum; the per-check 10s kill-on-timeout is preserved.
  Source: `apps/cli/src/lib/cli-resources.ts`, `apps/cli/src/commands/doctor.ts`.
