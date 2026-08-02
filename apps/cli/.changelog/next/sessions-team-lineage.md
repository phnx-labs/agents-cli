- **`agents sessions` now shows which orchestrator spawned each team.** A teams
  teammate row was keyed off its orchestrator's session id (captured from
  `AGENTS_SESSION_ID` at spawn), which both hid the lineage and mislabeled the
  teammate with the orchestrator's id/topic. The teammate now keys off its own
  transcript, exposes the orchestrator as `orchestratorSessionId` (+ a resolved
  `orchestratorLabel`) in `--active --json`, and the listing renders
  `<team> · by <orchestrator>` so "which session spun up this team" is answerable
  at a glance. Source: `apps/cli/src/lib/session/active.ts`,
  `apps/cli/src/commands/sessions.ts`.
