# Changelog

## 1.20.1

**Routines (fix wrong "failed" status on healthy detached runs)**

- `monitorRunningJobs` was hardcoding `status: 'failed'` whenever it detected that a detached child had exited — with no way to read the real exit code, because `executeJobDetached` fires-and-forgets the child. Every routine that ran via the scheduler ended up labeled `failed/exitCode: null`, even when the agent completed cleanly.
- Fix: when finalizing a vanished child, scan the tail of its stream-json `stdout.log` for Claude's `type: result` terminator (which carries `is_error`). If found, set `status` and `exitCode` from it. Only fall back to `failed` when no result marker exists (process was killed mid-run).
- Codex/Gemini run finalization continues to fall back to `failed` until their stream tail parsers are added.

## 1.20.0

**Routines (overdue detection + catchup)**

- Detect routines whose most recent scheduled fire was missed (laptop off, daemon crashed, reboot). The daemon logs them on startup and pops a native desktop notification (`osascript` on macOS, `notify-send` on Linux).
- `agents routines list` annotates overdue rows with `(overdue)` and prints a footer pointing at the catchup command.
- New `agents routines catchup` command: lists overdue routines and fires them in the background under the scheduler. `--dry-run` lists without triggering.
- `JobScheduler.schedule` now sets croner's `catch: true` and forwards `timezone` defensively, so a synchronous throw in one job's callback can't kill the whole cron loop.

**Landing page (agents-cli.sh)**

- Expanded the homepage with seven new sections: rotate accounts (`--rotate`), parallel teams (`agents teams`), browser automation, cross-agent session search, routines/cron, keychain secrets, and machine-to-machine sync (`agents drive`).
- Rewrote meta description + lede to spell out the actual feature set (pin versions, swap models, rotate accounts, drive a browser, spawn parallel teams, schedule on cron) instead of just "same interface, on your machine."

**Codex (commands-as-skills sync fix)**

- Fix recurring "N commands new" prompt on `agents view codex` for Codex >= 0.117.0. `getActuallySyncedResources` now detects converted command-skills via the `agents_command` marker in `~/.codex/skills/<name>/SKILL.md` instead of only scanning the empty legacy `prompts/` directory.
- Summary and selection prompts are version-aware: the static `COMMANDS_CAPABLE_AGENTS` gate is replaced by `supports(agent, 'commands', version)` so the "X commands" line only appears for versions that can actually take them.
- Generalize `shouldInstallCommandAsSkill` beyond Codex — any agent where commands are gated off and skills are on (e.g. Grok) now gets the same automatic slash-command → skill conversion at install/sync time.

**Grok Build (first-class support)**

- Add `grok` as a first-class supported agent (AgentId + full registry entry using official `~/.grok/README.md` paths).
- Implement proper binary resolution from `~/.grok/downloads/`.
- Add `GROK_HOME` isolation to generated shims for true versioned config (skills, hooks, plugins, agents/, MCP, memory, etc.).
- Extend `installVersion` to support Grok via its official installer script (`curl ... -s <version>`).
- Update shims, exec templates, MCP path helpers, session helpers, unmanaged detection, and docs.
- `agents add grok@<ver>`, `agents use grok@<ver>`, resource sync, and shims now work end-to-end for Grok Build.

**Browser**

- `agents browser start --record` convenience flag for one-shot recording sessions.
- Auto-discover per-site `SKILL.md` on `browser start` so skills appear under the active task without manual wiring.
- Auto-pick a Chromium-family browser when `--profile` is omitted; the limitation is surfaced in `--help` and the auto-pick error.
- No more stacktraces when the daemon is down or CDP is unreachable — error paths print a single human-readable line.
- Drop the Playwright `bundled-chromium` devdependency.

**Secrets / Keychain**

- `agents secrets list` and `agents run --secrets <bundle>` collapse to one Touch ID prompt per bundle instead of one per key. Previously every secret in a bundle would re-prompt for keychain unlock.

**Sessions**

- Extract `groupActiveSessions` into a tested helper for `--active` window grouping.
- Propagate `windowid` from live-terminals into the active session record.

**Copilot**

- Emit `COPILOT_HOME` in the shim and exec env builder for versioned isolation.
- Wire the Copilot session dir and `.jsonl` extension into the sessions reader.

**OpenClaw**

- Carry OpenClaw user data forward on version switch.

**Teams**

- Warn loudly when `--after` teammates reference a name whose watch process never launched, instead of silently sitting in pending state.

**Plugins**

- Use `'directory'` source discriminator (not `'local'`) for marketplace registration so plugins reload correctly.

**Dependencies**

- Bump `@inquirer/prompts` 7.10.1 → 8.5.1, `diff` 8.0.4 → 9.0.0, `tsx` 4.22.2 → 4.22.3, `actions/setup-node` 4.4.0 → 6.4.0.

