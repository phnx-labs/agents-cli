# Resource Sync

How agents-cli syncs resources (commands, skills, hooks, memory, MCP, permissions) between central storage and version homes.

For the conceptual model — what a DotAgents repo is, what resources are, and how layered resolution works — see [00-concepts.md](00-concepts.md).

## Resource Types

| Resource | Source layers (resolved project > user > system) | Version Home Location | Sync Method |
|----------|-----------------|----------------------|-------------|
| Commands | `<project>/.agents/commands/*.md` › `~/.agents/commands/*.md` › `~/.agents-system/commands/*.md` | `.{agent}/commands/` | Symlink (copy+convert for Gemini) |
| Skills | `…/.agents/skills/{name}/` (same layering) | `.{agent}/skills/` | Symlink |
| Hooks | `…/.agents/hooks/*.sh` (same layering) | `.{agent}/hooks/` | Symlink |
| Rules | `…/.agents/rules/AGENTS.md` (same layering) | `.{agent}/{instructionsFile}` | Symlink |
| MCP | `…/.agents/mcp/*.yaml` (same layering) | `.{agent}/settings.json` | Merge into JSON |
| Permissions | `…/.agents/permissions/groups/*.yaml` (same layering) | `.{agent}/settings.json` | Merge into JSON |
| Plugins | `…/.agents/plugins/{name}/` (same layering, Claude + OpenClaw only) | `.{agent}/plugins/marketplaces/agents-cli/plugins/<name>/` | Copy + synthetic marketplace + enable in settings |

`resolveResource(kind, name)` returns the single winner; `listResources(kind)` returns the union with `source: 'project' \| 'user' \| 'system'`. Same name in a higher layer overrides lower layers; otherwise everything unions.

### Extra repos

Users can register additional DotAgent repos via `agents repo add <source>`. Extras clone into `~/.agents-system/.repos/<alias>/` and ship the same layout (`skills/`, `commands/`, `hooks/`, `rules/`). They participate as an additional layer below the user repo and above the system repo. Registrations live in `meta.extraRepos` in `~/.agents/agents.yaml`.

## Memory File Mapping

Central `AGENTS.md` maps to agent-specific filenames:

```
~/.agents/rules/AGENTS.md  ───▶  ~/.claude/CLAUDE.md
                            ───▶  ~/.codex/AGENTS.md
                            ───▶  ~/.gemini/GEMINI.md
                            ───▶  ~/.gemini/antigravity-cli/AGENTS.md
                            ───▶  ~/.cursor/.cursorrules
                            ───▶  ~/.opencode/OPENCODE.md
                            ───▶  ~/.grok/AGENTS.md
```

Symlinks in `~/.agents/rules/`:
```
AGENTS.md       # Real file (source of truth)
CLAUDE.md -> AGENTS.md
GEMINI.md -> AGENTS.md
```

## Sync Detection

Sync state is derived, not stored. Three set operations over the filesystem:

```
available = contents of ~/.agents/{commands,skills,hooks,memory,mcp,permissions}
synced    = symlinks in <version home> whose target is under ~/.agents/
new       = available - synced
```

```
┌──────────────────────────────┬────────────────────────────────┬─────────────────────────────────┐
│ Function                     │ Reads                          │ Returns                         │
├──────────────────────────────┼────────────────────────────────┼─────────────────────────────────┤
│ getAvailableResources()      │ ~/.agents/*/                   │ { commands: string[],           │
│                              │ (skip symlinks in memory/)     │   skills: string[],             │
│                              │                                │   hooks: string[],              │
│                              │                                │   memory: string[], ... }       │
├──────────────────────────────┼────────────────────────────────┼─────────────────────────────────┤
│ getActuallySyncedResources   │ <version home>/.{agent}/*/     │ same shape                      │
│   (agent, version)           │ (readlink each entry, match    │                                 │
│                              │  against ~/.agents/)           │                                 │
│                              │ memory: file content compare   │                                 │
├──────────────────────────────┼────────────────────────────────┼─────────────────────────────────┤
│ getNewResources(...)         │ both above                     │ available − synced (per type)   │
└──────────────────────────────┴────────────────────────────────┴─────────────────────────────────┘
```

## Sync Flow

