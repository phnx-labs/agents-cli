# Agents Extension

VS Code extension for multi-agent coding. Spawns AI terminals (Claude, Codex, Gemini, Cursor, OpenCode) as editor tabs with keyboard shortcuts, and dispatches work to Rush Cloud.

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

## Building + Testing

```bash
bun run compile   # tsc + vite build for both webviews
bun test          # Full test suite, no mocks
bash scripts/install.sh <version>   # Package .vsix and install to Cursor + Code + Codium
```

## Areas (and where to look)

| Area | Start here |
|---|---|
| Agent spawn flow + editor-tab terminals | `src/vscode/extension.ts` (`openSingleAgent`, `openSingleAgentWithQueue`) |
| Smart `New Agent` (⌘⇧A) type selection | `src/core/agentUsage.ts` (`rankAgentsByUsage` / `pickAgentByUsage` — pure, last-24h-weighted usage aggregation over `RemoteSession[]`) wired in `src/vscode/extension.ts` (`agents.newAgent` command: fleet-wide `fetchRecapSessions` → pick type → `--strategy balanced` + `resolveBalancedHost`) |
| Terminal registry + session IDs | `src/vscode/terminals.vscode.ts` |
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
| Watchdog version auto-rotate + read-only status card | `src/vscode/watchdog.vscode.ts` (`startWatchdog` — polls agent terminals on `agents.watchdog.tickSeconds` and, on version exhaustion, rotates a version-pinned Claude terminal to the best signed-in version via `rotateTerminalToBestVersion` in `extension.ts`, recording a `rotate` event). **The extension no longer runs its own stall-detection/nudge injector** — the agents-cli daemon watchdog is the sole injector and writes the same `~/.agents/.cache/logs/watchdog.log` JSONL (shape: `src/core/watchdogLog.ts`) that the Factory Floor status card renders read-only (`src/vscode/settings.vscode.ts`, `case 'getWatchdogLog'`). Machine-wide `agents view --json` broadcast lane (feeds auto-rotate): `src/monitor/watchdogDetector.ts`. |
| Factory Floor (dashboard, dispatch) | `ui/settings/components/mission-control/` |
| Cloud dispatch resolver (label parsing, repo/owner) | `ui/settings/components/mission-control/dispatch.ts` + `src/vscode/settings.vscode.ts` (`case 'dispatchTask'`) |
| Foreman voice orb (OpenAI Realtime, mic + speaker pipeline) | `src/vscode/foreman.audio.ts` (audio I/O via ffmpeg/ffplay, mic-gated during TTS to prevent echo loop), `src/vscode/foreman.vscode.ts` (session + tools), `ui/settings/components/foreman/ForemanOrb.tsx` (UI) |

## Keybindings

The canonical list is `package.json` → `contributes.keybindings`. Read it there; don't let this doc drift.

## Non-obvious gotchas worth knowing before you edit

Terminal tracking spans two worlds (VS Code API + an internal map that can go stale across restarts) — always cross-check `vscode.window.terminals` when reconciling. Three name formats for agent types live in different layers (UI/config/prefix); `src/core/utils.ts` is the reference. Webviews need `retainContextWhenHidden: true` or they reload on focus loss. `vscode.Terminal.iconPath` and `name` are frozen at `createTerminal()` time — there is no setter, which is why shell-adoption swaps the internal `agentConfig` but the tab chip keeps reading `SH`. Every spawned terminal carries `AGENT_TERMINAL_ID` (the extension reads it back from `creationOptions.env` to identify the tab), so it can't distinguish an agent CLI from a user shell — `buildAgentTerminalEnv` (`src/core/terminals.ts`) also exports `AGENT_TERMINAL_KIND` (`agent` | `shell`) for exactly that: a user's rc file gates its agent fast-path on `KIND != shell` so a bare `SH` tab still loads its full interactive env. Pass `{ kind: 'shell' }` for shell tabs. Beyond that, read the code — the mechanics change faster than this file should.
