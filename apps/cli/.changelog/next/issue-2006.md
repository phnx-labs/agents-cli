- **`agents humans show owner [--json]`** — new command to display the owner config from `~/.agents/humans.yaml`. The file is written automatically on first run when `notify.owner` exists in `agents.yaml`. Source: `apps/cli/src/lib/humans.ts`, `apps/cli/src/commands/humans.ts`.

- **`humans.yaml` — typed, versioned owner config.** `~/.agents/humans.yaml` (`version: 1`) now stores owner identity (name, timezone, quiet hours, severity), notification channels, and escalation policy. `notify.owner` in `agents.yaml` is migrated into it on first run and the `notify.owner` key is removed from `agents.yaml`; unrelated keys are preserved. `agents send --to owner` / `agents notify` prefer `humans.yaml` with a fallback to `agents.yaml` during the migration window. Source: `apps/cli/src/lib/humans.ts`, `apps/cli/src/commands/humans.ts`, `apps/cli/src/lib/migrate.ts`.

- **`agents memory` ignores `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and `MEMORY.md`.** These rule/index files lived in `~/.agents/memory/` but were incorrectly surfaced as memory facts. `isFactFile()` now excludes them by name (case-insensitive). Source: `apps/cli/src/lib/memory.ts`.

- **Permissions write path fixed — `groups/` subdirectory.** `installPermissionSet`, `removePermissionSet`, and `savePermissionSet` now all write to the `groups/` subdirectory (matching `discoverPermissionGroups()` which already reads from `groups/`). Source: `apps/cli/src/lib/permissions.ts`.

- **Stop eagerly creating webhooks directories.** `ensureAgentsDir()` no longer creates `~/.agents/webhooks/` or `~/.agents/.system/webhooks/` on startup — both dirs are created on first actual use. Source: `apps/cli/src/lib/state.ts`.

- **Terminals canonically under `.cache/`.** The stale migration comment that blocked `terminals/` from moving to `~/.agents/.cache/terminals/` is replaced by the actual move. Factory already writes to `.cache/terminals/` (`foreman.registry.ts:9`), so no app-level change is needed. Source: `apps/cli/src/lib/migrate.ts`.
