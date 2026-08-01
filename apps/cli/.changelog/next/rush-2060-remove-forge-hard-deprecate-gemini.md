- **Remove Forge and hard-deprecate Gemini (RUSH-2060).** ForgeCode is no longer
  an `AgentId`, install target, resource-sync target, subagent target, MCP target,
  or permissions target. Gemini remains a legacy id so existing sessions/config can
  still be read, but it is no longer a managed harness: `agents add gemini`,
  `agents import gemini`, and `agents sync gemini` now fail and point users to
  Antigravity. Gemini is also excluded from capability-driven resource writers,
  staleness detectors, import choices, teams choices, model choices, fleet auth
  sync, and plugin/MCP/permissions/subagent sync. Source:
  `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/types.ts`,
  `apps/cli/src/lib/capabilities.ts`, `apps/cli/src/commands/{versions,import,sync}.ts`,
  and the resource writers under `apps/cli/src/lib/`.
  (RUSH-2060)
