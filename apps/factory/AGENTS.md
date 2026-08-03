# Agents Extension

VS Code extension for multi-agent coding. Spawns AI terminals (Claude, Codex, Antigravity, Cursor, OpenCode) as editor tabs with keyboard shortcuts, and dispatches work to Rush Cloud.

This file is a **map**, not the territory. Keep it a short paragraph per area plus pointers. Read the actual code for current details.

## Layout

```
/src/core       Pure functions (no VS Code dependencies; unit-tested here)
/src/vscode     VS Code integration (commands, webviews, terminal tracking)
/ui/settings    Dashboard webview (React + Vite) — includes Factory Floor
/ui/editor      Custom markdown editor components
/assets         Icons (agent logos, rush bird, etc.)
/tests          Real-service tests (no mocks)
```

## Testing the Factory Floor UI

The Factory Floor feed + Dispatch panel are a React webview (`ui/settings`, top component `UnifiedAgentsPane.tsx`). To SEE and verify UI changes, do NOT install the packaged `.vsix` and drive VS Code via accessibility automation (`osascript` / `agents computer`) to open the dashboard — that steals your focus and is slow. Use the committed preview harness, which renders the real components with representative data in a plain browser page you can screenshot:

```
cd apps/factory/ui && bun run dev
# open http://localhost:5173/settings/preview/?view=feed   (or ?view=dispatch)
#   add &theme=dark  or  &theme=light
```

`ui/settings/preview/preview.tsx` mounts the same feed + DispatchPanel the webview uses; it is excluded from the shipped bundle (`vite.settings.config.ts` only inputs `settings/index.html`). Screenshot the browser page and actually inspect the render against the intent.

