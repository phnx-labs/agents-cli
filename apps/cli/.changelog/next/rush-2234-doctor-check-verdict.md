- **`agents doctor --check` verdict lines now carry a `check:` prefix and a total
  version count**, so CI logs and log-scrapers get one consistent, grep-alike shape
  whether the result is clean or drifted: `check: ok — 3 version(s) in sync` /
  `check: drift — 2 stale, 1 never-synced across 3 version(s)`. The per-version
  status badge for a never-synced version now reads `never-synced` (its real
  status) instead of the unrelated `cold` label, and all three badges
  (`stale`/`never-synced`/`unwired`) share one fixed-width column so the rows
  align. Source: `apps/cli/src/commands/doctor.ts` (`runCheckGate`).
