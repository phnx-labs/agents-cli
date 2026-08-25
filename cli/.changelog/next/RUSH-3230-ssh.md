- **Split `ssh.device-config.test.ts`, the second-slowest file (RUSH-3230).** 18 subprocess
  tests in one file at ~44s locally (151s on a loaded worker) — 8.4s *per test*. Now three
  files along its existing `describe` boundaries (per-device config / fleet-wide defaults +
  role + describe / retired-subcommand tombstones) over a shared
  `device-config-test-harness.ts`: **45s → 19s wall, all 18 tests still passing**, none
  changed, skipped, or dropped. Source: `cli/src/commands/device-config-test-harness.ts`.