Gotchas:
- A built `preview-dist/index.html` opened over `file://` renders BLANK (Chromium CORS-blocks ES-module `<script src>` over file://). Serve over http (`bun run dev`), or inline the built JS/CSS into one self-contained HTML.
- To screenshot a browser window on another macOS Space, `screencapture -o` grabs the wrong Space; use a window-targeted capture (e.g. `agents computer screenshot --bundle <id> --window-id <id>`), which is focus-safe.

For logic-only changes, `bun test` in `apps/factory/` runs the `mission-control/*.test.ts` suites (floorModel, floorAdapter, dispatch, savedViews, etc.).

## Testing extension-host logic

Extension-host behavior lives in `src/vscode/` and depends on the real `vscode` API. There are three verification paths, from cheapest to most real:

1. **Mocked unit tests** — `bun test` runs `src/vscode/*.test.ts` with `mock.module('vscode', …)`. This covers terminal tracking, session detection, reconnect resilience, etc., without installing a `.vsix`. Fast, but not a real extension host.
2. **Preview harness** — for Factory Floor UI verification, use the browser harness above. Do not drive a real VS Code/Cursor window for UI screenshots.
3. **Installed end-to-end on a computer-equipped remote machine** — for behavior that genuinely needs a live extension host (command registration, webview ↔ host messages, terminal lifecycle), build and install the `.vsix` on a fleet box, then drive the editor via `agents computer`:

```bash
# Run on the target host (e.g. mac-mini), or wrap with `agents ssh mac-mini "..."`
cd apps/factory
bash scripts/build.sh <version>
bash scripts/install.sh <version>   # installs to Code/Cursor/Codium + reloads via activate.sh

# From any fleet box, drive the remote editor and screenshot/inspect the result.
# `agents computer` drives the machine it runs on, so wrap it in `agents ssh` —
# its own `--host` is a per-subcommand flag for remote *Windows* targets only.
agents ssh mac-mini "agents computer screenshot --bundle com.microsoft.VSCode --window-id <id>"
```

`scripts/install.sh` calls `scripts/activate.sh`, which reloads open editor windows and proves the new host activated from `exthost.log`. Running this on a remote machine keeps the verification focus-safe and avoids interrupting your local IDE.

## Building + Testing

```bash
bun run compile   # tsc + vite build for both webviews
bun test          # Full test suite, no mocks
bash scripts/install.sh <version>   # Package .vsix and install to Cursor + Code + Codium
```

## Device auto-launch preferences

Factory's auto-host selection reads per-device enable/prefer flags managed by the CLI (`agents devices enable|disable|prefer|unprefer <name>`). The store is `~/.agents/.history/devices/auto-launch.json`.

- A **disabled** device is excluded from `New <Agent>` auto picks. It remains manually pickable via `New <Agent> (Pick Host)`.
- A **preferred** device gets a `PREFERENCE_BONUS` (20 pts, ≈ two running agents) shaved off its `hostScore`, so it wins ties against otherwise-equivalent machines but never outranks one that is genuinely swamped. The bonus lives in `hostScore` itself, so both ranking paths — the warm-cache pick and the balanced pool pick — apply it identically.
- Defaults: every registered device is enabled and not preferred. An unregistered name is rejected by the CLI rather than written as a dead entry.

Source of truth:
- Persistence + CLI commands: `apps/cli/src/lib/devices/registry.ts` (`loadAutoLaunchPreferences`, `setAutoLaunchEnabled`, `setAutoLaunchPreferred`) and `apps/cli/src/commands/ssh.ts`.
- Extension consumption: `apps/factory/src/core/deviceAutoLaunch.ts`.
- Filtering/bias applied: `apps/factory/src/core/launchHistory.ts` (`pickCachedLaunchHost`) and `apps/factory/src/vscode/extension.ts` (`resolveCachedAutoHost`, `resolveBalancedHost`).

## Releasing to the Marketplace

Use `scripts/release.sh` from any fleet box. It routes itself to the machine that holds the `vs-marketplace` secrets bundle (currently `zion`) and publishes from a clean clone of the commit.

```bash
cd apps/factory
bash scripts/release.sh 0.9.xxx --confirm
```

Before running, the `vs-marketplace` bundle must be unlocked on the publish host. If it is locked, the script fails with:

> Secrets bundle 'vs-marketplace' is not unlocked in the secrets agent. Run 'agents secrets unlock vs-marketplace' in a terminal first — an agent launch never raises a Touch ID sheet on its own.

To unlock:

```bash
agents ssh zion
agents secrets unlock vs-marketplace
# Touch ID / password prompt appears on zion
```

Then re-run the release command.

Known gotchas:
- The release clone's test environment on `zion` currently misses some dev dependencies (`@happy-dom/global-registrator`, `gray-matter`) and cannot find `agents` on PATH for live-agent tests, so the local test run may fail even when GitHub CI is green. If CI passed and the change is release-ready, use `--skip-tests` as a hotfix path:
  ```bash
  bash scripts/release.sh 0.9.xxx --confirm --skip-tests
  ```
- The script builds and publishes to both VS Code Marketplace and Open VSX. Marketplace propagation can lag a few minutes; Open VSX is usually live immediately.
- The script installs the new `.vsix` into local VS Code / Codium windows automatically.

## Areas (and where to look)

| Area | Start here |
|---|---|
| Agent spawn flow + editor-tab terminals | `src/vscode/extension.ts` (`openSingleAgent`, `openSingleAgentWithQueue`) |
| `…/spawn` URI verb (how `agents sessions resume --vscodium` reopens a session as a tab) | Pure parse + surface choice: `src/core/spawn.ts` (`parseSpawnRequest`, `resolveSpawnSurface`); VS Code glue: `src/vscode/extension.ts` (`spawnCommandTerminal`). Honours `agents.terminalMode` exactly like `launchAgent`, so a URI-spawned session is tmux-backed and survives a window crash for the reconnect pass to re-attach. A split lands *inside* the parent's tmux session (`tmuxSplitH`/`tmuxSplitV`) rather than splitting the VS Code tab, which would strand the pane outside that session. |
| The ONE launch engine (every "New agent" command) | `launchAgent(context, {agentKey?, host?, pickHost?, local?})` in `src/vscode/extension.ts` is the single route. It resolves: **host** (explicit / device-first `pickLaunchHost` / auto `resolveBalancedHost`), **harness** (explicit, or `resolveAutoAgentKey` — usable-on-the-chosen-host via `hostHasUsableVersion`, ranked by `pickAgentByUsage`), and **version/account** (ALWAYS balanced via `--strategy balanced`; no pinned/latest/version-picker path exists). Commands are thin: `agents.newAgent` = `launchAgent({})` (auto everything), `agents.newAgentPickHost` = `{pickHost:true}` (device-first, auto harness), `agents.new<Harness>` = `{agentKey, local:true}`, `agents.new<Harness>PickHost` = `{agentKey, pickHost:true}`. Pure ranking: `src/core/launchHost.ts` (`pickBestHost`, `deviceHasUsableVersion`, `resolveBalancePool`) + `src/core/agentUsage.ts` (`pickAgentByUsage`). Health probe: `src/vscode/deviceHealth.vscode.ts` (`fetchDeviceStats`). Auto-launch filtering/bias: `src/core/deviceAutoLaunch.ts` (loaded from CLI-managed `~/.agents/.history/devices/auto-launch.json`). |
| `Agents: Resume` (batch reopen, detached-first) | Pure join + ranking: `src/core/resumePicker.ts` (`buildResumeCandidates`, `classifyResumeState`, `defaultPickedIds`); VS Code glue: `src/vscode/extension.ts` (`resumeSessionsBatch`, `openResumedSessionTerminal`). It joins the recent listing with `agents sessions --active --json` and ranks by the CLI's `viewingIn` field: `'detached'` means the tmux pane is live with NO client attached — the terminal that showed it died — which is the case the command exists for, so those sort first and open pre-ticked. `presence` (`background`/`parked`) is the *deliberate* detach axis and is ranked below it; a session someone is actively watching sorts last. Two traps: `sessions` has NO `list` subcommand (passing one silently searches for the word and returns nothing — the bug that made every picker report "No sessions found"), and `viewingIn` only exists in the JSON from agents-cli ≥ the release that added `viewingInLabel` — an older CLI reports every session as watched/idle. |
| Terminal registry + session IDs | `src/vscode/terminals.vscode.ts` |
| Offloaded (`--host`) tabs — session id, title, resume | A remote tab is registered exactly like a local one: `openSingleAgent` mints the Claude session id for local AND remote (`agents run --host` adopts it via the CLI's `resolveHostSessionId`), and stamps the device on `EditorTerminal.host` (persisted in `src/core/sessions.persist.ts`, restored on reload and on Reopen Last Session). Anything that reads the session then has to follow that host: the label poller routes to `fetchRemoteSessionLabelSource` (`src/vscode/remoteSessions.vscode.ts` → `agents sessions <id> --host <device> --json`, parsed by `parseSessionLabelSource` in `src/core/remoteSessions.ts`) because the transcript is not on this machine, and resume goes through `buildVersionedResumeCommand(..., host)` (`src/core/prewarm.ts`) which emits `agents run --host … --resume` instead of a local `claude -r <id>`. **The live-session-id refresh follows the same rule**: `tryHydrateLiveSessionId` returns immediately for a tab with `host` set, because `liveSessionIdForShell` (`src/core/liveSession.ts`) inspects the LOCAL pid tree — for an offloaded tab that is the ssh client, and the hook's `<pid>.json` files are keyed by pid alone and pruned only when the pid is dead, so a recycled pid silently binds the tab to a stranger's session (a remote tab once displayed a 20-day-old synthetic run's id and version). A local tab passes `EditorTerminal.createdAt` into that lookup so a record predating the tab is rejected. The join key for asking a device "which session is MY tab running?" is `AGENT_TERMINAL_ID`, forwarded across the SSH hop by `withActorEnv` (`apps/cli/src/lib/hosts/dispatch.ts`) and surfaced per row as `terminalId` in `agents sessions --active --json`. |
| Fork a session (`Agents: Fork`, `Agents: Fork (Pick Session)`) | `Agents: Fork` (command id `agents.forkCurrentSession`) forks the ACTIVE tab: `buildForkSessionRequest` (`src/core/forkSession.ts`) turns the terminal's session id + harness + device into a sibling launch queued with `/continue <id>`. `Agents: Fork (Pick Session)` (`agents.forkPickSession`) forks a session you BROWSE for instead — `pickSessionToFork` in `src/vscode/extension.ts` renders one QuickPick over `agents sessions --all -n 60 --json` (plus `--host <device>` when its title-bar button switches machine), with the one-device row model in `src/core/sessionBrowser.ts`. `forkHostForSession` maps the row's resolved machine to the launch's `--host`; an untagged row falls back to the device the user explicitly browsed, or this machine for the default listing. Ordinary remote launches pass the local workspace through portable `--cwd` so agents-cli can re-root `/Users/...` for the target. A picked remote historical session instead launches through `agents run --host <device> --remote-cwd <session cwd>` (`openSingleAgentWithQueue`'s `remoteCwd`) because that cwd is already exact on the transcript's device. |
| Terminal readiness events (tabReady, shellReady, promptReady, agentReady) | `src/core/terminalReadiness.ts`, `src/vscode/terminalReadiness.ts` (design doc: `swarmify/docs/01-terminal-lifecycle.md`) |
| Reconnect resilience (survive SSH drops; re-attach detached tmux agents) | `src/vscode/reconnect.ts` (scan/backoff/pass), `src/vscode/tmux.ts` (`cleanupTmuxTerminal` returns the detach-vs-exit classification, `queryTmuxSessionState` — `probeFailed` when no tmux binary is reachable so `shouldKillOnClose` fails safe and never kills an unconfirmable session, `reattachTmuxTerminal`), `src/vscode/extension.ts` (`registerReconnect` wiring, `reattachSession`; ONE `onDidCloseTerminal` handler owns both the tmux kill and the un-track/persist decision — on a live detach it calls `terminals.markDetached` to keep the entry + mapping for the pass instead of unregistering it; `restoreAgentTerminals` SKIPS tmux-backed sessions on reload — they belong to the reconnect pass, not the resume-from-session-file path — and preserves their mapping via `terminals.saveOnlyTmuxPersistedSessions`). Durable map: `src/core/sessions.persist.ts` (tmux fields); detached entries keep their coords in `EditorTerminal.tmuxCoords`. Grid unfreeze: `settings.resumeFloorPolling()` |
| Shell adoption (SH tab running an agent CLI → re-registered as that agent) | `src/vscode/terminalReadiness.ts` (`armShellAdoption`), `src/vscode/terminals.vscode.ts` (`adoptShellAsAgent`), `src/vscode/extension.ts` (`armShellAdoptionForTerminal`). Pure args parser: `src/core/terminalReadiness.ts` (`detectAgentKeyFromArgs`, `extractSessionIdFromArgs`). Diag log: `~/.cache/swarmify/shell-adoption.log` |
| Settings shape + defaults | `src/core/settings.ts` (AgentSettings interface) |
| Agent metadata (titles, prefixes, icons) | `src/core/agents.ts` (`BUILT_IN_AGENTS`, presentation overlay) + `src/core/agents.cli.ts` (CLI registry snapshot — id set, launch binaries) |
| Live session state (activity, waiting, tok/s) | the CLI payload: `agents sessions --active --json` via `src/vscode/remoteSessions.vscode.ts` (`fetchLocalSessions`), normalized in `src/core/remoteSessions.ts`. Per-line panel feed parsing only: `src/core/session.activity.ts` |
| Approval-waiting notifications (RUSH-2039) | Edge-triggered VS Code `showInformationMessage` + "Focus terminal" when a session (Codex included, via the CLI's `PermissionRequest` feed hook) enters `waitingForInput`. Pure edge logic: `src/core/waitingNotifier.ts` (`detectNewlyWaiting`); VS Code surface: `src/vscode/waitingNotifier.vscode.ts` (`notifyNewlyWaiting`), driven from `pushFloorUpdate` in `src/vscode/settings.vscode.ts`. Reveal by session: `terminals.getBySessionId`. |
| Prewarming pool | `src/core/prewarm.ts`, `src/vscode/prewarm.vscode.ts` |
| Autogit | `src/core/git.ts`, `src/vscode/git.vscode.ts` |
| Unified task aggregation (markdown / Linear / GitHub) | `src/core/tasks.ts`, `src/vscode/tasks.vscode.ts` |
| Handoff across agents | `src/core/handoff.ts` |
| Custom .md editor (TipTap) | `src/vscode/customEditor.ts`, `/ui/editor/extensions/` |
| Teams integration | `src/vscode/swarm.vscode.ts`, `src/core/swarm.detect.ts` |
| Watchdog MCP bridge (`send_nudge`, `send_to_agent`) | `src/mcp/watchdog-server.ts`, `src/mcp/watchdog-bridge.ts`, `src/mcp/watchdogInstall.ts`. Unix socket `~/.agents/.tmp/watchdog.sock`. Logs `~/.agents/.cache/logs/watchdog.log`, `~/.agents/peer-messages.log`. On-demand peer-nudge path (a peer explicitly messages another), NOT an autonomous nudger. |
| Watchdog version auto-rotate + read-only status card | `src/vscode/watchdog.vscode.ts` (`startWatchdog` — polls agent terminals on `agents.watchdog.tickSeconds` and, when the account a Claude terminal is running on is exhausted, rotates it to the best signed-in one via `rotateTerminalToBestVersion` in `extension.ts`, recording a `rotate` event). Two things the gate depends on: it reads `rotatableVersionOf` (`src/core/resumeInBest.ts`) — the pin when there is one, else the version observed running — because launches no longer pin, so a gate reading only the pin skipped every terminal and left this dead; and it is scoped to the terminal's device, since account headroom is per machine — `agents view --host <device>` for the check (view cache keyed `agent@host`), `buildHostLaunchCommand` for the replacement, so a rotate never quietly moves an offloaded agent onto this box. **The extension no longer runs its own stall-detection/nudge injector** — the agents-cli daemon watchdog is the sole injector and writes the same `~/.agents/.cache/logs/watchdog.log` JSONL (shape: `src/core/watchdogLog.ts`) that the Factory Floor status card renders read-only (`src/vscode/settings.vscode.ts`, `case 'getWatchdogLog'`). Machine-wide `agents view --json` broadcast lane (feeds LOCAL auto-rotate only): `src/monitor/watchdogDetector.ts`. |
| Factory Floor (dashboard, dispatch) | `ui/settings/components/mission-control/` |
| Cloud dispatch resolver (label parsing, repo/owner) | `ui/settings/components/mission-control/dispatch.ts` + `src/vscode/settings.vscode.ts` (`case 'dispatchTask'`) |
| Foreman voice orb (OpenAI Realtime, mic + speaker pipeline) | `src/vscode/foreman.audio.ts` (audio I/O via ffmpeg/ffplay, mic-gated during TTS to prevent echo loop), `src/vscode/foreman.vscode.ts` (session + tools), `ui/settings/components/foreman/ForemanOrb.tsx` (UI) |

## Keybindings

The canonical list is `package.json` → `contributes.keybindings`. Read it there; don't let this doc drift.

## Non-obvious gotchas worth knowing before you edit

Terminal tracking spans two worlds (VS Code API + an internal map that can go stale across restarts) — always cross-check `vscode.window.terminals` when reconciling. Three name formats for agent types live in different layers (UI/config/prefix); `src/core/utils.ts` is the reference. Webviews need `retainContextWhenHidden: true` or they reload on focus loss. `vscode.Terminal.iconPath` and `name` are frozen at `createTerminal()` time — there is no setter, which is why shell-adoption swaps the internal `agentConfig` but the tab chip keeps reading `SH`. Every spawned terminal carries `AGENT_TERMINAL_ID` (the extension reads it back from `creationOptions.env` to identify the tab), so it can't distinguish an agent CLI from a user shell — `buildAgentTerminalEnv` (`src/core/terminals.ts`) also exports `AGENT_TERMINAL_KIND` (`agent` | `shell`) for exactly that: a user's rc file gates its agent fast-path on `KIND != shell` so a bare `SH` tab still loads its full interactive env. Pass `{ kind: 'shell' }` for shell tabs. Beyond that, read the code — the mechanics change faster than this file should.
