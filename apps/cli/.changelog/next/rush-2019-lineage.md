- **`agents sessions` attributes historical sessions to a person, and teams carry
  spawn lineage (RUSH-2019).** Each run now writes a durable `sessionId -> actor`
  sidecar at spawn (`~/.agents/.history/by-session/`, unlike the pruned pid
  registry), and the session scanner joins it while indexing — so the write-once
  `actor` / `initiated_by` columns added in RUSH-2018 populate automatically and the
  durable `agents sessions` listing (not just `--active`) shows who launched each
  session. Teammate spawns inherit the orchestrator's frozen actor and now record a
  `parent_session_id` (the orchestrator's own `AGENTS_SESSION_ID`), so a team traces
  back to the one human who started it and the spawn chain is walkable. Source:
  `apps/cli/src/lib/session/actor-sidecar.ts`, `apps/cli/src/lib/exec.ts`,
  `apps/cli/src/lib/session/db.ts`, `apps/cli/src/lib/teams/agents.ts`.
