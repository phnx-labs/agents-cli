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

## Launch contract (normative — the reviewer enforces this)

**Every agent runner Factory launches goes through `agents run <agent>
--interactive --strategy balanced --mode auto`. Always. No per-harness exception,
no bare command.** There is exactly one non-runner (`shell` — a plain terminal, not
an `agents run` agent) and exactly one legitimate flag omission (a pinned
`@version`, which the CLI ignores `--strategy` against — and Factory never pins on a
New launch, so in practice the flags are always present).

Two invariants, no exceptions:

- **`--strategy balanced` is always emitted.** Balanced account/version rotation
  spreads load and never launches into a throttled or arbitrarily-pinned account.
  A bare, strategy-less launch is never what we want. `--strategy balanced` is a
  graceful no-op for a runner with no accounts to rotate (e.g. droid) — the CLI
  falls back to the default, never errors (`apps/cli/src/lib/rotate.ts`
  `selectBalancedVersion`, `apps/cli/src/commands/exec.ts` strategy block) — so it
  is always safe to emit.
- **`--mode auto` is always emitted** for interactive New launches, so the agent
  starts writable-but-gated and can edit files without stalling on plan approval.

There are exactly three New-agent variants per harness, and **all three emit the
same flags — only host selection differs** (`launchAgent` in
`src/vscode/extension.ts`):

| Command | `launchAgent` opts | Host selector | Full command |
|---|---|---|---|
| `Agents: New X` | `{ agentKey, local: true }` | *(none — this machine)* | `agents run X --interactive --strategy balanced --mode auto` |
| `Agents: New X (Auto)` | `{ agentKey, autoHost: true }` | `--device auto` | `agents run X --interactive --device auto --strategy balanced --mode auto` |
| `Agents: New X (Pick Host)` | `{ agentKey, pickHost: true }` | `--host '<device>'` | `agents run X --interactive --host '<device>' --strategy balanced --mode auto` |

Claude alone adds `--session-id <id>` (minted up front for the resume/fork flow);
that is the only per-agent addition and it never removes a flag. A **fork**
(`strategyForForkAgent`) starts a fresh sibling session, so it is balanced by the
same rule. **Resume is out of scope** — `--resume <id>` reattaches to a session
whose account is already bound, so it reuses that account and carries no
`--strategy` (`buildVersionedResumeCommand` in `src/core/prewarm.ts`).

