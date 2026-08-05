- **`agents snapshot` — one-process poll for inventory + active sessions (Phase 4 surface consolidation).**
  Consumers (Factory, scripts, menubar) were forking `view --json` × N harnesses plus
  `sessions --active --json` (and sometimes feed) on every tick. `agents snapshot --json`
  returns the same shapes in one invocation: `inventory` (view), `sessions` (active rows),
  optional `--with-feed` / `--with-sync`. Default sessions scope is this machine; `--all-hosts`
  matches full `sessions --active` fan-out. Does **not** redefine `agents status`, which stays
  the UnifiedSyncStatus sync contract. Source: `apps/cli/src/commands/snapshot.ts`,
  `apps/cli/src/lib/snapshot.ts`.
