# Changelog

## Unreleased

**Fixes**

- Auto-update prompt no longer hangs in non-interactive environments (CI, k8s pods, cloud sandbox factories). The TTY check now requires both stdin and stdout to be terminals before prompting, and `AGENTS_CLI_DISABLE_AUTO_UPDATE=1` forces the check off entirely for headless deploys. ([#15](https://github.com/phnx-labs/agents-cli/issues/15))

## 1.17.1

**Agent management**

- `agents import <agent>` — adopt an existing global npm/homebrew install into agents-cli management without reinstalling. Supports `--version`, `--from-path`, `--yes`. The imported version is wired in as the global default with shim + versioned alias so it behaves the same as a freshly `agents add`'d install.

## 1.17.0

**Workflows: a new first-class resource**

- `agents workflows list / add / remove / view` — WORKFLOW.md bundles (with optional `subagents/`, `skills/`, `plugins/`) install from GitHub or a local path and resolve through the same system → user → project layer model as every other resource.
- `agents run <name>` resolves a workflow or named subagent as an orchestrator: prepends WORKFLOW.md / AGENT.md body to the prompt, copies `subagents/*` into `~/.claude/agents/` for Agent-tool discovery, and syncs workflow-scoped `skills/` and `plugins/` at run time.
- `agents view` now has a workflows section.

**Browser**

- Port-per-profile with auto-allocation and viewport enforcement — concurrent browser profiles no longer collide on CDP ports.
- `agents browser scroll` plus new `profiles launch`, `profiles doctor`, `profiles prime`, viewport position, and port diagnostics commands.
- `agents browser profiles list` now shows a description column when any profile has one.
- `isProcessRunning` treats EPERM as process-alive (fixes false-negative on sandboxed processes).

**Cloud dispatch**

- `--balanced` strategy and `--upload-account-tokens` flag on cloud dispatch.
- Remote account API client; `--balanced` skips the client manifest path.

**Plugin system extension**

- Plugins now ship with `commands/`, `agents/`, `bin/`, MCP configs, settings, and `install` / `update` hooks. Discovery and sync extended end-to-end.

**Secrets**

- `agents secrets import <bundle> --from-1password` / `export <bundle> --to-1password` with vault picker, skip-empty-fields on import, overwrite-only-with-`--force` on export. Wires the existing 1Password library into the CLI.

**Sandbox**

- `scripts/sandbox.sh --pr` — author real PRs from a Crabbox-isolated box via a bare-mirror clone off main.
- `sandbox.sh --linear` and `--post-file` post run output to Linear tickets.
- Dynamic GitHub App token, `gh` CLI installed, stale git credentials cleaned.

**Sessions / SQLite concurrency**

- Scan coordinator prevents concurrent session indexing.
- SQLite concurrency hardened with `BEGIN IMMEDIATE` and ledger recheck on contention.
- Session discovery uses `getHistoryDir` for version roots and backup paths.

**Run / shims / hooks**

- Versioned alias shims regenerate on startup if missing.
- Hooks prefer version-home scripts to prevent path breakage when the source dir moves.
- Linux: claude shim sources `CLAUDE_CODE_OAUTH_TOKEN` from the per-version `.oauth_token` file when unset.

**Resource UI**

- `agents view` replaces path columns with OSC 8 hyperlinks for commands, skills, and rules.
- Flat version resource lists replaced with source-pattern selection.

**CI / security**

- Gitleaks secret-scanning workflow on every push (switched to the free CLI, no org license needed).

**Postinstall**

- Correct shims dir, expanded aliases, prints changelog on install.

**Dev**

- Test isolation via vitest `pool: 'forks'`; mock state paths instead of hitting real `~/.agents/`.
- Concurrent-writes benchmark for the session indexer.
- Dead code + phantom deps removed: `src/commands/fork.ts`, `@aws-sdk/client-s3`, `@modelcontextprotocol/sdk`, `semver`.

## 1.16.0

**System-repo sweep: ~/.agents-system reduced to npm-shipped defaults only**

- New migrators move every form of operational state out of ~/.agents-system into user-side buckets: sessions, teams (live + per-run), trash, repos (→ ~/.agents-<alias>/ peer dirs), legacy swarm/, cache/, cloud/.
- SQLite DBs merge row-level (INSERT OR IGNORE) into the user-side DB; filesystem dirs merge dir-by-dir with user-side winning on collision.
- Dead artifacts dropped automatically: bin/agents-keychain-*, empty shims/, .DS_Store-only versions/ skeletons.
- Unrecognized leftover dirs print a one-line stderr warning so future drift surfaces immediately.
- Migration diagnostics moved to stderr — `eval "$(agents secrets export …)"` stops being polluted by log lines.
- DB merge now skips FTS5 virtual + shadow tables (previously corrupted the session_text index). Indexer re-populates FTS on the next scan.
- Stale ~/.agents-system/agents.yaml is now dropped when a user copy exists.

**~/.agents split into .history/ and .cache/ buckets**

- Durable runtime state (sessions, versions, runs, teams/agents, trash, backups) moves to ~/.agents/.history/.
- Regenerable runtime state (shims, packages, cloud, logs, swarmify, helpers, browser runtime, fetch cache, dot-files) moves to ~/.agents/.cache/.
- Single-line gitignore for backing up ~/.agents/ — no more per-subdir cherry-picking.

**Browser: profiles fold into agents.yaml + many new automation commands**

- Profile YAMLs at ~/.agents/browser/profiles/*.yaml now live as a `browser:` section in agents.yaml. Single user-facing file, single sync.
- Single window per profile; `start` renamed to `open`; new tab subcommands; session history with profile picker; viewport piped through to the launched browser.
- New commands: `agents browser set viewport`, `set device`, `devices`, `console`, `errors`, `requests`, `responsebody`, `wait`, `download`, `waitdownload`.

**Hooks: hooks.yaml folded into agents.yaml `hooks:` section**

- ~/.agents/hooks.yaml is migrated into agents.yaml on first run; the standalone file is removed.
- System repo ships the same shape — one config file, layered project > user > system.

**Sessions & secrets**

- `agents secrets exec <bundle> -- <command>` injects a bundle's env vars into a one-shot subprocess (no shell-state leakage).
- `agents sessions` now groups active sessions by workspace and surfaces session topics in the picker.
- Session discovery scans both version repos; migrator merges overlapping versions instead of leaving duplicates.

**Renames**

- `agents init` → `agents setup`.
- `permissions/sets/` → `permissions/presets/` (resource directory + on-disk migration to match rules/presets convention).

**Dev**

- Crabbox remote-test profile (~$0.14/hr) + `scripts/sandbox.sh` documented in README and CLAUDE.md. Tests run remotely to avoid freezing the local machine.

## 1.15.0

**Secrets: Linux support via libsecret/GNOME Keyring**

- `agents secrets` now works on Linux backed by libsecret/GNOME Keyring with the same UX as macOS Keychain. Headless workarounds documented.
- New `agents password generate` subcommand.
- Lifecycle events emitted for secrets and other subsystems; richer metadata (timing helpers) on the events system.

**Browser**

- HTTP and WebSocket endpoint support for remote browsers.
- Concurrent Electron profile forks no longer step on each other; cleanup hardened.
- Remote browser restart works; SSH port handling improved; page target created when none exists for Electron apps.
- Events emitted for navigation and screenshots.

**First-run UX**

- Improved new-user experience: clearer CLI help, better defaults, audit-log opt-out, better run-timing display.

**Prune**

- `agents prune` learned `trash`, `sessions`, and `runs` cleanup targets.

**Fixes**

- Command-injection hole in daemon + secrets closed.
- Layered permission resolution corrected; daemon tests isolated from real user state.
- `.tmp-bun` gitignore pattern fixed.
- `codex` interactive mode no longer routes through `exec` subcommand.

**Docs**

- Security/privacy section in README, browser skill + automation guide, FAQ updated with audit-log transparency.

## 1.14.6

**Fix: OAuth token refresh now persists to Keychain**

- Fixed bug where refreshed Claude OAuth tokens were used but never saved back to macOS Keychain
- Previously, agents-cli would refresh expired tokens on each run but discard them, eventually exhausting the refresh token
- Now refreshed `accessToken`, `refreshToken`, and `expiresAt` are written back to Keychain after successful refresh
- Accounts will stay healthy across runs without requiring re-login

## 1.14.5

**Browser: custom binary and Electron app support**

- Added `binary` field to browser profiles for specifying custom executable paths (e.g., Electron apps like Rush)
- Added `electron` field to browser profiles — when true, uses existing windows instead of creating new ones (Electron doesn't support `Target.createTarget`)
- New `custom` browser type that requires a binary path
- Works with both local and SSH-based browser connections
- Example profile for Rush: `agents browser profiles edit rush --browser custom --binary "/Applications/Rush.app/Contents/MacOS/Rush" --electron`

## 1.12.0

**JSON output for sessions list**

- Added `--json` flag to `agents sessions list` and `agents sessions` for programmatic use
- Output is a JSON array of session metadata (id, shortId, agent, version, account, project, cwd, filePath, topic, messageCount, tokenCount, timestamp)
- Enables the Swarmify VS Code extension's "Agents: Session Resume" and "Agents: Session Trace" pickers

**OpenClaw workspace-aware sessions**

- Fixed `agents sessions --agent openclaw` so synthetic OpenClaw rows now use the configured agent workspace from `~/.openclaw/openclaw.json`
- When no per-agent workspace is available, OpenClaw session discovery now falls back to `~/.openclaw` instead of leaving `cwd` empty or filling it with status text
- Added a regression test covering managed OpenClaw homes symlinked through `~/.agents/versions/openclaw/...`

## 1.11.1

**Session search and version labeling**

- `agents sessions view` now opens a live-search picker by default in interactive terminals
- `agents sessions --agent ...` and `agents sessions --project ...` now open the same live-search picker before falling back to the table view
- `agents sessions view <query>` now resolves prompt text, not just exact session IDs
- Fixed `--project` search so it scans across directories instead of intersecting with the current working directory
- Session topics now skip injected scaffolding and use the first human prompt
- Codex session rows now show the real CLI build from `cli_version` (for example `codex@0.113.0`)
- Gemini, OpenCode, and OpenClaw session rows now resolve and display agent versions consistently in the shared `Agent` column
- Claude usage lookup now falls back across scoped and legacy Keychain services when loading OAuth credentials

## 1.11.0

**PTY -- interactive terminal sessions for AI agents**

- New `agents pty` command suite for persistent, interactive PTY sessions
- Sidecar server architecture -- lightweight daemon on `~/.agents/pty.sock`, auto-starts on first use
- `agents pty start` -- spawn a session with configurable rows, cols, shell, and working directory
- `agents pty exec <id> <command>` -- submit commands (non-blocking, sentinel-based completion detection)
- `agents pty screen <id>` -- render the terminal as clean text (no ANSI codes), powered by xterm-headless
- `agents pty write <id> <input>` -- send keystrokes with escape sequence support (`\n`, `\t`, `\e`, `\xHH`)
- `agents pty read <id>` -- read raw PTY output with configurable timeout
- `agents pty signal <id> [INT|TERM|KILL]` -- send signals to the PTY process
- `agents pty list` -- show active sessions with status, PID, age, and active command
- `agents pty server start|stop|status` -- manage the sidecar server directly
- Session idle cleanup (30 min) and server auto-exit (1 hour with no sessions)
- `--json` output on all commands for scripting
- Auto-fixes node-pty spawn-helper permissions on startup (bun install workaround)

## 1.10.0

**Drive -- sync agent sessions across machines**

- New `agents drive` command for syncing agent state between machines via rsync over SSH
- `agents drive remote <user@host>` -- set sync target (syncs to `~/.agents/drive/` on remote)
- `agents drive pull` / `push` -- additive rsync (no data loss, both sides accumulate)
- `agents drive attach` -- swap `~/.claude` symlinks to the drive, so Claude reads/writes there
- `agents drive detach` -- restore symlinks to the version home
- `agents drive status` -- show remote, attached state, symlink targets, last sync times

## 1.9.1

**Better sessions**

- Sessions list and picker show `Agent@Version` combined column (e.g., `claude@2.1.85`)
- Added `Topic` column showing first user message of each session
- Account shows email instead of display name

## 1.9.0

**New agents, routines, and better sessions**

Agents:
- Added support for 5 new agents: Copilot, Amp, Kiro, Goose, and Roo Code
- Agent type expanded to 11 agents total

Routines (renamed from cron):
- `agents cron` is now `agents routines` -- aligns with Claude Code Routines naming
- `agents cron` and `agents jobs` still work as deprecated aliases
- `~/.agents/cron/` directory renamed to `~/.agents/routines/`

Sessions:
- Sessions list now shows `Agent@Version` in a combined column (e.g., `claude@2.1.85`)
- Added `Topic` column showing the first message of each session
- Account column now shows email instead of display name
- Session picker uses the same columns as the list view

Other:
- Account email preferred over display name across the CLI
- Rewritten help text for all top-level commands

## 1.6.12

**"memory" is now "rules"**

The `agents memory` command has been renamed to `agents rules`. This better reflects what these files actually are -- instruction files like AGENTS.md, CLAUDE.md, and .cursorrules that tell your agents how to behave.

- `agents rules list` -- see your instruction files across all agents
- `agents rules add` -- install and sync rule files from a repo or local path
- `agents rules view` -- view rule file content for any agent
- `agents rules remove` -- remove a rule file

If you run `agents memory`, you'll see a message pointing you to the new command.

The files themselves haven't changed -- AGENTS.md is still AGENTS.md. Only the CLI command name changed.

## 1.6.8

**Bug fix**

- Skip commands and memory sync for agents that don't support file-based commands (openclaw)
- Added `commands` capability flag to agent configs
- `agents use openclaw` and `agents view openclaw` no longer show or sync slash commands or memory files
- Fixed `hasNewResources` to filter by agent capabilities (was triggering prompt even when no applicable resources existed)

## 1.6.5

**Bug fix**

- Fixed memory file detection counting symlinks as separate files (CLAUDE.md/GEMINI.md -> AGENTS.md)

## 1.6.4

**Bug fixes**

- Fixed Claude email not showing in `agents view` (was reading from version home instead of real ~/.claude.json)
- Fixed memory file updates not being detected in `agents use` (now compares content, not just existence)

## 1.6.3

**Bug fix**

- Fixed infinite "new resources available" loop in `agents view`
- Partial resource syncs no longer wipe out previously synced resources

## 1.5.82

**MCP & Permission improvements**

- MCP configs now stored as YAML in `~/.agents/mcp/` (was JSON)
- Permissions now use groups from `~/.agents/permissions/groups/`
- Resource selection shows proper counts: "Permissions (19 groups, 3132 rules)"
- When selecting "specific" permissions, shows individual groups with rule counts
- Added MCP support for cursor and opencode agents
- Removed `agents` filter from MCP configs - selection tracked in agents.yaml
- Added capability checks for MCPs (consistent with hooks/permissions)

## 1.5.81

**Cron jobs & unified execution**

- Renamed `jobs` command to `cron` (`jobs` still works with deprecation warning)
- New `agents exec <agent> <prompt>` for unified agent execution across all CLIs
- Inline job creation: `agents cron add my-job --schedule "..." --agent claude --prompt "..."`
- One-shot jobs with `--at`: `agents cron add reminder --at "14:30" -a claude -p "..."`
- New `agents cron edit [name]` opens job in `$EDITOR`
- Timezone support: `--timezone America/Los_Angeles`
- Custom variables in prompts: define `variables:` block, use `{var_name}` in prompt
- Interactive pickers for all cron subcommands when name is omitted
- Smart filtering: `resume` shows only paused jobs, `pause` shows only enabled jobs
- Effort-based model mapping: `--effort fast|default|detailed` maps to agent-specific models

**Resource command cleanup**

- Added `view` command to commands, mcp, hooks, and permissions
- Removed `push` commands from all resources (commands, skills, mcp, memory, hooks)
- Deprecated `perms` alias for `permissions` (shows warning but still works)
- Deprecated `info` alias for `skills view`, `show` alias for `memory view`

## 1.5.68

- Upgrade prompt now shows on ALL command flows (--version, --help, bare `agents`)

## 1.5.67

**Unified view command**

- New `agents view` command replaces `list` and `status`
- `agents view` / `agents view claude` shows installed versions
- `agents view claude@2.0.65` shows full resources (commands, skills, mcp, hooks, memory)
- Old commands show deprecation warning but continue to work

## 1.5.48

**Simplified repo structure**

- Flattened repo structure: removed `shared/` prefix
- Resources now live at top level: `commands/`, `skills/`, `hooks/`, `memory/`, `permissions/`
- Removed agent-specific override directories (no more `claude/commands/`, etc.)
- Simplified discovery functions

## 1.5.29

**Version-aware resource installation**

- `agents pull` now prompts for version selection per agent when multiple versions are installed
- Resources (commands, skills, hooks, memory) are linked into version homes at pull time via `syncResourcesToVersion()`
- Simplified shims: HOME overlay + exec only (~80 lines, down from ~160). No more runtime sync logic.
- MCP registration uses direct binary path for version-managed agents (bypasses shim)

## 1.5.7

- Remove trailing newlines from command output

## 1.5.5

- Update prompt: Interactive menu before command runs (Upgrade now / Later)

## 1.5.4

- `cli list`: Shows spinner while checking installed CLIs

## 1.5.3

- `skills view`: Opens in pager (less) for scrolling, press `q` to quit

## 1.5.2

- `skills view`: Truncate descriptions to fit on one line

## 1.5.1

- Update check: Shows prompt when new version available
- What's new: Displays changelog after upgrade
- `skills view`: Interactive skill selector (renamed from `info`)
- Fixed `--version` showing hardcoded 1.0.0 (now reads from package.json)
- Silent npm/bun output during upgrade

## 1.5.0

**Pull command redesign**

- Agent-specific sync: `agents pull claude` syncs only Claude resources
- Agent aliases: `cc`, `cx`, `gx`, `cr`, `oc` for quick filtering
- Overview display: Shows NEW vs EXISTING resources before installation
- Per-resource prompts: Choose overwrite/skip/cancel for each conflict
- `-y` flag: Auto-confirm and skip conflicts
- `-f` flag: Auto-confirm and overwrite conflicts
- Graceful cancellation: Ctrl+C shows "Cancelled" cleanly

## 1.4.0

- Conflict detection for pull command
- Bulk conflict handling (overwrite all / skip all / cancel)

## 1.3.13

- Enabled skills support for Cursor and OpenCode
- Fixed Cursor MCP config path (now uses mcp.json)

## 1.3.12

- Fixed MCP detection for Codex (TOML config format)
- Fixed MCP detection for OpenCode (JSONC config format)
- Added smol-toml dependency for TOML parsing

## 1.3.11

- Status command shows resource names instead of counts
- Better formatting for installed commands, skills, and MCPs

## 1.3.0

- Added Agent Skills support (SKILL.md + rules/)
- Skills validation with metadata requirements
- Central skills directory at ~/.agents/skills/

## 1.2.0

- Added hooks support for Claude and Gemini
- Hook discovery from hooks/ directory
- Project-scope hooks support

## 1.1.0

- Added MCP server registration
- Support for stdio and http transports
- Per-agent MCP configuration

## 1.0.0

- Initial release
- Pull/push commands for syncing agent configurations
- Slash command management
- Multi-agent support (Claude, Codex, Gemini, Cursor, OpenCode)
