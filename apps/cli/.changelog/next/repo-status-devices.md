- **`agents repo status` reports across the fleet.** New `--devices-all` (alias
  `--hosts-all`) fans `repo status`/`repo list` out to every reachable device and
  renders one aggregated table (device · repo · sync · changes); `--devices <who>`
  (alias `--hosts`) takes `all` or a comma-separated device list. Unreachable peers
  are skipped with a clear marker, never failing the command, and a single
  `--device`/`--host` still streams that one box as before. Source:
  `apps/cli/src/commands/repo.ts`.
