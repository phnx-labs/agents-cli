- **Isolated installs now resume sessions and resolve `@default` like any other install.**
  Two places still assumed a managed version is reachable on PATH — which an isolated
  install deliberately is not. (1) `agents sessions` resume looked up
  `<cli>@<version>` with a plain PATH lookup, never found it (the shims dir is
  intentionally off PATH under `--isolated`), concluded the version was uninstalled, and
  fell back to spawning `<cli> "/continue <id>"` — a slash command neither CLI has, so
  the session simply never resumed. It now resolves the versioned alias by absolute path,
  the way `agents run` already did, and the fallback is the agent's real resume verb
  against the current version rather than `/continue`. (2) The agent-spec resolver behind
  `--agents` / `@default` / `@pinned` read only the global default, so an isolated-only
  agent threw "No default version set" even after an explicit `agents use` —
  `resolveVersion` had gained the isolated-default fallback but this resolver had not.
  Both now consult it, and report `isolated-default` as the source rather than claiming a
  global default. `opencode` resume stays deliberately un-pinned, since its sessions are
  shared across versions. Source: `apps/cli/src/commands/sessions.ts`,
  `apps/cli/src/lib/agent-spec/`.
