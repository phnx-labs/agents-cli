# Agents Extension

VS Code extension for multi-agent coding. Spawns AI terminals (Claude, Codex, Antigravity, Cursor, OpenCode) as editor tabs with keyboard shortcuts, and dispatches work to Rush Cloud.

This file is a **map**, not the territory. Keep it a short paragraph per area plus pointers. Read the actual code for current details.

## Layout

```
/src/core       Pure functions (no VS Code dependencies; unit-tested here)
/src/vscode     VS Code integration (commands, webviews, terminal tracking)
/ui/settings    Dashboard webview (React + Vite) — includes Fleet
/ui/editor      Custom markdown editor components
/assets         Icons (agent logos, rush bird, etc.)
/tests          Real-service tests (no mocks)
```

## Launch contract (normative — the reviewer enforces this)

**Every agent runner AGI EXT launches goes through `agents run <agent>
--interactive --strategy balanced --mode auto`. Always. No per-harness exception,
no bare command.** There is exactly one non-runner (`shell` — a plain terminal, not
an `agents run` agent) and exactly one legitimate flag omission (a pinned
`@version`, which the CLI ignores `--strategy` against — and AGI EXT never pins on a
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
| `Agents: New X (Auto)` | `{ agentKey, autoHost: true }` | `--host '<device>'` (resolved) | `agents run X --interactive --host '<device>' --strategy balanced --mode auto` |
| `Agents: New X (Pick Host)` | `{ agentKey, pickHost: true }` | `--host '<device>'` | `agents run X --interactive --host '<device>' --strategy balanced --mode auto` |

`(Auto)` resolves that device itself (it does NOT hand `--device auto` to the
CLI): first from the warm health-cache snapshot (`resolveCachedAutoHost` →
`pickCachedLaunchHost`), and — when that cache is cold or >5min stale — it falls
through to the same live, favorites-aware fleet sweep the default New-agent path
uses (`resolveBalancedHost`), honoring enable/prefer and dropping hosts with no
usable version. It runs local only when no fleet device is genuinely eligible; a
cold cache no longer silently pins the launch to this Mac (`launchAgent`).

Claude alone adds `--session-id <id>` (minted up front for the resume/fork flow);
that is the only per-agent addition and it never removes a flag. A **fork**
(`strategyForForkAgent`) starts a fresh sibling session, so it is balanced by the
same rule.

**Resume is also unified:** every resumed session — local, offloaded, or
picked-host — goes through `agents run <agent> --interactive --resume <id>`,
with `--host '<device>'` appended when the transcript lives on another machine.
`agents run --resume` resumes under the version that started the session, so
AGI EXT never emits a per-harness raw binary (`claude -r`, `codex resume`,
`cursor-agent --resume=`, etc.). The single source for resume command
construction is `buildVersionedResumeCommand` in `src/core/prewarm.ts`.

**There is no allowlist.** The single source of truth is `isAgentRunner(key)`
(`src/core/agents.ts`) = `key !== 'shell'`, consumed by `usesManagedAgentLaunch`
(routing), `launchAgent`/`openSingleAgent` (strategy + routing), and
`strategyForForkAgent`. Do not reintroduce a per-harness set (the retired
`STRATEGY_LAUNCH_AGENTS` / `LAUNCHABLE` lists disagreed with each other and left
local grok/kimi/droid launching as raw binaries with no rotation and no mode).
Adding a harness that is a real `agents run` agent needs no launch-code change; it
inherits the contract. Tests pin it in `src/core/agents.test.ts`
(`describe('launch contract — every runner is balanced')`).

## Thin wrapper — no second scheduler (normative — the reviewer enforces this)

**AGI EXT is a consumer, never a scheduler.** Anything that can *act* on this
machine or a fleet device — spawn, resume, kill, inject, dispatch, rotate, fire a
routine — is scheduled and executed by the agents-cli daemon or a CLI command, per
the root `AGENTS.md` invariant and the normative contract in
[`apps/cli/docs/specifications.md` §Scheduling & execution singularity](../cli/docs/specifications.md#scheduling--execution-singularity).

Rules for this package:

- **No `setInterval` / watcher / loop that acts.** Polling for rendering (panel
  refresh, presence heartbeat, read-side caches) is fine; a timer whose callback
  spawns, injects, kills, or fires is a double-fire bug in waiting and does not
  merge. The deleted watchdog rotate loop (2026-08-03 incident, PR #1914) is the
  canonical violation.
- **Controls call the CLI.** An AGI EXT control that changes a fleet-affecting
  capability flips CLI state (`agents watchdog enable|disable|rotate`,
  `agents routines …`) via execFile argv — never a UI-local setting that gates only
  the UI's view of the action.
- **Actions on UI-owned surfaces go through endpoints the CLI drives.** The
  `/inject` URI verb over `live-terminals.json` is the precedent: the extension
  exposes the rail; the daemon decides when to use it.

## Testing the Fleet UI

The Fleet feed + Dispatch panel are a React webview (`ui/settings`, top component `UnifiedAgentsPane.tsx`). To SEE and verify UI changes, do NOT install the packaged `.vsix` and drive VS Code via accessibility automation (`osascript` / `agents computer`) to open the dashboard — that steals your focus and is slow. Use the committed preview harness, which renders the real components with representative data in a plain browser page you can screenshot:

```
cd apps/ext/ui && bun run dev
# open http://localhost:5173/settings/preview/?view=feed   (or ?view=dispatch, ?view=topbar)
#   add &theme=dark  or  &theme=light
```

`ui/settings/preview/preview.tsx` mounts the same feed + DispatchPanel the webview uses; it is excluded from the shipped bundle (`vite.settings.config.ts` only inputs `settings/index.html`). Screenshot the browser page and actually inspect the render against the intent.

Gotchas:
- A built `preview-dist/index.html` opened over `file://` renders BLANK (Chromium CORS-blocks ES-module `<script src>` over file://). Serve over http (`bun run dev`), or inline the built JS/CSS into one self-contained HTML.
- To screenshot a browser window on another macOS Space, `screencapture -o` grabs the wrong Space; use a window-targeted capture (e.g. `agents computer screenshot --bundle <id> --window-id <id>`), which is focus-safe.

For logic-only changes, `bun test` in `apps/ext/` runs the `mission-control/*.test.ts` suites (floorModel, floorAdapter, dispatch, savedViews, etc.).

## Testing extension-host logic

Extension-host behavior lives in `src/vscode/` and depends on the real `vscode` API. There are three verification paths, from cheapest to most real:

1. **Mocked unit tests** — `bun test` runs `src/vscode/*.test.ts` with `mock.module('vscode', …)`. This covers terminal tracking, session detection, reconnect resilience, etc., without installing a `.vsix`. Fast, but not a real extension host.
2. **Preview harness** — for Fleet UI verification, use the browser harness above. Do not drive a real VS Code/Cursor window for UI screenshots.
3. **Installed end-to-end on a computer-equipped remote machine** — for behavior that genuinely needs a live extension host (command registration, webview ↔ host messages, terminal lifecycle), build and install the `.vsix` on a fleet box, then drive the editor via `agents computer`:

```bash
# Run on the target host (e.g. mac-mini), or wrap with `agents ssh mac-mini "..."`
cd apps/ext
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
bun test          # Deterministic test suite; no external agent login required
bun run test:agent-integration  # Three real Claude-backed helper flows (opt-in)
bash scripts/install.sh <version>   # Package .vsix and install to Cursor + Code + Codium
```

## Device auto-launch preferences

the ext's auto-host selection reads per-device enable/prefer flags managed by the CLI (`agents devices config <name> auto-launch.enabled|auto-launch.preferred on|off`; the retired `agents devices enable|disable|prefer|unprefer <name>` forward there). The store is the central `~/.agents/agents.yaml` `fleet.devices.<name>.config` block.

- A **disabled** device is excluded from `New <Agent>` auto picks. It remains manually pickable via `New <Agent> (Pick Host)`.
- A **preferred** device gets a `PREFERENCE_BONUS` (20 pts, ≈ two running agents) shaved off its `hostScore`, so it wins ties against otherwise-equivalent machines but never outranks one that is genuinely swamped. The bonus lives in `hostScore` itself, so both ranking paths — the warm-cache pick and the balanced pool pick — apply it identically.
- Defaults: every registered device is enabled and not preferred. An unregistered name is rejected by the CLI rather than written as a dead entry.

Source of truth:
- Persistence + CLI commands: `apps/cli/src/lib/devices/registry.ts` (`loadAutoLaunchPreferences`, `setAutoLaunchEnabled`, `setAutoLaunchPreferred`) and `apps/cli/src/commands/ssh.ts`.
- Extension consumption: `apps/ext/src/core/deviceAutoLaunch.ts`.
- Filtering/bias applied: `apps/ext/src/core/launchHistory.ts` (`pickCachedLaunchHost`) and `apps/ext/src/vscode/extension.ts` (`resolveCachedAutoHost`, `resolveBalancedHost`).

## Releasing to the Marketplace

Use `scripts/release.sh` from any fleet box. It routes itself to the machine that holds the `vs-marketplace` secrets bundle (currently `zion`) and publishes from a clean clone of the commit.

```bash
cd apps/ext
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
- The deterministic release gate installs both AGI EXT dependency roots and does not require an agent login. Run `bun run test:agent-integration` separately when validating the three helper flows that invoke a real Claude session.
- The script builds and publishes to both VS Code Marketplace and Open VSX. Marketplace propagation can lag a few minutes; Open VSX is usually live immediately.
- The script installs the new `.vsix` into local VS Code / Codium windows automatically.

## Areas (and where to look)

| Area | Start here |
|---|---|
| Agent spawn flow + editor-tab terminals | `src/vscode/extension.ts` (`openSingleAgent`, `openSingleAgentWithQueue`) |
| `…/spawn` URI verb (how `agents sessions resume --vscodium` reopens a session as a tab) | Pure parse + surface choice: `src/core/spawn.ts` (`parseSpawnRequest`, `resolveSpawnSurface`); VS Code glue: `src/vscode/extension.ts` (`spawnCommandTerminal`). Uses plain native VS Code terminals only; splits create a new native tab or editor-area split. Reconnect/resume is handled by the agents CLI, not by extension-level tmux. |
| The ONE launch engine (every "New agent" command) | `launchAgent(context, {agentKey?, host?, pickHost?, local?})` in `src/vscode/extension.ts` is the single route. It resolves: **host** (explicit / device-first `pickLaunchHost` / auto `resolveBalancedHost`), **harness** (explicit, or `resolveAutoAgentKey` — usable-on-the-chosen-host via `hostHasUsableVersion`, ranked by `pickAgentByUsage`), and **version/account** (ALWAYS balanced via `--strategy balanced` for every runner — the [Launch contract](#launch-contract-normative--the-reviewer-enforces-this); no pinned/latest/version-picker path exists). Commands are thin: `agents.newAgent` = `launchAgent({})` (auto everything), `agents.newAgentPickHost` = `{pickHost:true}` (device-first, auto harness), and per harness `agents.new<Harness>` = `{agentKey, local:true}`, `…PickHost` = `{agentKey, pickHost:true}`, `…Auto` = `{agentKey, autoHost:true}`. Routing + strategy hang off one predicate, `isAgentRunner(key)` (`src/core/agents.ts`) — `key !== 'shell'` — NOT a per-harness allowlist. Pure ranking: `src/core/launchHost.ts` (`pickBestHost`, `deviceHasUsableVersion`, `resolveBalancePool`) + `src/core/agentUsage.ts` (`pickAgentByUsage`). Health probe: `src/vscode/deviceHealth.vscode.ts` (`fetchDeviceStats`). Auto-launch filtering/bias: `src/core/deviceAutoLaunch.ts` (loaded from the CLI-managed central `~/.agents/agents.yaml` `fleet.devices.<name>.config` block). **The host picker is stale-while-revalidate, in two phases**: it renders instantly from a persisted snapshot (`src/core/hostPickerCache.ts`, `globalState` key `agents.hostPicker.v1`) and revalidates in the background, swapping items in place — never block a picker on the fleet SSH sweep. The refresh is split (`refreshHostPickerDevices` — cheap `devices list` registry read — then `sweepHostPickerUsage` — the fleet fan-out): device rows come from the cheap phase so they never wait on the usage sweep, and the device snapshot is warmed at activation (`refreshHostPickerDevicesInBackground`) so even the first open is populated. The usage sweep stays lazy (the 60s prewarm is gated on `hostPickerUsed`). Both phases fold through `mergeHostPickerSnapshot`, which (a) keeps the last-good rows when a registry read comes back empty — a failed read on a loaded box, never a real empty fleet — and (b) tracks TWO timestamps: `fetchedAt` (device rows) and `usageFetchedAt` (the sweep). `isHostPickerStale` gates on `usageFetchedAt`, so the cheap device-only refresh (which carries the old `usageFetchedAt` forward) never masks stale usage scores as fresh and skips the sweep. |
| `Agents: Resume` (batch reopen, detached-first) | Pure join + ranking: `src/core/resumePicker.ts`; VS Code glue: `src/vscode/extension.ts`. It joins recent rows with `agents sessions --active --json`, treats `closed`/`crashed`/`pidAlive:false` panes as inactive, and sorts genuinely detached live panes first. No row is pre-selected; the user explicitly chooses every reopen. AGI EXT invokes only `agents sessions resume <canonical-id>` and waits for the terminal readiness signal. The CLI owns attach-vs-resume, source-device routing, harness, version, cwd, and mode. `nextPreselection` preserves only explicit checks across refreshes. Row labels remain boilerplate-stripped through `sharedTopicPrefixes` / `distinctiveTopic`. |
| Resume variants — `(Pick Session)`, `(Pick Host)`, `(Pick Harness)`, `(Best Profile)` | One QuickPick per axis. `(Pick Session)` is `resumeSessionsBatch({abandonedOnly:true})` — `abandonedCandidates` (`src/core/resumePicker.ts`) drops `watched` sessions, the pick resumes on its origin host; the picker cache stays unfiltered so both pickers share `agents.resumePicker.v1`. `(Pick Host)` reopens the ACTIVE tab's session via `pickLaunchHost` + the existing `buildVersionedResumeCommand(..., host)` path, same harness and pinned version. `(Pick Harness)` (`resumeCurrentPickHarness` → `launchResumeInHarness`) launches `agents run <harness> --interactive` unpinned (balanced picks the account) on the same device and replays the old transcript through `buildResumeInput` — native `--resume` can't cross harnesses. Harness ranking: `buildHarnessOptions` (`src/core/resumeTarget.ts`); launch builder: `buildAgentRunLaunchCommand` (`src/core/resumeInBest.ts`). `(Best Profile)` is the retitled rotate (`agents.resumeCurrentInBestProfile`, ⌘⇧J). |
| Terminal registry + session IDs | `src/vscode/terminals.vscode.ts`. A newly-created Codex tab stays idless until a rollout created after that tab is observed; only `scanExisting` marks a restored editor terminal as eligible to adopt an older same-workspace rollout (`sessionTracker.ts`). A syntactically valid UUID is not proof that a tab is mapped correctly: `tryHydrateLiveSessionId` reconciles every focused agent tab against the live pid state / `AGENT_TERMINAL_ID` map, and `planActiveMapHydration` replaces a clean-but-stale UUID when the authoritative map names a different session (RUSH-2430). |
| Offloaded (`--host` / `--device`) tabs — session id, title, resume | A remote tab is registered exactly like a local one: `openSingleAgent` mints the Claude session id for local AND remote (`agents run --host` adopts it via the CLI's `resolveHostSessionId`), and stamps the device on `EditorTerminal.host` (persisted in `src/core/sessions.persist.ts`, restored on reload and on Reopen Last Session). Anything that reads the session then has to follow that host: the label poller routes to `fetchRemoteSessionLabelSource` (`src/vscode/remoteSessions.vscode.ts` → `agents sessions <id> --host <device> --json`, parsed by `parseSessionLabelSource` in `src/core/remoteSessions.ts`) because the transcript is not on this machine, and resume goes through `buildVersionedResumeCommand(..., host)` (`src/core/prewarm.ts`) which emits `agents run --host … --resume` instead of a local `claude -r <id>`. **Live session id (status bar) for non-Claude + offload (RUSH-2192):** `tryHydrateLiveSessionId` does **not** invent ids from transcript filenames. Local agent processes still use `liveSessionIdForShell` (SessionStart state under `~/.agents/.cache/state/sessions/<pid>.json`, with recycled-pid guards). Offloaded tabs — and any tab still missing an id — join `agents sessions --active --json` (`--local` on this box, `--host <device>` for a real offload; never `--where`) on `AGENT_TERMINAL_ID` / `EditorTerminal.id`. Fetches are **one subprocess per host**, shared across all tabs on that host via `cachedInFlight` + TTL (`src/core/sessionIdHydrate.ts`: 3s local / 8s remote TTL, 5s / 10s hard timeouts). Failures leave the id blank (never a wrong id). Status bar / clipboard always show the canonical UUID (`canonicalSessionId` — strips Codex `rollout-…` stems). Downstream, version/account still gate on `displayIdentity` / `identityAppliedSessionId`. The join key across the SSH hop remains `AGENT_TERMINAL_ID`, forwarded by `withActorEnv` and surfaced as `terminalId` on `--active` rows. **Remote identity before optional labeling (RUSH-2411/RUSH-2430):** a picked-host Codex launches idless (only Claude's id is minted up front), so a bounded fast poll starts at launch even when `autoLabelInTabTitles` is disabled. It resolves the id from the shared per-host active map (`hydrateRemoteTabTick` / `planActiveMapHydration` in `src/core/remoteAutoLabel.ts`) and refreshes the active status bar. When automatic labels are enabled, `applyHydratedSessionId` also arms the host-aware label path (`agents sessions <id> --host <device> --json`) so a remote Codex goes bare `CX` → canonical UUID → topic title without a refocus. Identity never depends on that optional label preference. |
| Fork a session (`Agents: Fork`, `Agents: Fork (Pick Host)`, `Agents: Fork (Pick Session)`, `Agents: Fork (Recap)`) | `Agents: Fork` (command id `agents.forkCurrentSession`) forks the ACTIVE tab: `buildForkSessionRequest` (`src/core/forkSession.ts`) turns the terminal's session id + harness + device into a sibling launch queued with `/continue <id>`. `Agents: Fork (Recap)` (`agents.forkRecap`) follows that same active-tab path but queues `/recap <full-id>` in the fresh sibling; it does not open a picker, resume the source, or reuse its session id. `Agents: Fork (Pick Host)` (`agents.forkPickHost`) is the same fork with the DEVICE chosen first — `pickLaunchHost`, the same picker the `New <Agent> (Pick Host)` commands use — and everything else deliberately held constant: same harness, same `--strategy balanced` account rotation, only the machine moves. Two things follow from moving it. The prompt gains a `--device <source machine>` suffix, because a single-id lookup does NOT fan out (`agents sessions <id>` answers "No session with id … on this machine") and the transcript stays where it was written; and the tab opens with `viewColumn: Active` — a normal full tab in the active group, NOT a side split (a fork is a fresh sibling session, not a pane to wedge beside its parent). The pair is written to the fork-lineage store (`src/core/forkLineage.ts`, `globalState` key `agents.forkLineage.v1`, newest-60 cap) — a fork shares no id with its parent, so without that edge the two are unrelated rows forever. A harness that mints its id post-spawn is watched for up to a minute (`recordFork` in `extension.ts`) before the edge is written idless. The Recap ledger joins on it: `buildRecap` (`ui/settings/components/mission-control/recapModel.ts`) marks the fork and, when the parent finished on the SAME day, folds them into one side-by-side `recap-pair` row (`RecapPane.tsx`); day rollups are counted before pairing so the numbers still describe both sessions, and a cross-day parent keeps its own row rather than rewriting a past day. `Agents: Fork (Pick Session)` (`agents.forkPickSession`) is the only fork command that opens the session browser: `pickSessionToFork` in `src/vscode/extension.ts` renders one QuickPick over `agents sessions --all -n 60 --json` (plus `--host <device>` when its title-bar button switches machine), with the one-device row model in `src/core/sessionBrowser.ts`. `forkHostForSession` maps the row's resolved machine to the launch's `--host`; an untagged row falls back to the device the user explicitly browsed, or this machine for the default listing. The public `.agents-system` recap command resolves and reads history through an isolated read-only subagent; AGI EXT never fetches or injects a transcript. Ordinary remote launches pass the local workspace through portable `--cwd` so agents-cli can re-root `/Users/...` for the target. A picked remote historical session instead launches through `agents run --host <device> --remote-cwd <session cwd>` (`openSingleAgentWithQueue`'s `remoteCwd`) because that cwd is already exact on the transcript's device. |
| Terminal readiness events (tabReady, shellReady, promptReady, agentReady) | `src/core/terminalReadiness.ts`, `src/vscode/terminalReadiness.ts` (design doc: `swarmify/docs/01-terminal-lifecycle.md`) |
| Reconnect resilience | Owned by the agents CLI. The extension no longer wraps terminals in tmux or reattaches detached panes; closing a terminal tab simply unregisters it. On reload, restore uses only session-file based resume (`buildVersionedResumeCommand`). Source: removed `src/vscode/reconnect.ts`, `src/vscode/tmux.ts`, and tmux coordinate/fields from `src/vscode/terminals.vscode.ts` and `src/core/sessions.persist.ts`. |
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
| Watchdog surface (NO loop — endpoint + status card only) | **The extension holds no watchdog loop.** The agents-cli daemon watchdog (`agents watchdog enable`, under `agents __daemon-run`) is the sole watchdog: stall nudging AND rotate-on-exhaustion (it injects the exit sequence + `agents run auto --interactive` + the /continue replay into vscodium tabs IN THE SAME TAB via the extension's `/inject` URI verb over live-terminals.json), and writes the shared `~/.agents/.cache/logs/watchdog.log` JSONL (shape: `src/core/watchdogLog.ts`) — rotations are `kind: 'rotate'` events, and a skip is a `kind: 'rotate'` entry with a `rotate skipped:` message prefix (there is no separate skip kind) — that the Fleet status card renders read-only (`src/vscode/settings.vscode.ts`, `case 'getWatchdogLog'`; the panel's enable toggle is backed by `agents watchdog status|enable|disable`). What remains in the extension (`src/vscode/watchdog.vscode.ts`): the `/inject` rail's counterpart stays in `extension.ts`; the palette on/off `Agents: Watchdog (Enable)` / `Agents: Watchdog (Disable)` (shell out to `agents watchdog enable|disable` via execFile argv, no shell string); the one-time migration of a deleted `agents.watchdog.autoRotate: false` via the CLI's rotate-only switch `agents watchdog rotate off` (globalState-guarded, `migrateAutoRotateSettingOnce`; an older CLI without the subcommand fails nonzero and the migration retries next activation — never a fallback to full `disable`, which would pause nudging); and the playbook-file scaffold the settings panel still surfaces. Deleted with the loop: `startWatchdog`/tick, the no-healthy suppression, `src/core/autoRotate.ts`, `rotateTerminalToBestVersion`/`RotateOutcome`, the `agents.watchdog.*` settings, and the dormant monitor watchdog broadcast lane (`src/monitor/watchdogDetector.ts`, follower `setWatchdogWatches`, the `watchdog-watch`/`watchdog-versions` protocol types). Manual resume commands keep working: `Agents: Resume in Best Profile` launches `agents run auto` via the shared `launchResumeTerminal` (`buildAutoRunLaunchCommand` in `src/core/resumeInBest.ts`). |
| Fleet (dashboard, dispatch) | `ui/settings/components/mission-control/` |
| Sessions surface (manage / recover every session) | `ui/settings/components/mission-control/SessionsPane.tsx` (virtualized dense list, first fixed subtab, `center: 'sessions'`) + pure filter/sort/group model `sessionsModel.ts` (+ test). The acute case is **reconnecting orphaned/crashed sessions after the machine goes off**: the CLI's raw lifecycle status (`orphaned`/`crashed`/`abandoned`) is preserved end-to-end (`FloorAgent.liveStatus`/`pidAlive`, set from `RemoteSession` in `src/core/remoteSessions.ts` and threaded through `floorAdapter.ts`) because `phase` collapses it; `needsReconnect`/`sessionBand` (`floorModel.ts`) route those into a "Needs reconnecting" band. Star reuses `togglePin`; single + bulk resume reuse `openTerminalForAgent` (the CLI owns attach-vs-recover + host routing). All filtering/sorting/grouping is client-side over the already-polled roster — no new fetch. Preview: `?view=sessions`. |
| Cloud dispatch resolver (label parsing, repo/owner) | `ui/settings/components/mission-control/dispatch.ts` + `src/vscode/settings.vscode.ts` (`case 'dispatchTask'`) |
| Foreman voice orb (OpenAI Realtime, mic + speaker pipeline) | `src/vscode/foreman.audio.ts` (audio I/O via ffmpeg/ffplay, mic-gated during TTS to prevent echo loop), `src/vscode/foreman.vscode.ts` (session + tools), `ui/settings/components/foreman/ForemanOrb.tsx` (UI) |

## Keybindings

The canonical list is `package.json` → `contributes.keybindings`. Read it there; don't let this doc drift.

## Non-obvious gotchas worth knowing before you edit

Terminal tracking spans two worlds (VS Code API + an internal map that can go stale across restarts) — always cross-check `vscode.window.terminals` when reconciling. Three name formats for agent types live in different layers (UI/config/prefix); `src/core/utils.ts` is the reference. Webviews need `retainContextWhenHidden: true` or they reload on focus loss. `vscode.Terminal.iconPath` and `name` are frozen at `createTerminal()` time — there is no setter, which is why shell-adoption swaps the internal `agentConfig` but the tab chip keeps reading `SH`. Every spawned terminal carries `AGENT_TERMINAL_ID` (the extension reads it back from `creationOptions.env` to identify the tab), so it can't distinguish an agent CLI from a user shell — `buildAgentTerminalEnv` (`src/core/terminals.ts`) also exports `AGENT_TERMINAL_KIND` (`agent` | `shell`) for exactly that: a user's rc file gates its agent fast-path on `KIND != shell` so a bare `SH` tab still loads its full interactive env. Pass `{ kind: 'shell' }` for shell tabs. Beyond that, read the code — the mechanics change faster than this file should.
