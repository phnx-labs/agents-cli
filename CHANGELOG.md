# Changelog

## Unreleased

## 1.20.55

### Added

- **Heartbeat watchdog** — the daemon writes a heartbeat (timestamp + pid) every
  monitor tick; `agents routines status` now distinguishes `running` / `wedged` /
  `stopped`. A wedged daemon (pid alive but heartbeat stale >3 ticks) is reported
  with a restart hint. (RUSH-1670)

- **Opportunistic orphan reaper** — `agents routines list` and `status` now call
  `monitorRunningJobs()` on entry (best-effort, swallowed errors), so orphaned
  `running` records finalize even when the daemon is down. (RUSH-1671)

- **Pid-reuse-safe reaper + max wall-clock** — `monitorRunningJobs()` records
  `spawnedAt` (epoch ms) at spawn and verifies process identity via `ps` before
  treating a pid as alive, preventing recycled-pid false positives. Runs exceeding
  24 hours are finalized as `timeout` regardless of pid state. (RUSH-1672)

- **Daemon binary path guard** — `getDaemonLaunch()` rejects `/$bunfs/root/…`
  (bun virtual filesystem) paths with a hard error and warns when the resolved
  binary sits inside `.agents/worktrees/`. `agents routines status` now prints the
  resolved daemon binary path. (RUSH-1673)
