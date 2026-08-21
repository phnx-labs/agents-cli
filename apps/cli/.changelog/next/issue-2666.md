- **`agents devices list` no longer serves fossilized load/mem numbers (#2666).** The
  fleet stats cache (`.fleet-stats.json`) had no age bound and — since RUSH-2061
  removed the daemon's N² fleet warm — no background writer, so the load/mem columns
  froze at the last manual `--refresh` and re-rendered as current fleet state
  indefinitely (observed: a 9-day-old row reporting an idle Mac at 1058% load). Cached
  rows are now bounded by `STATS_STALE_MS` (3 minutes, the same window as the
  agent-count mirror): a row past the bound is treated like a missing one — re-probed
  live this call and rewritten — so the default `devices list` / `devices status` read
  is itself the cache's writer and a stale value can never be presented as current.
  This cache feeds the fleet scheduler, `--device auto` affinity, and the
  session-start fleet banner. Source: `apps/cli/src/lib/devices/stats-cache.ts`,
  `apps/cli/src/commands/ssh.ts`.
