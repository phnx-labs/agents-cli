- **Wire allowlist support for ForgeCode and Hermes.** Both agents now declare
  `allowlist: true` and canonical permissions are translated into each agent's
  native policy file. For **forge**, `~/.forge/permissions.yaml` (or
  `$FORGE_CONFIG/permissions.yaml`) is written as an ordered `policies` list keyed
  by operation family (`read`/`write`/`command`/`url`) with glob patterns — active
  only when `.forge.toml` sets `restricted = true`, and MCP tools bypass the file,
  so only built-in-tool allow/deny rules are mapped. For **hermes**,
  `~/.hermes/config.yaml` gets `command_allowlist` (always-approved command globs)
  and `approvals.deny` (unconditional blocks) — command-glob only, since Hermes has
  no unified per-tool table. Both writers support merge mode (union + dedupe against
  existing config). Source: `apps/cli/src/lib/permissions.ts`
  (`convertToForgeFormat`, `convertToHermesFormat`), `apps/cli/src/lib/agents.ts`.
