- **Remove the unused `agents hq` command.** `agents hq floor --json` was a
  machine-readable bridge for an interactive Agents HQ floor UI that was never
  built — `apps/factory` has zero references to it and it had no other consumer.
  Typing `agents hq` now prints a clear removal notice and exits non-zero instead
  of silently disappearing. Source: `apps/cli/src/index.ts`,
  `apps/cli/src/lib/startup/command-registry.ts` (removed
  `apps/cli/src/commands/hq.ts`, `apps/cli/src/lib/hq/`).
