- **`agents cloud run --json` now emits machine-readable failures.** `die()` — the
  shared fatal-exit path — always wrote red text to stderr and left stdout empty,
  so an agent parsing `--json` output saw nothing plus a bare nonzero exit with no
  reason. `die()` gains an optional `{ json, hint }` and, in json mode, prints
  `{"error", "hint"?}` to stdout; a pure `formatDie()` makes the human/agent split
  unit-testable. Every failure path in `cloud run` now threads the resolved
  `--json` flag. Source: `apps/cli/src/lib/format.ts`, `apps/cli/src/commands/cloud.ts`.
  (RUSH-1830)