## 1.18.6

**Claude**

- Add auto permission mode support for Claude runs.
- Remove a dead automatic mode flag from the Claude command template.

**Teams**

- Fix the cycle-detection test to accept running or failed teammate status.

## 1.18.5

**Browser**

- **Breaking:** action commands no longer accept a leading `<task>` positional.
  Bind the task once per shell via `AGENTS_BROWSER_TASK`, or pass `--task <name>`
  for a per-call override:
  ```bash
  export AGENTS_BROWSER_TASK=$(agents browser start --profile work)
  agents browser navigate --url https://example.com
  agents browser click 42
  agents browser screenshot
  ```
  Env vars are per-process, so parallel agents in different shells never collide.
- **Breaking:** URL/text/expression/scroll arguments are now flag-only — positional forms removed:
  - `navigate --url <url>` (was `navigate <url>`)
  - `tab add --url <url>` (was `tab add <url>`)
  - `type <ref> --text "..."` (was `type <ref> "..."`)
  - `evaluate --expression "..."` or `--file <path>` (was `evaluate "..."`)
  - `scroll --dx <n> --dy <n>` (was `scroll <dx> <dy>` — fixes negative-value parser collision)
- `screenshot` prints a one-line auto-save tip on stderr when `--output` is not passed,
  so agents see the directory without having to dirname() the path.

## 1.18.4

**Browser**

