feat(plugins): extend plugin spec support — commands, agents, bin, MCP, settings, install/update

## Summary

- **New resource types in `syncPluginToVersion`**: commands (`commands/*.md` → agent commands dir, namespaced `pluginName--cmd.md`), agent definitions (`agents/*.md` → agent's agents dir), bin executables (`bin/*` → `plugin-bin/<name>/`, path noted in `settings.json`), MCP servers (`.mcp.json` → merged into `mcpServers` with `pluginName--serverName` prefix), settings.json non-destructive merge (adds missing keys only, skips existing ones)
- **`${user_config.<key>}` variable expansion** added to `expandPluginVars` alongside the existing `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` vars; applied in hooks, MCP args, permissions, and file copy
- **`agents plugins install <name>@<source>`**: clones a git URL or copies a local path to `~/.agents/.cache/plugins/<name>/`, validates manifest, prompts for required `userConfig` fields (interactive TTY only), warns on missing dependencies, and auto-syncs to all default agent versions
- **`agents plugins update [name]`**: re-pulls from the recorded source (`git pull` for git installs, re-copy for local ones), preserves `.user-config.json`, and re-syncs affected versions
- **userConfig storage**: `loadUserConfig` / `saveUserConfig` read/write `.user-config.json` inside the plugin root; `promptUserConfig` (CLI-only) uses `@inquirer/prompts` `input` for each missing required field
- **Dependency warnings**: `checkPluginDependencies` cross-checks `manifest.dependencies` against installed plugins and surfaces missing ones at install time
- **Extended `removePluginFromVersion`**: cleans up commands, agent defs, bin dir, namespaced MCP server entries, and `pluginBinPaths` in addition to the existing skills/hooks/permissions removal
- **Extended `isPluginSynced`**: checks commands, agent defs, bin dir, and namespaced MCP servers in addition to skills/hooks/permissions
- **Extend types**: `PluginManifest` gains `userConfig` and `dependencies`; `DiscoveredPlugin` gains `commands`, `agentDefs`, `bin`, `hasMcp`, `hasSettings`

## How to test

1. Create a test plugin directory at `~/.agents/.cache/plugins/test-plugin/` with the full structure:
   ```
   .claude-plugin/plugin.json   # { name, version, description, userConfig }
   commands/deploy.md
   agents/reviewer.md
   bin/my-tool
   .mcp.json                    # { mcpServers: { "my-server": { command, args } } }
   settings.json                # { theme: "dark" }
   hooks/hooks.json
   ```
2. Run `agents plugins install test-plugin@/path/to/test-plugin` — should prompt for `userConfig` fields and sync to default Claude version
3. Run `agents plugins list` — verify the plugin shows as synced
4. Inspect `~/.agents/versions/claude/<version>/home/.claude/settings.json` — verify `mcpServers["test-plugin--my-server"]`, `theme`, and `pluginBinPaths` entries
5. Inspect the commands and agents dirs for `test-plugin--deploy.md` and `test-plugin--reviewer.md`
6. Run `agents plugins update test-plugin` — should re-pull and re-sync
7. Run `agents plugins remove test-plugin` — verify all resources are cleaned up
8. Run `bun test src/lib/plugins.test.ts` (on Crabbox per project convention) to run the unit and integration tests