```
agents use claude@2.0.65
           │
           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  1. getNewResources(claude, 2.0.65)                                 │
│     └─ Returns: { commands: [foo], skills: [], memory: [AGENTS] }  │
│                                                                     │
│  2. If new resources found, prompt user                             │
│     └─ "2 commands, 1 memory file available. Sync now?"            │
│                                                                     │
│  3. syncResourcesToVersion(claude, 2.0.65)                          │
│     └─ Creates symlinks in version home                             │
│     └─ Records synced resources in agents.yaml                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Sync Targets: Version Selectors and Repo Scoping

`agents sync` accepts the full [agent-spec vocabulary](01-version-management.md#agent-spec-resolution)
plus an optional repo scope:

```bash
agents sync claude              # the resolved default version (interactive preview in a TTY)
agents sync claude@all          # every installed Claude version
agents sync claude@all system   # scope to one DotAgent repo: system | user | project | <alias>
agents sync claude --repo user  # same, via the flag form
```

A repo scope reconciles **only** that layer's resources into the target
version(s), leaving the other layers' already-synced resources untouched. Bare
`agents sync` (no agent) runs the umbrella verb — fetch remote state, then
reconcile every installed agent.

## MCP Servers: Per-Agent JSON Write

MCP is the one resource that isn't symlinked. Each agent stores MCP server
lists in its own settings file with its own key shape, so sync writes them
directly into the agent's config.

```
Source: ~/.agents/mcp/*.yaml       Per-agent destinations:

┌────────────────────┐             Gemini  → <home>/.gemini/settings.json
│ github.yaml        │                      · key: mcpServers.<name> = {command,args,env}
│ ───────            │             Agy     → <home>/.gemini/antigravity-cli/mcp_config.json
│ name: github       │                      · key: mcpServers.<name> = {command,args,env}
│ transport: stdio   │             Cursor  → <home>/.cursor/mcp.json
│ command: npx ...   │                      · key: mcpServers.<name> = {command,args,env}
│ args: [...]        │             Claude  → CLI: `claude mcp add ...`
│ env: { ... }       │                      (claude owns its own settings)
└────────────────────┘             Codex   → CLI: `codex mcp add ...`
                                            · HTTP transport not supported
                                   OpenCode → <home>/.config/opencode/config.toml
                                            · key: mcp.<name> (TOML)
                                   Grok    → <home>/.grok/config.toml
                                            · key: mcp_servers.<name> (TOML)
                                   Hermes  → <home>/.hermes/config.yaml
                                            · key: mcp_servers.<name> (YAML)
                                   Forge   → <home>/.forge/.mcp.json
                                            · key: mcpServers.<name> = {command,args,env}
```

Behavior rules, per `src/lib/mcp.ts`:

1. **Read existing, set by name, write back.** For Gemini/Cursor
   (`installMcpToGeminiConfig:194`, `installMcpToCursorConfig:227`):

   ```
   config = JSON.parse(fs.readFileSync(settings.json)) || {}
   config.mcpServers[server.name] = { command, args, env }  // or { url }
   fs.writeFileSync(settings.json, JSON.stringify(config, null, 2))
   ```

   User-owned top-level keys (theme, editor settings, etc.) are preserved
   because the merge only touches `mcpServers`.

2. **No ownership tracking.** There's no `_agents_managed` marker. If a user
   hand-edits `mcpServers.github`, the next sync silently overwrites it with
   the YAML's values.

3. **Source delete ≠ destination clean.** `removeMcpServerConfig(name)`
   (`mcp.ts:381`) only unlinks the YAML file. The matching entry in each
   agent's settings stays until manually removed.

4. **Claude and Codex delegate.** Instead of editing settings.json directly,
   agents-cli invokes `claude mcp add` / `codex mcp add` (`mcp.ts:169-186`).
   Those commands own the merge. Benefit: agent-internal validation runs.
   Cost: write failures surface as `execSync` errors, not structured results.

## Permissions: Per-Agent Format Conversion

Permissions take a different path: collected into a canonical `PermissionSet`,
then converted per agent into that agent's native format. Not a JSON merge —
a format rewrite.

```
~/.agents/permissions/groups/                     Canonical                    Per-agent native
*.yaml                                            PermissionSet

┌─────────────────────┐                       ┌──────────────────┐          Claude (JSON):
│ read-only.yaml      │                       │ allow: [         │          { permissions: {
│ ───────             │ loadPermission-       │   "Read",        │              allow: [...],
│ allow: [Read, Grep] │ ─Groups()──────────▶  │   "Grep",        │              deny:  [...]
│ deny:  [Write]      │ concat per group      │   "Bash(git *)"  │            }}
│                     │                       │ ],               │
│ git-safe.yaml       │                       │ deny: [          │          OpenCode (TOML):
│ ───────             │                       │   "Write"        │          [permission]
│ allow: [Bash(git *)]│                       │ ],               │          [permission.bash]
│                     │                       │ additional-      │          "git *" = "allow"
│ 99-deny.yaml ──────▶│ rules go to deny      │   Directories:   │          "rm *" = "deny"
│ allow: [Bash(rm *)] │ (naming convention)   │   [...]          │
└─────────────────────┘                       └──────────────────┘          Codex (Starlark file):
                                                                            agents-deny.rules
                                                                            (generated text)
```

Group-to-permission-set is concatenation with one naming convention:
groups ending in `-deny` (e.g. `99-deny.yaml`) contribute to `deny` even
though their YAML lists appear under `allow`
(`permissions.ts:230-235`).

Per-agent conversion is lossy in both directions:

- Claude's native format is closest to canonical — near 1:1 passthrough
  (`permissions.ts:362-369`).
- OpenCode maps `Bash(pattern)` rules into a pattern → `allow`/`deny` map
  (`permissions.ts:385-405`). Non-bash rules are dropped.
- Codex emits Starlark deny rules to a generated `agents-deny.rules` file
  (`permissions.ts:38-56`). Allow rules aren't expressed; Codex defaults to
  deny-unless-allowed elsewhere.

## Plugins: Synthetic Marketplace + Exec-Surface Gate

Plugins bundle skills, commands, hooks, MCP servers, settings, and permissions
under a single `.claude-plugin/plugin.json` manifest. Sync copies the bundle
into each version home, registers a synthetic per-user marketplace named
`agents-cli`, and enables the plugin in Claude's / OpenClaw's settings.

```
Source: ~/.agents/plugins/<name>/        Per-version destination:

┌──────────────────────────────┐         <version-home>/.claude/plugins/
│ .claude-plugin/plugin.json   │         ├── known_marketplaces.json
│ skills/<name>/SKILL.md       │         │     └ "agents-cli" → marketplaces/agents-cli
│ commands/*.md                │         ├── marketplaces/agents-cli/
│ hooks/hooks.json   ◄─ exec   │         │   ├── .claude-plugin/marketplace.json
│ .mcp.json          ◄─ exec   │         │   │     └ synthesized: lists every
│ bin/, scripts/     ◄─ exec   │         │   │       discovered plugin
│ settings.json      ◄─ exec   │         │   └── plugins/<name>/  ← copy
│ permissions/       ◄─ exec   │         └── settings.json
└──────────────────────────────┘               └ enabledPlugins["<name>@agents-cli"] = true
```

Behavior rules, per `src/lib/plugins.ts:379` and `src/lib/plugin-marketplace.ts`:

1. **Discovery requires a valid manifest.** `discoverPlugins()`
   (`plugins.ts:61`) scans `~/.agents/plugins/<dir>/` and only accepts entries
   with a parseable `.claude-plugin/plugin.json` containing `name` and
   `version`. Directories without the manifest are silently skipped.

2. **Copy, not symlink.** Unlike commands/skills/hooks/rules, plugins are
   copied via `copyPluginToMarketplace()` (`plugin-marketplace.ts`). The copy
   pre-expands `${user_config.*}` placeholders against the per-plugin
   `.user-config.json` so each version sees its resolved values. `${CLAUDE_PLUGIN_ROOT}`
   and `${CLAUDE_PLUGIN_DATA}` are left for Claude to expand at runtime.

3. **Synthetic marketplace per version.** `syncMarketplaceManifest()` writes a
   `marketplace.json` listing every discovered plugin, and
   `registerMarketplace()` adds `agents-cli` to `known_marketplaces.json` so
   Claude treats it as installed (not a remote git source). This is what
   makes `claude plugin enable <name>@agents-cli` work without contacting a
   remote.

4. **Exec-surface gate.** Plugins shipping `hooks/`, `.mcp.json`, `bin/`,
   `scripts/`, non-permissions `settings.json`, or `permissions/` are
   *installed* (copied + marketplace registered) but *not enabled* unless the
   caller passes `allowExecSurfaces: true`. `enablePluginInSettings()`
   (`plugin-marketplace.ts:196`) short-circuits without flipping
   `enabledPlugins[<name>@agents-cli]` to `true`. The user-facing flag is
   `--allow-exec-surfaces` on both `agents plugins install` and
   `agents plugins sync`. The gate's purpose is to prevent unattended sync
   flows (e.g., `agents use claude@<v>`) from silently arming third-party
   code on every session.

5. **Capability gating.** Only agents where `supports(agent, 'plugins', version)`
   passes participate (`capableAgents('plugins')` in `src/lib/agents.ts` —
   today Claude, OpenClaw, Antigravity, Grok, and Codex >= 0.128.0). Plugins
   can additionally declare `agents: [...]` in their manifest to narrow further;
   `pluginSupportsAgent()` (`plugins.ts:179`) intersects both lists.

6. **Codex command-to-skill fallback.** Codex `>= 0.117.0` dropped
   command support; for those versions, plugin `commands/*.md` are
   converted to skills prefixed with `<plugin>-<command>`
   (`plugins.ts:444-453`) so they remain reachable as `$<plugin>-<command>`.

7. **Source delete ≠ destination clean — but skills get swept.**
   `cleanOrphanedPluginSkills()` (`plugins.ts:866`) runs every sync and
   removes plugin-owned skill dirs whose parent plugin no longer exists in
   `~/.agents/plugins/`. The marketplace copy itself isn't pruned until
   `agents plugins remove <name>` runs explicitly.

## Format Conversion (Gemini)

Gemini requires TOML format for commands. Markdown commands are converted:

```markdown
# ~/.agents/commands/commit.md
---
description: Create a commit
---
Review changes and create a commit with a descriptive message.
```

Becomes:

```toml
# ~/.gemini/commands/commit.toml
[command]
description = "Create a commit"

[[command.steps]]
prompt = "Review changes and create a commit with a descriptive message."
```

## Key Functions

| Function | File | Purpose |
|----------|------|---------|
| `getAvailableResources()` | versions.ts | List central resources |
| `getActuallySyncedResources()` | versions.ts | Check what's synced to version |
| `getNewResources()` | versions.ts | Diff available vs synced |
| `syncResourcesToVersion()` | versions.ts | Create symlinks in version home |
| `markdownToToml()` | convert.ts | Convert command format for Gemini |