- `agents browser start` writes the resolved task name to **stdout** as a
  single line (e.g. `swift-crab-falcon-a3f92b1c`), and routes the human
  commentary ("Started task ... with tab ...", "Tip: export
  AGENTS_BROWSER_TASK=...") to **stderr**. This makes
  `T=$(agents browser start --profile X)` Just Work — no `--quiet` flag needed.
- Auto-generated task names are now three English words plus an 8-char hex
  suffix, e.g. `swift-crab-falcon-a3f92b1c`. Memorable, distinct, 32 bits of
  entropy so parallel agents never collide. Daemon retries on the (vanishingly
  rare) name clash and rejects explicit `--task <name>` values that already
  exist.
- `agents browser start --profile <name>` now pre-validates the profile
  locally before touching the daemon. Missing profile prints the list of
  available profiles plus the create-command hint instead of a generic error.
- `agents browser tab list` is now `agents browser tabs` (top-level), pairing
  cleanly with `agents browser tab focus <id>`. The old `tab list` form is
  removed.
- `agents browser --help` is reorganized by mental model — *Session lifecycle*,
  *Drive the page*, *Capture evidence* — instead of an alphabetical dump.
  Rare commands stay under a trailing *Commands* section.
- BREAKING: `agents browser profiles prime` and `agents browser profiles launch`
  are removed. Both were thin duplicates of `start`. For first-run
  onboarding, just `agents browser start --profile <name>` and complete the
  interactive screens in the browser; the user-data-dir persists across
  runs. The daemon's `launch-profile` IPC action is also gone.
- Named endpoint presets per profile. One profile can now cover the local
  and remote variants of the same app instead of forcing two parallel
  profiles. YAML supports both the legacy `endpoints: [url]` shape and the
  new map form:
  ```yaml
  name: rush
  browser: custom
  electron: true
  endpoints:
    local:
      target: cdp://127.0.0.1:9223
      binary: /Applications/Rush.app/Contents/MacOS/Rush
    mac-mini:
      target: ssh://mac-mini?port=9223
      # no binary — daemon attaches only
  defaultEndpoint: local
  ```
  `agents browser start --profile rush --endpoint mac-mini` picks a specific
  preset; `--endpoint` falls back to `defaultEndpoint` or the first preset.
  Pre-validated client-side so a typo doesn't waste an IPC round-trip.
  Per-endpoint `binary` and `targetFilter` override the profile-level
  fields. `agents browser profiles show` lists every preset, marks the
  default, and shows per-endpoint overrides.
- The daemon's runtime identity is now `<profile>@<endpoint>` so the same
  profile can run at multiple endpoints concurrently without colliding on
  pid/port files. `agents browser status` and `tasks` show the composite
  name, so you can tell at a glance which variant a task is using.
- `agents browser screenshot --quality raw` captures pixel-faithful PNG
  (no downscale) for archived QA evidence. Default stays `compressed`
  (JPEG, capped near 100 KB) for chat-injected screenshots.
- New `agents browser record start` / `agents browser record stop`
  recording verbs. Captures via CDP `Page.startScreencast`, pipes frames
  into ffmpeg (image2pipe → libvpx-vp9) and writes a webm under
  `sessions/<task>/recordings/`. Bounded three ways — `--fps` (default
  5), `--duration` (hard cap, default 60s), `--max-mb` (default 25);
  whichever fires first auto-finalizes the file. Requires ffmpeg on
  PATH (`brew install ffmpeg`).

## 1.18.3

**Plugins** ([#22](https://github.com/phnx-labs/agents-cli/issues/22))

- `agents plugins sync` now installs plugins via Claude Code's native marketplace path — `<versionHome>/.{claude,openclaw}/plugins/marketplaces/agents-cli/plugins/<name>/` — instead of flattening contents into `~/.claude/skills/<plugin>--<skill>/`. Skills resolve as `/plugin:skill` (the documented form) instead of `/plugin--skill`. Plugins appear in Claude's `/plugins` UI under Installed and respond to `/plugin enable`, `/plugin disable`.
- A synthetic `agents-cli` marketplace is materialized per version: `.claude-plugin/marketplace.json` is synthesized from discovered plugins, an entry is added to `<versionHome>/.claude/plugins/known_marketplaces.json`, and `settings.json#enabledPlugins["<plugin>@agents-cli"]` is flipped to `true`. Removal is symmetric — last plugin out drops the marketplace dir and the known_marketplaces entry.
- The sync now copies the whole plugin tree verbatim (single `fs.cpSync`) instead of re-implementing per-feature merges into `settings.json`. Every Claude plugin feature — skills, commands, subagents, hooks, `.mcp.json`, `.lsp.json`, `monitors/monitors.json`, `bin/`, `settings.json` — is preserved end-to-end. `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` are left intact so Claude can expand them at runtime; only `${user_config.*}` (agents-cli-specific) is pre-expanded in copied text files.
- Legacy dual-dash layout from prior versions is auto-migrated at sync time — `~/.claude/skills/<plugin>--*`, `~/.claude/commands/<plugin>--*.md`, `~/.claude/agents/<plugin>--*.md`, `plugin-bin/<plugin>/`, and namespaced `mcpServers["<plugin>--*"]` entries are removed after the marketplace install succeeds.
- `agents plugins view <name>` surfaces every feature the plugin ships: Skills, Commands, Subagents, Hooks, MCP Servers, LSP Servers, Monitors, Bin, Scripts, Settings. The `agents view <agent>@<version>` Plugins section gains MCP/LSP/Monitor/Bin/Settings counts. New `discoverPluginMcpServers`, `discoverPluginLspServers`, `discoverPluginMonitors` helpers parse `.mcp.json`, `.lsp.json`, and `monitors/monitors.json`.

## 1.18.2

**Teams**

- Dropped `~/.agents/teams/config.json` entirely. It duplicated information agents-cli already has — agent commands, enabled flags, model defaults, provider endpoints — none of which the team runner was actually reading. Teams now discover agents via `listInstalledVersions()` (the same source `agents view` uses) and invoke them via the canonical `agents run` subcommand. One spawn path, one canonical exec module (`src/lib/exec.ts`). The deprecated `AGENT_COMMANDS`, `applyEditMode`, `applyFullMode`, `readConfig`, `writeConfig`, `setAgentEnabled`, `AgentConfig`, `SwarmConfig`, `ProviderConfig`, `ModelOverrides`, `ReadConfigResult`, and `EffortLevel` (the persistence-module copy) exports are removed from `@phnx-labs/agents-cli/teams`. Migration deletes both `~/.agents/teams/config.json` and the legacy `~/.agents/config.json`.
- `~/.agents/teams/registry.json` moves to `~/.agents/.history/teams/registry.json` — it's per-machine runtime state (timestamps + absolute worktree paths) and shouldn't be synced across machines via `agents repo push`.
- New `agents run --quiet` flag suppresses the rotation banner and `Running: …` preamble lines. Used by the team runner so stream-json events reach the parser without non-JSON preamble.

**Dev builds**

- The CLI auto-detects dev builds (version stamped `0.0.0-dev.<sha>` by `scripts/install.sh`, or invoked from a working tree where `<cli-dir>/../.git/` exists) and defaults `AGENTS_NO_AUTOPULL=1`, `AGENTS_SKIP_MIGRATION=1`, and `AGENTS_CLI_DISABLE_AUTO_UPDATE=1`. No more typing those three env vars on every iteration. Production installs (registry global, no `.git/` at package root) are unaffected.

## 1.18.1

**Fixes**

- `scripts/build.sh` now sets mode `0o755` on every file declared in `package.json#bin` after `tsc` emits dist/. Newer npm versions preserve file mode from the published tarball and do NOT auto-chmod the bin target during `npm install -g`, so 1.18.0 shipped with mode-644 entrypoints. Users hit `zsh: permission denied: agents` after auto-update. Re-install to recover: `npm install -g @phnx-labs/agents-cli@latest`.
- New `scripts/install.sh` builds the working tree as a side-by-side dev install at `$HOME/.local/agents-cli-dev/`, symlinked into `$HOME/.local/bin/agents`. The registry install is never touched — `agents --version` shows `0.0.0-dev.<sha>[-dirty]` when the dev build is on PATH.

## 1.18.0

**Plugins**

- `~/.agents/plugins/` is now a first-class user-resource location, alongside `skills/`, `commands/`, `hooks/`, etc. — git-tracked as source of truth. Previously, `migrateRuntimeToCache` moved `~/.agents/plugins/` into `~/.agents/.cache/plugins/` on every CLI version bump, silently destroying user-authored plugins in the working tree. Fixed by (1) removing the destructive move, (2) restoring discovery to the user-root, (3) a one-shot reverse migration that moves any cached plugins back to the user-root without overwriting an existing user-root copy, and (4) decoupling the migration sentinel from the binary version so migrations only re-run on real schema bumps. ([#20](https://github.com/phnx-labs/agents-cli/issues/20))
- `agents view <agent>@<version>` gains a `Plugins` section listing each plugin that supports the agent, with a `(N skills, N commands, …)` content summary and an OSC 8 hyperlink to the plugin source.

**Hooks**

- `getAvailableResources` and the version-home sync now treat only executable files in `hooks/` as hooks. Docs (`README.md`) and data files (`promptcuts.yaml`) that live alongside hooks no longer get synced into version homes as hooks, and the orphan-pruner trusts the manifest's declared hook list rather than re-scanning every source dir.

## 1.17.6

**Workflows**

- New `workflows` skill — author-and-run guide for workflow bundles (`WORKFLOW.md` frontmatter, `subagents/` directory for multi-agent pipelines, scoped `skills/` and `plugins/`, sharing via `agents repo push` or GitHub install). Calls out the `--mode plan` deadlock that bites workflows which need to post comments or edit files.
- `agents workflows --help` rewritten with a structure diagram, project > user > system resolution order, and an explicit note that workflows mutating state need `--mode edit` or `--mode full` to avoid a headless deadlock at `ExitPlanMode`.
- README gains a `Workflows` section between Teams and Browser covering the bundle layout, frontmatter, subagents/skills/plugins, and the `--mode` requirement.

## 1.17.4

**Browser**

- `agents browser type` now detects rich-text editor frameworks (Lexical, ProseMirror, Slate, Draft.js, Quill, CKEditor5, Trix) by walking up to 5 ancestor levels from each textbox and tagging refs with `[editor=<framework>]`. Editor-tagged refs route through the WHATWG `beforeinput` dispatch (`InputEvent('beforeinput', { inputType: 'insertText', ... })`) for Lexical/ProseMirror/Slate/Quill/CKEditor5/Draft and `el.editor.insertString()` for Trix. `agents browser refs --json` surfaces the new `editor` field, and `type --clear` prepends a select-all + `deleteContentBackward` dispatch before inserting.
- Plain-input reliability also improved: `typeText` now issues a single CDP `Input.insertText` instead of per-character `dispatchKeyEvent`, so framework-controlled inputs (React, Vue, Solid, MUI/Chakra/Mantine `TextField`, masked-number fields, Canva-style pickers) actually receive `beforeinput`/`input`/`textInput` events. `focusNode` falls back to the first focusable descendant when `DOM.focus` throws "Element is not focusable" — fixes wrapper-ref UIs like Slack composer, Linear comments, Notion blocks, and every MUI/Chakra/Mantine `TextField`. ([#12](https://github.com/phnx-labs/agents-cli/pull/12))

## 1.17.3

**Browser**

- `agents browser profiles create` gains `--electron`, `--binary`, and `--target-filter` for driving Electron desktop apps (Canva, Slack, etc.) that expose multiple CDP page targets. The picker matches by `url:<substring>` or `title:<substring>` (case-insensitive) and falls back to a skip-invisible heuristic when no filter is set; misses against an explicit filter throw with the full candidate list. `BrowserService.evaluate` now uses `awaitPromise: true` and surfaces `exceptionDetails` so async script errors propagate as thrown errors. ([#14](https://github.com/phnx-labs/agents-cli/pull/14))

**Secrets**

- `agents secrets list` rework — drop the misleading `SENSITIVE` column and add `SYNC` (iCloud yes/no) plus `CREATED` / `UPDATED` / `USED` relative-age columns. Timestamps live inside the keychain bundle JSON, are stamped on write (created sticky, updated always advances), and on resolve via a 60s throttle. Set `AGENTS_NO_USAGE_TRACK=1` to disable the usage stamp. `agents secrets view` shows the matching absolute ISO + relative age fields. ([#18](https://github.com/phnx-labs/agents-cli/pull/18))

## 1.17.2

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
- Regenerable runtime state (shims, packages, cloud, logs, companion, helpers, browser runtime, fetch cache, dot-files) moves to ~/.agents/.cache/.
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
- Enables the Companion VS Code extension's "Agents: Session Resume" and "Agents: Session Trace" pickers

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
