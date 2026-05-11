## Agent Spawning

When asked to spawn agents or perform multi-agent tasks, use the Swarm MCP extension:

- `mcp__Swarm__Spawn` - Spawn agents (codex, cursor, gemini, claude)
- `mcp__Swarm__Status` - Check agent status
- `mcp__Swarm__Read` - Read agent output
- `mcp__Swarm__Stop` - Stop agents

Do NOT use built-in Claude Code agents (Task tool with Explore/Plan subagent_type) when Swarm agents are requested.

# agents-cli

CLI for managing AI coding agent versions, config, sessions, and cloud dispatch (Claude, Codex, Gemini, Cursor, OpenCode, OpenClaw).

## Three DotAgents repos

| Path | Role | Edited by |
|---|---|---|
| `.agents/` (project root) | **Project repo** — project-specific commands, skills, hooks, rules. Scoped to this repo only. | Project maintainers |
| `~/.agents/` | **User repo** — your resources + ALL operational state (versions, shims, sessions, agents.yaml, browser runtime). | You / CLI |
| `~/.agents-system/` | **System repo** — npm-shipped defaults ONLY. Nothing else. | Maintainers |

Resources AND `agents.yaml` resolve **project > user > system** — project-level pins override user/system.

### What lives where

**System repo (`~/.agents-system/`)** — npm-shipped defaults, fully tracked:
```
commands/  hooks/  hooks.yaml  mcp/  permissions/  profiles/  rules/  skills/
```
Clone from `phnx-labs/.agents-system` to see exactly what ships. Nothing else belongs here.

**User repo (`~/.agents/`)** — your resources + all operational state:
- **Your resources:** commands, skills, hooks, rules, mcp, permissions, profiles, subagents
- **Operational state:** `versions/`, `shims/`, `sessions/`, `routines/` (with `runs/` inside), `cache/`, `cloud/`, `teams/`, `browser/`, `.trash/`, `.backups/`, `agents.yaml`
- **Browser:** `browser/profiles/` (YAML configs) + `browser/<profile>/` (runtime: chrome-data, pids)

**No `secrets/` directory anywhere.** Bundle metadata lives in macOS Keychain, not on disk.

These `$HOME`-level directories (plus an optional `.agents/` at project root) are called **DotAgents repos** — they live outside this codebase and are managed by the CLI. Each has a canonical layout: `commands/`, `skills/`, `hooks/`, `rules/`, `mcp/`, `permissions/`, `profiles/`, `subagents/`. The typed items inside are called **resources**. Resolution order is project > user > extra repos > system; same-named resource at a higher layer wins, everything else unions in. See `docs/00-concepts.md` for the full model.

## Source layout

```
src/
  index.ts           # CLI entry (commander.js)
  commands/          # Command implementations
  lib/
    state.ts         # Path constants for both repos; agents.yaml read/write
    resources.ts     # resolveResource() / listResources() — project > user > system
    migrate.ts       # One-shot idempotent migrations (postinstall + command-time)
    agents.ts        # Per-agent capability table
    capabilities.ts  # supports() gate
    versions.ts      # Install, remove, syncResourcesToVersion
    shims.ts         # Shim generation, config symlink switching
    hooks.ts         # Layered hooks.yaml parser + per-agent registrar
    hooks/match.ts   # matches: predicate evaluator
    session/         # Session discovery, parsing, rendering
    cloud/           # Multi-provider cloud dispatch (rush, codex, factory)
    teams/           # `agents teams` orchestration
    profiles.ts      # Host CLI + endpoint + model bundles
```

## Key concepts

- **Version management** — install/switch agent CLI versions (binaries live under `~/.agents/versions/`).
- **Resource sync** — symlink resolved resources into each version's home dir.
- **Layered config** — system repo ships defaults, user repo overrides by name. Hooks and promptcuts both layer this way.
- **Capability gating** — `supports(agent, cap, version?)` decides whether a write is safe; out-of-range versions are skipped silently.
- **Session reading** — unified normalized view across Claude, Codex, Gemini.
- **Cloud dispatch** — provider registry resolves Rush / Codex Cloud / Factory.

## Hook model

`hooks.yaml` is a central manifest, read from system + user (user wins). Each entry has `script`, `events`, optional `timeout`, optional `matches:` predicates, optional `enabled: false` to disable a system-shipped hook from the user side. The `agents:` field is deprecated — the registrar uses the capability table to decide which agents register the hook. Predicates (`prompt_contains`, `prompt_matches`, `tool_name`, `tool_args_match`, `cwd_includes`, `project_has`, `git_dirty`) AND together at fire time.

Promptcuts are hook data, not a top-level resource — `~/.agents-system/hooks/promptcuts.yaml` (defaults) and `~/.agents/hooks/promptcuts.yaml` (user) are merged by the expand-promptcuts script with user precedence.

## Agent config

| Agent | Commands | Memory file |
|-------|----------|-------------|
| Claude | `commands/` (md) | CLAUDE.md |
| Codex | `prompts/` (md) | AGENTS.md |
| Gemini | `commands/` (toml) | GEMINI.md |
| Cursor | `commands/` (md) | .cursorrules |
| OpenCode | `commands/` (md) | OPENCODE.md |

`AGENTS.md` is the canonical source — synced to each agent's expected name.

## Build

```bash
bun install && bun run build && bun test
```

## Detailed design

See `docs/`:
- `00-concepts.md` — DotAgents repos, resource kinds, layered resolution model
- `01-version-management.md` — install, switching, isolation
- `02-resource-sync.md` — layered resource resolution and sync
- `03-routines.md` — scheduled jobs with sandboxed permissions
- `04-landscape.md` — competitive landscape
- `05-sessions.md` — session DB + indexer
- `06-observability.md` — JSON outputs as an observability layer

## Conventions

- Memory file is `AGENTS.md`; `CLAUDE.md` and `GEMINI.md` are symlinks.
- Tests in codebase as `*.test.ts` next to source; integration tests in `tests/`.
- Don't add fallback logic for the legacy single-root model — the migrator handles it once at install.
- `agents repo push`/`pull` operates on `~/.agents/` only; system updates ride `npm update -g agents-cli`.

## Remote Test Execution (Crabbox)

**NEVER run tests locally** — they freeze the machine. Always use Crabbox:

```bash
# Setup (once per session)
eval "$(agents secrets export hetzner.com)" && export HCLOUD_TOKEN=$API_TOKEN

# Check for existing box
crabbox list

# Warm up if needed (~60s)
crabbox warmup --class beast

# Run tests remotely
crabbox run --id <slug> -- bun test
```

The box auto-stops after 30 minutes of idleness. Cost: ~$0.14/hour.

## Security

**No sensitive data in any DotAgents repo.** All three repos (project, user, system) are designed to be safely version-controlled:

- Use `agents secrets` — bundle metadata lives in macOS Keychain, never on disk.
- Browser profile configs reference secrets bundles by name, not raw credentials.
- If you accidentally commit a secret, rotate it immediately — git history persists.
