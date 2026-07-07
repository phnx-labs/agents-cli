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
| Terminal registry + session IDs | `src/vscode/terminals.vscode.ts` |
| Terminal readiness events (tabReady, shellReady, promptReady, agentReady) | `src/core/terminalReadiness.ts`, `src/vscode/terminalReadiness.ts` (design doc: `swarmify/docs/01-terminal-lifecycle.md`) |
| Shell adoption (SH tab running an agent CLI → re-registered as that agent) | `src/vscode/terminalReadiness.ts` (`armShellAdoption`), `src/vscode/terminals.vscode.ts` (`adoptShellAsAgent`), `src/vscode/extension.ts` (`armShellAdoptionForTerminal`). Pure args parser: `src/core/terminalReadiness.ts` (`detectAgentKeyFromArgs`, `extractSessionIdFromArgs`). Diag log: `~/.cache/swarmify/shell-adoption.log` |
| Settings shape + defaults | `src/core/settings.ts` (AgentSettings interface) |
| Agent metadata (titles, prefixes, icons) | `src/core/agents.ts` (`BUILT_IN_AGENTS`) |
| Session activity parsing (per-agent formats) | `src/core/session.activity.ts` |
| Prewarming pool | `src/core/prewarm.ts`, `src/vscode/prewarm.vscode.ts` |
| Autogit | `src/core/git.ts`, `src/vscode/git.vscode.ts` |
| Unified task aggregation (markdown / Linear / GitHub) | `src/core/tasks.ts`, `src/vscode/tasks.vscode.ts` |
| Handoff across agents | `src/core/handoff.ts` |
| Custom .md editor (TipTap) | `src/vscode/customEditor.ts`, `/ui/editor/extensions/` |
| Swarm MCP integration | `src/vscode/swarm.vscode.ts`, `src/core/swarm.detect.ts` |
| Watchdog MCP bridge (`send_nudge`, `send_to_agent`) | `src/mcp/watchdog-server.ts`, `src/mcp/watchdog-bridge.ts`, `src/mcp/watchdogInstall.ts`. Unix socket `~/.agents/.tmp/watchdog.sock`. Logs `~/.agents/watchdog.log`, `~/.agents/peer-messages.log`. |
| Factory Floor (dashboard, dispatch) | `ui/settings/components/mission-control/` |
| Cloud dispatch resolver (label parsing, repo/owner) | `ui/settings/components/mission-control/dispatch.ts` + `src/vscode/settings.vscode.ts` (`case 'dispatchTask'`) |
| Foreman voice orb (OpenAI Realtime, mic + speaker pipeline) | `src/vscode/foreman.audio.ts` (audio I/O via ffmpeg/ffplay, mic-gated during TTS to prevent echo loop), `src/vscode/foreman.vscode.ts` (session + tools), `ui/settings/components/foreman/ForemanOrb.tsx` (UI) |

## Keybindings

The canonical list is `package.json` → `contributes.keybindings`. Read it there; don't let this doc drift.

## Non-obvious gotchas worth knowing before you edit

Terminal tracking spans two worlds (VS Code API + an internal map that can go stale across restarts) — always cross-check `vscode.window.terminals` when reconciling. Three name formats for agent types live in different layers (UI/config/prefix); `src/core/utils.ts` is the reference. Webviews need `retainContextWhenHidden: true` or they reload on focus loss. `vscode.Terminal.iconPath` and `name` are frozen at `createTerminal()` time — there is no setter, which is why shell-adoption swaps the internal `agentConfig` but the tab chip keeps reading `SH`. Beyond that, read the code — the mechanics change faster than this file should.