**There is no allowlist.** The single source of truth is `isAgentRunner(key)`
(`src/core/agents.ts`) = `key !== 'shell'`, consumed by `usesManagedAgentLaunch`
(routing), `launchAgent`/`openSingleAgent` (strategy + routing), and
`strategyForForkAgent`. Do not reintroduce a per-harness set (the retired
`STRATEGY_LAUNCH_AGENTS` / `LAUNCHABLE` lists disagreed with each other and left
local grok/kimi/droid launching as raw binaries with no rotation and no mode).
Adding a harness that is a real `agents run` agent needs no launch-code change; it
inherits the contract. Tests pin it in `src/core/agents.test.ts`
(`describe('launch contract — every runner is balanced')`).

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
| The ONE launch engine (every "New agent" command) | `launchAgent(context, {agentKey?, host?, pickHost?, local?})` in `src/vscode/extension.ts` is the single route. It resolves: **host** (explicit / device-first `pickLaunchHost` / auto `resolveBalancedHost`), **harness** (explicit, or `resolveAutoAgentKey` — usable-on-the-chosen-host via `hostHasUsableVersion`, ranked by `pickAgentByUsage`), and **version/account** (ALWAYS balanced via `--strategy balanced` for every runner — the [Launch contract](#launch-contract-normative--the-reviewer-enforces-this); no pinned/latest/version-picker path exists). Commands are thin: `agents.newAgent` = `launchAgent({})` (auto everything), `agents.newAgentPickHost` = `{pickHost:true}` (device-first, auto harness), and per harness `agents.new<Harness>` = `{agentKey, local:true}`, `…PickHost` = `{agentKey, pickHost:true}`, `…Auto` = `{agentKey, autoHost:true}`. Routing + strategy hang off one predicate, `isAgentRunner(key)` (`src/core/agents.ts`) — `key !== 'shell'` — NOT a per-harness allowlist. Pure ranking: `src/core/launchHost.ts` (`pickBestHost`, `deviceHasUsableVersion`, `resolveBalancePool`) + `src/core/agentUsage.ts` (`pickAgentByUsage`). Health probe: `src/vscode/deviceHealth.vscode.ts` (`fetchDeviceStats`). Auto-launch filtering/bias: `src/core/deviceAutoLaunch.ts` (loaded from CLI-managed `~/.agents/.history/devices/auto-launch.json`). **The host picker is stale-while-revalidate, in two phases**: it renders instantly from a persisted snapshot (`src/core/hostPickerCache.ts`, `globalState` key `agents.hostPicker.v1`) and revalidates in the background, swapping items in place — never block a picker on the fleet SSH sweep. The refresh is split (`refreshHostPickerDevices` — cheap `devices list` registry read — then `sweepHostPickerUsage` — the fleet fan-out): device rows come from the cheap phase so they never wait on the usage sweep, and the device snapshot is warmed at activation (`refreshHostPickerDevicesInBackground`) so even the first open is populated. The usage sweep stays lazy (the 60s prewarm is gated on `hostPickerUsed`). Both phases fold through `mergeHostPickerSnapshot`, which (a) keeps the last-good rows when a registry read comes back empty — a failed read on a loaded box, never a real empty fleet — and (b) tracks TWO timestamps: `fetchedAt` (device rows) and `usageFetchedAt` (the sweep). `isHostPickerStale` gates on `usageFetchedAt`, so the cheap device-only refresh (which carries the old `usageFetchedAt` forward) never masks stale usage scores as fresh and skips the sweep. |
| `Agents: Resume` (batch reopen, detached-first) | Pure join + ranking: `src/core/resumePicker.ts` (`buildResumeCandidates`, `classifyResumeState`, `defaultPickedIds`); VS Code glue: `src/vscode/extension.ts` (`resumeSessionsBatch`, `openResumedSessionTerminal`). It joins the recent listing with `agents sessions --active --json` and ranks by the CLI's `viewingIn` field: `'detached'` means the tmux pane is live with NO client attached — the terminal that showed it died — which is the case the command exists for, so those sort first and open pre-ticked. `presence` (`background`/`parked`) is the *deliberate* detach axis and is ranked below it; a session someone is actively watching sorts last. Two traps: `sessions` has NO `list` subcommand (passing one silently searches for the word and returns nothing — the bug that made every picker report "No sessions found"), and `viewingIn` only exists in the JSON from agents-cli ≥ the release that added `viewingInLabel` — an older CLI reports every session as watched/idle. |
| Resume variants — `(Pick Session)`, `(Pick Host)`, `(Pick Harness)`, `(Best Profile)` | One QuickPick per axis. `(Pick Session)` is `resumeSessionsBatch({abandonedOnly:true})` — `abandonedCandidates` (`src/core/resumePicker.ts`) drops `watched` sessions, the pick resumes on its origin host; the picker cache stays unfiltered so both pickers share `agents.resumePicker.v1`. `(Pick Host)` reopens the ACTIVE tab's session via `pickLaunchHost` + the existing `buildVersionedResumeCommand(..., host)` path, same harness and pinned version. `(Pick Harness)` (`resumeCurrentPickHarness` → `launchResumeInHarness`) launches `agents run <harness> --interactive` unpinned (balanced picks the account) on the same device and replays the old transcript through `buildResumeInput` — native `--resume` can't cross harnesses. Harness ranking: `buildHarnessOptions` (`src/core/resumeTarget.ts`); launch builder: `buildAgentRunLaunchCommand` (`src/core/resumeInBest.ts`). `(Best Profile)` is the retitled rotate (`agents.resumeCurrentInBestProfile`, ⌘⇧J). |
| Terminal registry + session IDs | `src/vscode/terminals.vscode.ts` |
| Offloaded (`--host`) tabs — session id, title, resume | A remote tab is registered exactly like a local one: `openSingleAgent` mints the Claude session id for local AND remote (`agents run --host` adopts it via the CLI's `resolveHostSessionId`), and stamps the device on `EditorTerminal.host` (persisted in `src/core/sessions.persist.ts`, restored on reload and on Reopen Last Session). Anything that reads the session then has to follow that host: the label poller routes to `fetchRemoteSessionLabelSource` (`src/vscode/remoteSessions.vscode.ts` → `agents sessions <id> --host <device> --json`, parsed by `parseSessionLabelSource` in `src/core/remoteSessions.ts`) because the transcript is not on this machine, and resume goes through `buildVersionedResumeCommand(..., host)` (`src/core/prewarm.ts`) which emits `agents run --host … --resume` instead of a local `claude -r <id>`. **The live-session-id refresh follows the same rule**: `tryHydrateLiveSessionId` returns immediately for a tab with `host` set, because `liveSessionIdForShell` (`src/core/liveSession.ts`) inspects the LOCAL pid tree — for an offloaded tab that is the ssh client, and the hook's `<pid>.json` files are keyed by pid alone and pruned only when the pid is dead, so a recycled pid silently binds the tab to a stranger's session (a remote tab once displayed a 20-day-old synthetic run's id and version). A local tab passes `EditorTerminal.createdAt` into that lookup so a record predating the tab is rejected. The join key for asking a device "which session is MY tab running?" is `AGENT_TERMINAL_ID`, forwarded across the SSH hop by `withActorEnv` (`apps/cli/src/lib/hosts/dispatch.ts`) and surfaced per row as `terminalId` in `agents sessions --active --json`. |
| Fork a session (`Agents: Fork`, `Agents: Fork (Pick Host)`, `Agents: Fork (Pick Session)`, `Agents: Fork (Recap)`) | `Agents: Fork` (command id `agents.forkCurrentSession`) forks the ACTIVE tab: `buildForkSessionRequest` (`src/core/forkSession.ts`) turns the terminal's session id + harness + device into a sibling launch queued with `/continue <id>`. `Agents: Fork (Pick Host)` (`agents.forkPickHost`) is the same fork with the DEVICE chosen first — `pickLaunchHost`, the same picker the `New <Agent> (Pick Host)` commands use — and everything else deliberately held constant: same harness, same `--strategy balanced` account rotation, only the machine moves. Two things follow from moving it. The prompt gains a `--device <source machine>` suffix, because a single-id lookup does NOT fan out (`agents sessions <id>` answers "No session with id … on this machine") and the transcript stays where it was written; and the tab opens with `viewColumn: Active` — a normal full tab in the active group, NOT a side split (a fork is a fresh sibling session, not a pane to wedge beside its parent). The pair is written to the fork-lineage store (`src/core/forkLineage.ts`, `globalState` key `agents.forkLineage.v1`, newest-60 cap) — a fork shares no id with its parent, so without that edge the two are unrelated rows forever. A harness that mints its id post-spawn is watched for up to a minute (`recordFork` in `extension.ts`) before the edge is written idless. The Recap ledger joins on it: `buildRecap` (`ui/settings/components/mission-control/recapModel.ts`) marks the fork and, when the parent finished on the SAME day, folds them into one side-by-side `recap-pair` row (`RecapPane.tsx`); day rollups are counted before pairing so the numbers still describe both sessions, and a cross-day parent keeps its own row rather than rewriting a past day. `Agents: Fork (Pick Session)` (`agents.forkPickSession`) forks a session you BROWSE for instead — `pickSessionToFork` in `src/vscode/extension.ts` renders one QuickPick over `agents sessions --all -n 60 --json` (plus `--host <device>` when its title-bar button switches machine), with the one-device row model in `src/core/sessionBrowser.ts`. `forkHostForSession` maps the row's resolved machine to the launch's `--host`; an untagged row falls back to the device the user explicitly browsed, or this machine for the default listing. `Agents: Fork (Recap)` (`agents.forkRecap`) reuses that exact browser and launch request, but queues `/recap <full-id>` in the new sibling instead of `/continue`. The public `.agents-system` command resolves and reads the selected history through an isolated read-only subagent; Factory never fetches or injects a transcript, resumes the source, or reuses its session id. Ordinary remote launches pass the local workspace through portable `--cwd` so agents-cli can re-root `/Users/...` for the target. A picked remote historical session instead launches through `agents run --host <device> --remote-cwd <session cwd>` (`openSingleAgentWithQueue`'s `remoteCwd`) because that cwd is already exact on the transcript's device. |
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
| Watchdog surface (NO loop — endpoint + status card only) | **The extension holds no watchdog loop.** The agents-cli daemon watchdog (`agents watchdog enable`, under `agents __daemon-run`) is the sole watchdog: stall nudging AND rotate-on-exhaustion (it injects the exit sequence + `agents run auto --interactive` + the /continue replay into vscodium tabs IN THE SAME TAB via the extension's `/inject` URI verb over live-terminals.json), and writes the shared `~/.agents/.cache/logs/watchdog.log` JSONL (shape: `src/core/watchdogLog.ts`) — including `rotate` / `rotate-skip` events — that the Factory Floor status card renders read-only (`src/vscode/settings.vscode.ts`, `case 'getWatchdogLog'`; the panel's enable toggle is backed by `agents watchdog status|enable|disable`). What remains in the extension (`src/vscode/watchdog.vscode.ts`): the `/inject` rail's counterpart stays in `extension.ts`; the palette on/off `Agents: Watchdog (Enable)` / `Agents: Watchdog (Disable)` (shell out to `agents watchdog enable|disable` via execFile argv, no shell string); the one-time migration of a deleted `agents.watchdog.autoRotate: false` to the CLI watchdog's off state (globalState-guarded, `migrateAutoRotateSettingOnce`); and the playbook-file scaffold the settings panel still surfaces. Deleted with the loop: `startWatchdog`/tick, the no-healthy suppression, `src/core/autoRotate.ts`, `rotateTerminalToBestVersion`/`RotateOutcome`, the `agents.watchdog.*` settings, and the dormant monitor watchdog broadcast lane (`src/monitor/watchdogDetector.ts`, follower `setWatchdogWatches`, the `watchdog-watch`/`watchdog-versions` protocol types). Manual resume commands keep working: `Agents: Resume in Best Profile` launches `agents run auto` via the shared `launchResumeTerminal` (`buildAutoRunLaunchCommand` in `src/core/resumeInBest.ts`). |
| Factory Floor (dashboard, dispatch) | `ui/settings/components/mission-control/` |
| Cloud dispatch resolver (label parsing, repo/owner) | `ui/settings/components/mission-control/dispatch.ts` + `src/vscode/settings.vscode.ts` (`case 'dispatchTask'`) |
| Foreman voice orb (OpenAI Realtime, mic + speaker pipeline) | `src/vscode/foreman.audio.ts` (audio I/O via ffmpeg/ffplay, mic-gated during TTS to prevent echo loop), `src/vscode/foreman.vscode.ts` (session + tools), `ui/settings/components/foreman/ForemanOrb.tsx` (UI) |

## Keybindings

The canonical list is `package.json` → `contributes.keybindings`. Read it there; don't let this doc drift.

## Non-obvious gotchas worth knowing before you edit

Terminal tracking spans two worlds (VS Code API + an internal map that can go stale across restarts) — always cross-check `vscode.window.terminals` when reconciling. Three name formats for agent types live in different layers (UI/config/prefix); `src/core/utils.ts` is the reference. Webviews need `retainContextWhenHidden: true` or they reload on focus loss. `vscode.Terminal.iconPath` and `name` are frozen at `createTerminal()` time — there is no setter, which is why shell-adoption swaps the internal `agentConfig` but the tab chip keeps reading `SH`. Every spawned terminal carries `AGENT_TERMINAL_ID` (the extension reads it back from `creationOptions.env` to identify the tab), so it can't distinguish an agent CLI from a user shell — `buildAgentTerminalEnv` (`src/core/terminals.ts`) also exports `AGENT_TERMINAL_KIND` (`agent` | `shell`) for exactly that: a user's rc file gates its agent fast-path on `KIND != shell` so a bare `SH` tab still loads its full interactive env. Pass `{ kind: 'shell' }` for shell tabs. Beyond that, read the code — the mechanics change faster than this file should.
