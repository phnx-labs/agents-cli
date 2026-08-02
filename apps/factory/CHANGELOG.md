# Changelog

All notable changes to the Factory extension are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); `scripts/release.sh` requires a
`## [<version>]` section for the version being published.

## [Unreleased]

## [0.9.303] - 2026-08-02

- **Remove deprecated Gemini launch commands from the Factory palette (RUSH-2089).** Gemini is no longer supported; Antigravity is its replacement. The command palette no longer shows `Agents: New Gemini`, `Agents: New Gemini (Pick Host)`, `Agents: New Gemini (Auto)`, or `Agents: Setup Gemini`. Existing Gemini session parsing and transcript watching remain in place so old sessions are still readable. Source: `apps/factory/src/vscode/extension.ts`, `apps/factory/package.json`.

## [0.9.302] - 2026-08-02

- **Every built-in harness now has a fast `New <Harness> (Auto)` launch command.** Auto launch ranks a persisted warm cache by successful recent device history plus cached load, memory, and running-agent count; it excludes offline, SSH-unreachable, signed-out, and throttled devices without performing SSH on the command path. Every launch updates per-device history, a cold/no-match cache warns and launches locally, and Droid explains that account health is unavailable before opening the host picker. Auto-supported harnesses launch with balanced account rotation. Source: `apps/factory/src/core/launchHistory.ts`, `apps/factory/src/vscode/extension.ts`, `apps/factory/package.json`.
- **Remote Factory launches explicitly forward the active workspace or isolated worktree cwd.** `openSingleAgent` now passes the resolved local cwd to `agents run --cwd` whenever it emits `--host`, allowing agents-cli's existing `toRemotePortable()` rewrite to re-root home-relative paths on the selected device. Local launches still emit no cwd flag. Source: `apps/factory/src/core/agents.ts`, `apps/factory/src/vscode/extension.ts`.
- **`Agents: Fork Current Session` starts a sibling agent with the active session's context (RUSH-2058).** The command keeps the source terminal running, reuses its harness and persisted launch device, asks agents-cli to balance the target account when that harness supports rotation, and queues `/continue <session-id>` into the new terminal. Non-rotating harnesses keep their normal account strategy. Source: `apps/factory/src/core/forkSession.ts`, `apps/factory/src/vscode/extension.ts`, `apps/factory/package.json`.
- **Fix: an offloaded tab's title still never resolved — the remote session payload is a different shape than the local one.** `agents sessions <id> --json` renders the detail view and emits `{ session, events }`; the same lookup with `--host` is routed to the peer and comes back as the FLAT array of `SessionMeta` records instead. `parseSessionLabelSource` only understood the envelope, so it returned `null` for exactly the offloaded tabs it exists to label, and the tab kept the bare agent prefix. Both shapes are now handled, with the session id disambiguating a multi-record payload so a tab can never be labelled from someone else's session. Caught by running the real command instead of trusting the fixtures — the original tests were written from the local shape, so they passed against a parser that could not read the wire. The regression test is driven by a captured live payload (`src/core/testdata/sessions-by-id-remote.json`). Source: `apps/factory/src/core/remoteSessions.ts`, `apps/factory/src/vscode/remoteSessions.vscode.ts`.

## [0.9.301] - 2026-08-02

- **`scripts/release.sh` now finds the machine that can publish instead of failing on the one you happen to be on.** The marketplace PATs live in the `vs-marketplace` secrets bundle on a single box, and tokens are never copied between hosts, so a release invoked from anywhere else died at `Error: vsce not installed` (or later, at the token check) with no path forward. The script now probes for that bundle — this box first, then `zion`, then `mac-mini` — and when it is elsewhere, re-invokes itself there over `agents ssh` against a **clean clone of the same commit**, so no host's working tree is touched and the vsix can't pick up local edits. `vsce`/`ovsx` are treated as tools rather than blockers and installed on demand. New flags: `--host <name>` pins the publish box, `--here` refuses to route (fails loudly instead). Source: `apps/factory/scripts/release.sh`.
- **The Harness Roster's run-strategy control now reads and writes the config the CLI actually uses.** `agentInventory.ts` pointed at `~/.agents-system/agents.yaml` — a directory that was folded into `~/.agents/.system/` and no longer holds `agents.yaml` (the CLI reads `run.<agent>.strategy` from `~/.agents/agents.yaml`, `apps/cli/src/lib/state.ts`). Every read returned `{}`, so the roster showed the same fallback for every agent and every toggle wrote to a file nothing reads. The fallback was also wrong: it reported `pinned`, while a bare `agents run <agent>` with no configured strategy is `balanced` (`getConfiguredRunStrategy`, `apps/cli/src/lib/rotate.ts`). On a machine with a `run.codex.strategy: available` override set, the roster reported `pinned` for all five managed harnesses; it now reports whatever `getConfiguredRunStrategy` resolves per agent, matching the CLI exactly. Source: `apps/factory/src/core/agentInventory.ts`.
- **An agent that hits its limit rotates to another account again — and does it on its own machine.** Auto-rotate had gone dead: the gate required a *pinned* version, and launches stopped pinning once balanced rotation took over account selection, so every terminal was skipped and an agent that hit `You've hit your session limit` simply sat there until someone noticed. The gate now reads the version actually running (`rotatableVersionOf` — the pin when there is one, else the version resolved from agents-cli metadata after spawn). It is also per machine end to end: account headroom is a property of the device, so an offloaded terminal is checked against `agents view --host <device>` rather than this box's quota, the view cache is keyed by `agent@host`, and the replacement launches with `agents run <agent>@<version> --interactive --host <device>` instead of a bare local binary — a rotate used to silently move the work onto the laptop. The continuation is inlined rather than sent as `/continue` for a remote rotate, since whether that slash command is synced is a fact about the device's filesystem, not this one's. Source: `apps/factory/src/vscode/watchdog.vscode.ts`, `apps/factory/src/core/resumeInBest.ts` (`rotatableVersionOf`, `buildHostLaunchCommand`), `apps/factory/src/vscode/extension.ts` (`rotateTerminalToBestVersion`, `fetchAgentsViewJson`).
- **The host picker leads with the machines you actually use.** It sorted only by online/offline, so with a dozen registered devices the two boxes you work on daily landed in an arbitrary spot in the list. Rows are now ranked by recency-weighted session history per machine (`rankHostsByUsage`, sharing the exact scorer behind the agent ranking so the two cannot drift), with online still outranking usage — an offline box can't take the launch however familiar it is — and each row shows its recent session count so the order is legible. The fleet sweep is cached for a minute and a failure falls back to sorting by name, so the picker never hangs behind it. Also fixes a literal NUL byte in the `BALANCE_ID` sentinel, which worked at runtime (the sentinel is only compared with itself) but made `grep` classify `extension.ts` as a binary file and skip it. Source: `apps/factory/src/core/agentUsage.ts`, `apps/factory/src/vscode/extension.ts` (`pickLaunchHost`, `fetchHostUsageScores`).
- **An agent launched on another device is no longer a second-class tab: it gets a session id, an auto-generated title, and a resume that goes back to its own machine.** A "Pick Host" launch deliberately skipped minting a Claude session id and let the remote coin its own, so the extension never learned it. Everything downstream keys off that id, and all of it silently did nothing for offloaded tabs: the status bar stayed on the placeholder "Agents" with no id to copy, the auto-label poller returned early on the missing id so the tab title never advanced past the bare agent name, and Session Resume / Trace / Fork / Continue-in-New had nothing to act on. The id is now minted for local and remote alike and passed as `--session-id`, which `agents run --host` adopts for the remote session (`resolveHostSessionId`), so the id the tab shows is the id the session actually has. Offloaded tabs also record their device (`EditorTerminal.host`, persisted across reloads and reopens): the label poller resolves its title over `agents sessions <id> --host <device> --json` — the transcript lives on that machine, so the local session-file scan and jsonl preview it used before had nothing to read — and a restore or "Reopen Last Session" resumes through `agents run --host … --resume` instead of running `claude -r <id>` locally against an id this box has never seen. Source: `apps/factory/src/vscode/extension.ts` (`openSingleAgent`, `fetchRemoteAutoLabel`), `src/vscode/terminals.vscode.ts`, `src/vscode/remoteSessions.vscode.ts` (`fetchRemoteSessionLabelSource`), `src/core/remoteSessions.ts` (`parseSessionLabelSource`), `src/core/prewarm.ts` (`buildVersionedResumeCommand`), `src/core/sessions.persist.ts`.
- **A remote agent opens in the project you launched it from.** Requires agents-cli ≥ 1.20.82: a `--host` run with no explicit `--cwd` now mirrors the launching workspace's home-relative path onto the device, so a Pick Host tab starts in the repo instead of the remote home. No extension change beyond inheriting the CLI behavior — the spawned `agents run` already runs in the workspace directory.

## [0.9.300] - 2026-08-02

- **Launch is now one engine, and balanced is the default — the per-harness command sprawl is gone.** Every "New agent" command used to re-implement the same resolve-host → resolve-harness → resolve-version pipeline inline, which spawned ~40 palette commands (per harness: `(Pinned)`, `(Latest)`, `(Balanced)`, `(Pick Version & Host)`, `(Auto Host)`, `(Auto)`, plus two global version pickers) and a QuickPick that asked you to pick the *agent first, then* the host. Now a single `launchAgent(context, {agentKey?, host?, pickHost?, local?})` engine owns it: it resolves the **host** (explicit, device-first, or least-busy healthy), the **harness** (explicit, or auto from what's installed + has headroom *on the chosen host* via `hostHasUsableVersion`, ranked by recent usage), and the **version/account** — which is **always balanced** (token-usage-aware rotation that skips signed-out / rate-limited accounts). Manual version picking is gone entirely: no `(Pinned)`, no `(Latest)`, no version pickers. The surface per harness collapses to two — `New <Harness>` (balanced, local) and `New <Harness> (Pick Host)` — plus the global `New Agent` (auto everything) and `New Agent (Pick Host)`, which is now **device-first**: you pick the host, and the harness is auto-selected from what's available there. Short codes (`(CC)`, `(CX)`, …) are dropped from the command titles. 41 commands removed; keybindings unaffected. Source: `apps/factory/src/vscode/extension.ts` (`launchAgent`, `resolveAutoAgentKey`), `apps/factory/package.json`.
- **Host selection is now agent-aware, and a new "New Claude (Auto)" command picks host + strategy in one step (RUSH-2025).** "New Claude (Pick Host)" / "(Auto Host)" could land on a device with no signed-in, usable Claude — the host picker only ranked by running-agent count. Now, when picking or auto-selecting a host for a specific agent, the balancer probes each candidate's version health (via `agents view <agent> --host <device> --json`) and hardware load/memory (via `fetchDeviceStats`), **drops devices with no signed-in, non-throttled version**, and ranks the rest by a composite score (running agents dominate; load and memory pressure break ties so a crashing/thrashing box is deprioritized). If no fleet device has a usable version, it falls back to a local launch with a clear warning instead of launching into a broken agent. Pick Host and Auto Host now also launch with `--strategy balanced`, so the CLI's account rotation routes around a signed-out / throttled version on the chosen device. (This agent-aware host ranking is retained; the separate per-agent "Auto" / "Auto Host" commands it introduced have since been folded into the single launch engine above — balanced host + version selection is now the default for every launch, so those commands were removed.) Pure ranking logic (`deviceHasUsableVersion`, `hostScore`, `pickBestHost`) lives in `src/core/launchHost.ts` and is unit-tested without live SSH. Source: `apps/factory/src/core/launchHost.ts`, `apps/factory/src/vscode/extension.ts`, `apps/factory/package.json`.
- **`Agents: New Agent` (⌘⇧A) is now a smart three-tier launch instead of always
  Claude (RUSH-2029).** The generic New Agent command previously hard-coded the
  configured default agent. It now (1) picks the agent TYPE by recent/frequent
  usage — aggregating fleet-wide session history (`fetchRecapSessions`) into a
  per-agent preference that weights the last 24 hours heavily while still counting
  longer-term frequency, and falling back to the configured default when there is
  no usable history; (2) launches with `--strategy balanced` so the version/account
  is load-balanced across healthy signed-in accounts; and (3) auto-picks the
  least-busy healthy device via `resolveBalancedHost`. Uninstalled or signed-out
  agents are excluded from selection, and a status-bar note reports the choice
  (e.g. `New Agent: Codex (balanced on yosemite-s0)`). The explicit per-agent
  commands (`New Claude …`, `New Codex …`) are unchanged. New pure selector
  `src/core/agentUsage.ts` (`rankAgentsByUsage` / `pickAgentByUsage`) is unit-tested
  against fixture history. Source: `apps/factory/src/core/agentUsage.ts`,
  `apps/factory/src/vscode/extension.ts`.
- **Native-mode agent terminal tabs now close automatically when the agent exits (RUSH-2026).** In native (non-tmux) terminal mode, the launch command is now prefixed with `exec` so the shell process replaces itself with the agent runner. When the agent exits the terminal process exits too and VS Code closes the tab automatically — no manual close needed. This mirrors the existing tmux pane-died behaviour. Shell tabs (the SH agent type) and tmux-mode terminals are unaffected. Remote `--host` launches get the same treatment: the local SSH wrapper exits with the remote session. Source: `apps/factory/src/core/agents.ts` (`wrapNativeAgentCommand`), `apps/factory/src/vscode/extension.ts` (`openSingleAgent`).

- **Interactive agent launches now default to `--mode auto` instead of stalling in read-only plan mode (RUSH-2038).** Launching Codex, Claude, Gemini, Cursor, OpenCode, or Antigravity from Factory without explicitly choosing a mode now runs in `auto` (writable-but-gated), so the agent can edit files immediately. Previously the CLI default of `plan` was inherited, causing Codex to start with `--sandbox read-only` and wait indefinitely for approval. `buildAgentLaunchCommand` is now in `src/core/agents.ts` so it is unit-testable without a VS Code harness. Source: `apps/factory/src/core/agents.ts`, `apps/factory/src/vscode/extension.ts`.

- **Stuck Claude tab labels self-heal, and an existing session name is reused
  before summarizing.** Two follow-ups to the derived-label fix: (1) On reload,
  a tab already reading `CC - muqsitnawaz-91` had that derived placeholder
  re-adopted as a sticky manual label, which blocked the auto-label poller
  forever. The label paths (poller-arm and focus) now detect a label that is
  EXACTLY the session's own derived name and clear it so a real name/topic
  resolves — matched against the session file, so a genuine label (e.g.
  "Daemon Creds") or an old-CLI name is never touched. It only clears a label +
  its store entry; the tmux session and agent are never affected. (2) The
  auto-label path now reuses Claude's persisted `/status` title as soon as one
  exists — even before a first user message is captured — and only summarizes
  with the LLM when there is no existing name. New `readClaudeSessionNameInfo`
  exposes the session's name + source for the heal check.

## [0.9.299] - 2026-08-01

- **The extension no longer runs its own stall-detection/nudge injector — the
  agents-cli daemon watchdog is the sole injector.** The extension's autonomous
  watchdog tick used to `fs.stat` each agent session file, call a Claude Haiku
  headless instance to decide whether an agent was stalled, and inject a nudge
  by typing into the terminal. In real setups (agent terminals in VS Codium) it
  fired the wrong message at the wrong time and double-nudged against the CLI
  daemon watchdog, so its active poking is retired: the nudge injection, the
  headless/smart-agent stall decision, the per-terminal opt-out command
  (`agents.watchdog.toggleTerminal`), and the monitor's centralized stall
  broadcast are all removed, along with the `stallNudge`, `stallSeconds`,
  `cooldownSeconds`, and `useSmartAgent` settings. The extension keeps the one
  capability the CLI lacks — **version auto-rotate**: when a version-pinned
  Claude terminal exhausts its quad it still spawns a fresh terminal on the best
  signed-in version and replays `/continue` (`agents.watchdog.autoRotate`,
  `rotateCooldownSeconds`, `tickSeconds`; the `enabled` master switch now gates
  auto-rotate). The Factory Floor **watchdog status card stays**, now rendering
  the `~/.agents/.cache/logs/watchdog.log` feed the CLI daemon writes. The
  on-demand MCP peer-nudge path (`send_nudge`/`send_to_agent`) is unchanged.

- **Claude terminal tabs get a real topic label again, not the repo name.**
  Claude 2.1.207+ auto-derives a placeholder session name `<dirname>-<n>`
  (e.g. `agents-cli-55`, tagged `nameSource: "derived"`). The extension used it
  verbatim as the tab label and, worse, it short-circuited the LLM topic path —
  so every Claude tab read `CC - agents-cli-55` instead of what the agent was
  working on, while non-Claude tabs (which skip that path) showed real topics
  like `KM - Create Tickets`. A derived name is now treated as no name, so the
  tab falls through to the LLM-generated topic. Genuine titles are still used.
  The auto-label poller also refreshes the tab title itself (not just the status
  bar) when a label resolves on the active tab, so it no longer takes a focus
  change to appear.
- **A dropped SSH connection no longer destroys running agents (reconnect
  resilience).** Agents run in detached tmux sessions on the shared socket, so
  they survive a network drop — but on a Remote-SSH teardown VS Code fires
  `onDidCloseTerminal` for every editor terminal, and the old cleanup
  unconditionally ran `agents tmux kill`, killing healthy agents just because
  the client blinked. `cleanupTmuxTerminal` now queries the shared server first
  and kills ONLY on a true agent exit (session gone or every pane dead); a live
  pane is treated as a client/network detach and left alive for re-attach. The
  liveness probe fails SAFE: when no tmux binary is reachable (an install outside
  the probed paths — asdf, mise, Nix, Linuxbrew, a container prefix) the probe
  reports "couldn't confirm" rather than "gone", and the kill decision declines
  to kill, so a non-standard tmux location can no longer silently destroy live
  agents on every detach. The
  terminal↔tmux mapping (session/socket/pane/pid) is persisted so it survives an
  extension reload, and on reconnect (window regains focus, or the extension
  reactivates) every mapped session that is still live but has no attached
  client is re-attached via `agents tmux attach` — never a new session, so the
  agent is never restarted — with bounded-backoff retry on transient SSH
  failures. On a real extension-host reload, tmux-backed sessions are now the
  exclusive responsibility of the reconnect pass: `restoreAgentTerminals` skips
  any persisted session carrying a tmux mapping (it no longer recreates a plain
  terminal and resumes it from the CLI session file, which would restart the
  agent) and preserves that mapping on disk instead of wiping it, so the pass can
  `agents tmux attach` the still-live session and a subsequent reload still has
  the mapping to recover from. On a network drop that does NOT reload the
  extension host (the common Remote-SSH case), a single `onDidCloseTerminal`
  handler now decides the whole close from one detach-vs-exit classification: on a
  live detach it marks the entry detached and preserves its durable mapping (so
  the reconnect pass can re-attach even a session spawned in the current window),
  instead of unconditionally unregistering it and overwriting the on-disk mapping
  to exclude it — the previous behavior orphaned freshly-spawned agents. A
  permanent reattach failure (an unknown agent prefix) is now non-retryable, so it
  no longer burns the backoff budget on every window-focus event. The Factory
  Floor grid re-arms its polling on reconnect so it no longer looks frozen.
  Source: `apps/factory/src/vscode/tmux.ts`,
  `apps/factory/src/vscode/reconnect.ts`, `apps/factory/src/vscode/extension.ts`,
  `apps/factory/src/vscode/terminals.vscode.ts`,
  `apps/factory/src/core/sessions.persist.ts`,
  `apps/factory/src/vscode/settings.vscode.ts`.

- **Detach / Attach — send a running agent to the background from the editor.**
  Two commands: **Agents: Detach (Send to Background)** (`agents.detach`,
  `cmd+k cmd+b` on a focused agent terminal, also in the terminal right-click menu)
  sends the active agent's session to the background via `agents sessions detach <id>` —
  the interactive process stops, the tab closes, and the agent keeps working
  headless. **Agents: Attach (Bring to Foreground)** (`agents.attach`,
  `cmd+k cmd+a`) picks a backgrounded/parked agent and resumes it interactively in
  a new terminal via `agents sessions attach <id>`. The Floor session model now carries the
  CLI's `presence` (`attached` / `background` / `parked`). Source:
  `apps/factory/src/vscode/extension.ts`, `apps/factory/src/core/remoteSessions.ts`,
  `apps/factory/package.json`.

- **agents-dbg now has a 0.1.0 Mac release pipeline (RUSH-1015).** The standalone
  Electron app packages as `agents-dbg.app` with the `com.phnxlabs.agents-dbg`
  bundle id, hardened-runtime entitlements, Developer ID signing, and
  electron-builder notarization when Apple credentials are present. The new
  root `scripts/release.sh` dry-runs by default, builds and verifies the
  notarized app on `--confirm`, uploads GitHub release assets, and updates
  `muqsitnawaz/tap` formula/cask entries through `scripts/bottle.sh`, while
  `scripts/install-agents-dbg.sh` provides the public curl installer. Source:
  `apps/factory/app/package.json`, `apps/factory/app/scripts/build.sh`,
  `.github/workflows/agents-dbg-release.yml`, `scripts/release.sh`,
  `scripts/bottle.sh`, `scripts/install-agents-dbg.sh`.

## [0.9.295] - 2026-07-21

- **Fleet-aware Launch Matrix — spawn a Quick Launch agent on a specific device or balanced across the fleet.** Each Quick Launch slot (⌘⇧0–9) gains a **Run on** target: this Mac (default, unchanged), a registered device (offloaded over SSH via `agents run --host`), or ⚖ Balanced — auto-pick the least-busy online device, with an optional pool restriction. The collapsed row shows the target (`↗ <device>` / `⚖ balanced`); a new optional chord **⌘⌥⇧0–9** fires a slot but prompts for the host once. Every non-shell agent (Claude, Codex, Gemini, OpenCode, Cursor, Antigravity, Grok, Kimi, Droid) also gains palette commands mirroring the version triad on a host axis — **(Pick Host)**, **(Pick Version & Host)**, **(Auto Host)** — plus generic `New Agent (Pick Host)` / `(Pick Version & Host)`; a host target routes ANY agent through `agents run --host` so grok/kimi/droid (raw-binary local launches) get parity. Balanced picks by fewest running agents, excluding the local interactive machine. Source: `apps/factory/src/core/settings.ts`, `apps/factory/src/core/launchHost.ts`, `apps/factory/src/vscode/extension.ts`, `apps/factory/ui/settings/components/panel/LaunchMatrix.tsx`, `apps/factory/package.json`.
- **"Open Terminal" now works for a session running on a remote device.** A Floor card's terminal button already carried the agent's `host`, but the `focusSession` handler dropped it and always ran `agents sessions focus <id>` detached on the local machine — so for a session living on another device (`host !== this-mac`) the `ssh -tt` resume had no TTY to land in and nothing appeared. It now branches on host like the sibling `focusRemoteSession` (tmux) path: local stays a detached native-tab spawn; a remote host opens a VS Code terminal running `ssh -t <host> agents sessions focus <id> --local`, which attaches the live tmux pane or resumes it in the ssh TTY on the peer that owns it. Reuses the CLI's existing `--host`/cross-host focus engine rather than reimplementing SSH. Source: `apps/factory/src/core/remoteSessions.ts` (`buildRemoteFocusCommand`), `apps/factory/src/vscode/settings.vscode.ts` (`case 'focusSession'`), `apps/factory/src/core/remoteSessions.test.ts`.
- **Agent panel checklist now consumes the CLI's computed `session.todos` instead of re-parsing the transcript (RUSH-1503).** The per-terminal panel derived its checklist by re-implementing the CLI's session engine — a `TodoWrite`/`update_plan` transcript parser (`extractTodoProgress` + helpers in `core/session.activity.ts`). That parser is deleted; the panel now reads `session.todos` off the same `agents sessions <id> --json` call it already makes for tool stats (`getSessionToolStatsViaAgentsCli`), mapped into the panel shape by `todoProgressFromCli`. One source of truth for checklist state, no extra subprocess, and Codex plan progress is now covered by the CLI (so the panel no longer regresses for Codex). Source: `apps/factory/src/core/session.activity.ts`, `apps/factory/src/core/handoff.ts` (`SessionToolStats.todos`), `apps/factory/src/vscode/agentPanel.vscode.ts`, `apps/factory/src/core/session.activity.test.ts`.
- **Cloud agent activity feed no longer freezes on the first streamed event (RUSH-1558).**
  `parseCloudSummaryIncremental` was returning its internal mutable cache array by
  reference; React's `useMemo` in `CloudActivityFeed` keyed off that reference and
  never saw it change as new events were pushed in place, so the detail pane's
  live feed rendered only the first commit and stopped advancing. It now always
  returns a fresh array. Source: `ui/settings/components/mission-control/cloudActivity.ts`.
- **Grok, Kimi, Antigravity, and Droid are now first-class launchable agents with real brand logos.** They were already in the CLI registry snapshot but only Claude/Codex/Gemini/OpenCode/Cursor were surfaced in the extension. New terminal-spawn commands `agents.newKimi` / `agents.newDroid` (Grok/Antigravity already existed) join the presentation registry with chips **AG / GK / KM / DR** and prefixes `ag / gk / km / dr`; each carries a real brand mark that renders in the terminal tab bar and the dashboard roster/dispatch/launch surfaces. Grok's and Droid's monochrome marks ship dark+light variants (`grok-light.png`, `droid-light.png`) registered in `theme.vscode.ts` so they stay legible on the light/cream tab bar. Gemini is unchanged (kept alongside Antigravity, not deprecated). Source: `apps/factory/src/core/agents.ts`, `apps/factory/src/core/utils.ts`, `apps/factory/src/core/settings.ts`, `apps/factory/src/vscode/settings.vscode.ts`, `apps/factory/src/vscode/theme.vscode.ts`, `apps/factory/package.json`, `apps/factory/assets/{grok,grok-light,kimi,antigravity,droid,droid-light}.png`, `apps/factory/ui/settings/constants/index.ts`, `apps/factory/ui/settings/types/index.ts`, `apps/factory/ui/settings/components/mission-control/{AgentAvatar,floorAdapter,floorModel}.ts*`, `apps/factory/ui/settings/components/panel/HarnessRoster.tsx`.

- **Security: hardened the webview→host trust boundary — untrusted webview messages can no longer open arbitrary-scheme URLs, run arbitrary VS Code commands, inject shell, or write outside the asset dir.** Webview messages are untrusted input, but several host handlers forwarded webview-supplied values straight into privileged APIs with only a `typeof` guard. Fixed at the source via a shared `webviewSecurity` module: (1) `openExternal` now goes through `openExternalUrl`, which allowlists `https`/`http`/`mailto` and refuses `file:`/`command:`/`vscode:`/`javascript:`/`data:` (6 call sites across `agentPanel`, `issuesPanel`, `settings`); (2) the generic `executeCommand` message is gated by `isAllowedWebviewCommand` to the theme-toggle + `agents.new*` set the UI actually dispatches, not any command id; (3) `factoryAnswer` now single-quote-quotes both `teamId` and `text` via `shq` instead of an incomplete double-quote escape that left `teamId` open to shell injection; (4) the custom markdown editor's `saveAsset` runs the webview filename through `path.basename` so a `../../` name can't escape the `.assets` dir. The pure allowlist predicates live in `src/core/webviewSecurity.ts` with unit tests. Source: `apps/factory/src/core/webviewSecurity.ts`, `apps/factory/src/core/webviewSecurity.test.ts`, `apps/factory/src/vscode/webviewSecurity.ts`, `apps/factory/src/vscode/{agentPanel,issuesPanel,settings,customEditor}.vscode.ts`.
- **Custom markdown editor can now play embedded videos (RUSH-1437).** The editor's TipTap VideoBlock inserts videos as `data:` URLs, but the webview CSP had `default-src 'none'` and no `media-src`, so the `<video>` element was blocked from loading. Added a scoped `media-src data:` directive (only `data:`, not a wildcard). Source: `apps/factory/src/vscode/customEditor.ts`.

## [0.9.294] - 2026-07-15

- **Fix: extension failed to activate — every `agents.*` command reported "command not found" (e.g. `agents.dispatchTask`, `agents.configure`).** The published `0.9.293` VSIX shipped without its `node_modules`, so `require("yaml")` (in `core/agentInventory`, `sessions.persist`, `swarmifyConfig`) threw during `activate()`, aborting before any command registered. This release is a clean rebuild that bundles the runtime deps. To prevent recurrence, `scripts/build.sh` now unzips the freshly-packaged VSIX and hard-fails the build if `yaml`, `node-pty` (incl. its `darwin-arm64` native prebuild), `sql.js`, or `ws` are absent — a dependency-less package can no longer reach the marketplace. Source: `scripts/build.sh`.

- **Factory Floor shows live plan progress for remote / device-dispatched agents (RUSH-1380).** The CLI now carries each session's latest `TodoWrite` on `ActiveSession.todos`; the remote adapter maps it onto the feed's checklist (previously hardcoded empty for status-only remote sessions), so a headless agent on another machine now renders an N/M pill in its header, the `CardChecklist` in its feed card, and a `TodoChecklist` in its detail pane. When there's no live tool action, the now-line falls back to the in-progress step. Source: `apps/factory/src/core/remoteSessions.ts` (`RemoteSession.todos`, `normalizeTodos`), `ui/settings/components/mission-control/floorAdapter.ts` (`toFloorAgentFromRemote`), `FeedItem.tsx`, `UnifiedAgentsPane.tsx`, `floor.css`.

## [0.9.292] - 2026-07-13

- **Factory recognizes every current agents-cli harness.** The checked-in CLI
  registry snapshot now includes Hermes and ForgeCode, keeping Factory's agent
  metadata aligned with the canonical `AgentId` union. Source:
  `src/core/agents.cli.ts`.
- **Remote plan previews are isolated by source path (RUSH-1631).** Cache key is `host/sha1(path)/basename` so two worktrees sharing a plan basename no longer clobber each other. Source: `src/vscode/settings.vscode.ts`.
- **Windows remote dispatch uses distinct PowerShell stdout/stderr log paths (RUSH-1622).** `Start-Process -RedirectStandardOutput` and `-RedirectStandardError` cannot share a file; use `.out.log` / `.err.log`. Source: `src/vscode/settings.vscode.ts`.

- **Factory Floor group controls now support Subgroup (RUSH-1544).**
  The live feed and Backlog controls can render a second grouping axis, excluding
  the primary axis to avoid duplicate grouping. Nested section headers make
  combinations like Project -> Host and Project -> Source visible without
  switching views. Source: `ui/settings/components/mission-control/FloorControls.tsx`,
  `UnifiedAgentsPane.tsx`, `BacklogCenter.tsx`.
- **Factory Floor backlog refreshes while the view stays open (RUSH-1578).**
  The Floor and Bench tabs now re-fetch unified Linear/GitHub tasks on a
  30-second active-view cadence, so external ticket status changes no longer
  require closing and reopening Factory. Source: `ui/settings/App.tsx`.
- **Factory Floor surfaces agent-created tickets as clickable Linear artifacts (RUSH-1547).**
  Session cards and detail panes now render linked Linear badges for carried/created
  ticket refs and include commit chips in the produced-artifacts row, so PRs,
  tickets, teams, plans, and commits are visible without reading the transcript.
  Source: `ui/settings/components/mission-control/FeedItem.tsx`,
  `UnifiedAgentsPane.tsx`.
- **Factory tmux tabs close when their top-level pane exits (RUSH-1543).**
  Tmux-backed agent tabs now install a guarded pane-death hook: exiting a user
  split still closes only that split, but when the last remaining pane dies,
  Factory detaches, kills the tmux session, and lets the VS Code
  terminal close instead of lingering on a "Pane is dead" banner. Source:
  `src/vscode/tmux.ts`.
- **Factory Floor's full sidebar is now resizable (RUSH-1539).** Drag the right
  edge to widen or narrow the project/host sidebar; the chosen width persists
  with the existing Floor preferences. Source:
  `ui/settings/components/mission-control/FloorSidebar.tsx`,
  `UnifiedAgentsPane.tsx`, `floor.css`.
- **Per-session rate-limit badge on feed cards (RUSH-1523).** Sessions whose transcript shows a rate/usage limit render a distinct **rate limited** pill so they no longer look like healthy running agents. Source: `floorModel.ts` (`rateLimited`), `floorAdapter.ts` (`detectSessionRateLimited`), `FeedItem.tsx`.
- **Feed cards get an Open/Resume-in-terminal action (RUSH-1520).** Each card shows a Terminal button that focuses an open tab, attaches a tmux rail, or runs `agents sessions focus <id>` — so the operator jumps into the session instead of only opening the side panel. Source: `ui/settings/components/mission-control/FeedItem.tsx`, `UnifiedAgentsPane.tsx` (`openTerminalForAgent`).
- **Filter + group-by controls live in the feed header bar next to Save view (RUSH-1526).** The feed's own header (`SavedViews` / `feed-header-bar`) now carries Group + status chips (Needs you / Running / Idle / Failed) + agent-abbr chips, so operators filter and group where they are looking — not only from the top FloorControls bar. Source: `ui/settings/components/mission-control/SavedViewsBar.tsx`, `UnifiedAgentsPane.tsx`, `floor.css`.
- **Floor Group defaults to Outcome (ticket/PR/worktree) instead of Project (RUSH-1479).** Fleet-scale floors collapse agents under the deliverable they serve so the operator sees initiatives, not ~1,100 processes. Source: `ui/settings/components/mission-control/floorModel.ts` (`outcomeLabel`, `FloorGroupBy`), `FloorControls.tsx`, `UnifiedAgentsPane.tsx`.
- **The extension's parallel session stack is gone — live-session state now comes from the CLI (#741).**
  Activity, waiting-for-input, awaiting reason, and tokens/sec ride the
  `agents sessions --active --json` payload (`ActiveSession.activity` /
  `awaitingReason` / `tokPerSec`) instead of being re-derived from per-agent
  transcript-tail parsers; the Recent Sessions picker is backed by
  `agents sessions --json` (fixing the stale `~/.gemini/sessions` scan — the CLI
  scans the real `~/.gemini/tmp`); the machine-wide session watcher configures
  its roots from `agents sessions --roots --json`; and the agent registry
  (`BUILT_IN_AGENTS` launch commands, `.agents` config agent ids) derives from a
  CLI-registry snapshot validated against `apps/cli` source in tests — which
  also fixes antigravity launching a nonexistent `antigravity` binary instead of
  `agy`, and `.agents` files silently dropping newer agents (grok, droid, …).
  Source: `apps/factory/src/core/{session.activity,remoteSessions,agents,agents.cli,swarmifyConfig}.ts`,
  `apps/factory/src/vscode/{remoteSessions,terminals,watchdog,settings,sessions}.vscode.ts`,
  `apps/factory/src/monitor/{sessionParse,sessionWatcher}.ts`.
- **Internal: `foreman.vscode.ts` reuses the shared `humanElapsed` helper (#753).** Deleted the identical private `humanElapsedFromMs` copy and imported the exported `humanElapsed` from `core/foreman.digest.ts`. No behavior change. Source: `apps/factory/src/vscode/foreman.vscode.ts`.
- **Windows device dispatch no longer hardcodes `bash -lc`.** `dispatchToDevice` selects the remote shell from the device registry platform (PowerShell `-EncodedCommand` on windows; bash on POSIX), so Dispatch v2 works on win-mini. Source: `apps/factory/src/core/deviceDispatchShell.ts`, `apps/factory/src/vscode/settings.vscode.ts`. (RUSH-1481)

### Fixed

- **Factory watchdog logs now use the canonical cache path documented by AGENTS.** The
  watchdog bridge, watchdog tick writer, and Factory Floor log reader share one
  `WATCHDOG_LOG_PATH` at `~/.agents/.cache/logs/watchdog.log`, matching the
  post-restructure docs and CLI migration target. (RUSH-1516)
- **Factory Floor cards now use human session names instead of UUID slices (RUSH-1532).**
  Remote sessions preserve explicit labels separately from task topics, and the Floor
  card header prefers label, topic, branch, ticket, and worktree metadata before falling
  back to a generic agent title. Cloud single-agent rows now use their configured name
  or prompt line instead of `agent-019e30a2`-style identifiers.
- **NEEDS YOU precision — finished/stopped agents no longer masquerade as needing
  input (RUSH-1522).** Two gates tightened. (1) `derivePhase` now checks terminal
  statuses first: a `completed`/`stopped`/`failed` agent can no longer be lifted
  into the `waiting` phase by a stale `waitingForInput` flag — it lands in
  DONE/idle/FAILED where it belongs. (2) The prose trailing-"?" waiting heuristic
  now decays: past 30 minutes with no session writes (`PROSE_QUESTION_FRESH_MS`),
  a session that signed off with "anything else?" stops classifying as waiting —
  previously such sessions sat in NEEDS YOU indefinitely (the reported card was 13
  days stale). Structural signals are exempt: a genuinely pending
  `AskUserQuestion`/`ExitPlanMode` still lands in NEEDS YOU at any age. Source:
  `ui/settings/components/mission-control/floorModel.ts` (`derivePhase`),
  `src/core/session.activity.ts` (`detectWaitingForInput`),
  `src/core/remoteSessions.ts` (`enrichWithSessionContent`),
  `src/vscode/terminals.vscode.ts`.

### Added

- **Factory Floor cards now show session screenshots and attachments as previewable artifacts (RUSH-1524).**
  Session parsers carry structured attachment metadata from prompt image/document
  blocks through the CLI JSON, remote session bridge, VS Code webview resource
  roots, and Floor cards. Image attachments render as thumbnails; any attachment
  opens through the host preview bridge.
- **Factory Floor cards now surface plan artifacts for preview (RUSH-1525).**
  Session output, recent worktree files, and attachment refs are scanned for
  `.html` and `ref-*.md` plan files; matching cards show plan chips that open HTML
  plans externally and Markdown plans in the editor preview.
- **Project rollups — one glance answers "what's happening in this project".** The
  rail's Projects flyout rows now carry dim sub-counts (open backlog tickets and
  distinct open PRs) next to the live agent count, and each card in the Projects
  pane gains an activity line — "3 running · 1 waiting · 4 backlog · 2 PRs ·
  active 40m ago" (or "quiet") — all derived in one pass from the live feed and
  backlog the Floor already holds.
- **PR board — every open PR the floor's agents produced, in one actionable list.**
  A new PRs center tab aggregates the live feed's PR URLs and shows, per PR: CI
  state, review decision (approved / changes requested / review required), merge
  conflicts, a chip for the agent that owns it (jumps to its card), and a **Merge**
  button that appears only when the PR is open, not draft, approved, CI-green, and
  conflict-free. Rows are ranked for action: ready-to-merge first, then red CI /
  conflicts, then changes-requested. Merge runs plain `gh pr merge --rebase` (never
  `--admin` — branch protection stays in force); refusals surface inline on the row.
- **Recap — a work ledger for "what happened while I was away".** A new Recap center
  (clock button on the rail, Recap tab in the strip) lists finished sessions across the
  whole fleet, grouped by day, each with its task line, project · host · branch, ticket,
  a PR link, and the session's real duration and cost. Day headers roll up sessions,
  spend, and PRs (e.g. "Today — 12 sessions · $18.40 · 3 PRs"). No new bookkeeping: the
  CLI's `agents sessions` metrics (`durationMs`, `costUsd`, `tokenCount`) were already
  computed per session and are now carried through instead of dropped. Live sessions are
  excluded — the feed owns what's running, the ledger owns what finished.
- **The backlog now shows who is already working each ticket.** A ticket an agent
  carries gets an in-flight chip on its row (phase dot + agent abbr, `+N` when several
  are on it; hover for the full roster), and the ticket detail pane gains an **In
  flight** section — one row per worker with phase, host, and PR, each jumping to that
  agent's card. Dispatching onto a ticket that's already in flight is guarded: the
  button turns amber, reads "Dispatch anyway", and names the agent already on it, so a
  second agent is a deliberate choice instead of an accident.

### Changed

- **Plan-watch now reads from the CLI's canonical `session.plan` field instead of re-parsing
  raw JSONL.** `watchForPlan` previously read the session `.jsonl` file and re-implemented the
  `ExitPlanMode` scanner (`parsePlanFromClaudeJsonl`) — a duplicate of the CLI's session state
  engine. The CLI now carries `plan` on `SessionMeta` (surfaced via `agents sessions <id>
  --json`), so the extension polls the CLI directly and `parsePlanFromClaudeJsonl` is deleted.
  No behavior change for the Floor's plan-ready surface. (RUSH-1505)

- **The collapsed Floor rail's Projects and Hosts buttons are now flyout menus instead of
  three buttons that all expanded the sidebar.** Click Projects for the curated project
  list (live agent count + amber waiting count per project, plus any uncurated project
  that has agents running) and jump straight to that scope; click Hosts for the fleet
  roster with health dots and per-host counts. The Hosts button carries a red dot whenever
  any host is offline, a lime **Dispatch** button now sits at the top of the rail, and the
  `»` chevron is the single expand affordance. Active states are fixed across the board
  (Backlog lights when the backlog center is showing; a project/host scope lights its
  button), and the rail-vs-sidebar choice is remembered across reloads.

### Fixed

- **"Needs you" in the rail and sidebar now actually filters the feed.** It used to clear
  all filters — identical to "All agents" — despite the amber badge. It now toggles the
  same `needs` status chip the controls bar drives, and "All agents" clears it.

## [0.9.291] - 2026-07-09

### Fixed

- **NEEDS-YOU cards no longer show a doubled, contextless "Thinking…".** A paused/idle
  card rendered the live-activity fallback string `"Thinking..."` twice — once as the card
  body and again as the green now-line — because `resp` fell back to the live-activity
  string when the agent had no last message. `resp` is now strictly the agent's last real
  message (empty when there is none), and the now-line renders only while an agent is
  actively working (`running`/`stalled`), so a paused card that's waiting on you shows just
  its task, progress timeline, and reply box.

### Added

- **The NEEDS-YOU detail panel now shows why an agent is blocked, the task, and the real
  question with one-click answers.** A blocked card used to surface only a status word and
  a "Thinking…" line — you had to open the terminal to find out what it wanted. The
  decision block at the top of the right pane now renders a **why-blocked chip** (Question
  / Plan review / Permission — permission in red), the **original task** for context, and
  the **real question with its option chips**, sourced from the CLI's structured decision
  (`sessions --json` `question`) rather than a regex over prose. Extracted into
  `<AgentDecision>` so the preview harness renders the exact markup (`?view=decision`).
  (RUSH-1521, RUSH-1546)
- **Inline approve/deny for interactive prompts.** When an option maps to a select-list
  keystroke — a permission prompt (Approve=`1` / Deny=`esc`), a plan review, or an
  `AskUserQuestion` — clicking it now sends that **keystroke** through the existing
  terminal/tmux reply rail (the proven Ink text-then-CR and `tmux send-keys` paths)
  instead of a label the TUI would ignore, so you can unblock without opening the
  terminal. Cloud/team replies stay label-based (semantic-message APIs). (RUSH-453)

### Fixed

- **Cloud status + latest-activity now render identically across hosts.** The Electron app
  and the VS Code extension carried two divergent `mapCloudStatus` tables — the extension
  missed `error` / `in_progress` / `queued` and matched case-sensitively, the app missed
  `allocating` / `needs_review` — so the same cloud run could show a different status per
  host. Both now import one shared `mapCloudStatus` (`src/core/cloudStatus.ts`) whose
  case-insensitive switch is the union of the two tables. The standalone app's
  "latest activity" also sorted ISO timestamps lexically (wrong on mixed offsets); it now
  compares on `Date.getTime()`, matching the extension. (RUSH-1512)
- **The standalone Factory app now pauses its floor poll when the floor is hidden.** The
  Electron host handled `subscribeFloor` but dropped `unsubscribeFloor`, so its 5s poll —
  which shells out to read agent state and hit the cloud-runs API — kept running even when
  no floor was visible. It now stops on `unsubscribeFloor` and resumes on `subscribeFloor`,
  mirroring the VS Code host's `cleanupFloorWatchers` lifecycle. (RUSH-1509)

## [0.9.290] - 2026-07-08

### Added

- **Structured questions render on the card** — when an agent calls `AskUserQuestion`,
  the question text and its option labels now surface on the NEEDS-YOU card as clickable
  reply buttons. The data lived in the tool-call input all along; the card only read the
  agent's prose, so the question was invisible. Clicking an option delivers the answer
  back to the agent over its existing reply channel (terminal / tmux / cloud / team).
  (RUSH-453, RUSH-1521)

### Changed

- **Terminal detail pane now matches the headless/cloud panes** — the flat "Recent tools"
  list is replaced by the vertical progress timeline (oldest → now) plus a streaming
  "Latest" message rendered as markdown, so every agent's detail pane reads identically.
  Recent files span the full width. (RUSH-1519, RUSH-1546)

## [0.9.289] - 2026-07-08

### Fixed

- **0.9.288 failed to activate** — it was packaged without `node_modules`, so the
  extension host threw on `require()` of runtime deps (`ws`, `yaml`, MCP SDK, …) and
  no commands registered (`command 'agents.configure' not found`). Repackaged with
  dependencies included. The 0.9.288 card redesign is unchanged; this only restores
  the shipped dependencies.

## [0.9.288] - 2026-07-08

### Added

- **Readable agent cards on the Factory Floor.** Cards now lead with the agent's
  original **task** (not its last message), render **markdown** in message bodies,
  add a live **progress timeline** of recent tool calls plus a **streaming activity
  feed** of the agent's messages, keep the **todo checklist** from silently
  vanishing, and show a clean **worktree chip** instead of a raw `WT=/…/path`. The
  detail pane is reordered for legibility: Task → Progress timeline → Todos →
  Activity → PR/CI.

### Fixed

- **Shell (`SH`) tabs now load your full interactive shell environment.** Every
  tracked terminal — agent CLIs *and* bare shell tabs — carries `AGENT_TERMINAL_ID`,
  which rc files commonly use to take a minimal fast-path (skip oh-my-zsh, themes,
  plugins) for agent terminals no human types in. That mis-fired on the `SH` tab,
  which *is* an interactive shell you drive: it came up with a bare prompt, no theme,
  and missing aliases/tools. Factory now also exports **`AGENT_TERMINAL_KIND`**
  (`shell` for a bare shell tab, `agent` for an agent CLI terminal) so your rc file
  can tell them apart. Gate your fast-path on it, e.g. `zsh`:
  `if [[ -n "$AGENT_TERMINAL_ID" && "$AGENT_TERMINAL_KIND" != "shell" ]]; then …`.

## [0.9.286] - 2026-07-08

### Added

- **Factory Floor redesign — matches the approved prototype.** A cohesive pass over
  the whole dashboard:
  - **Icon rail** — compact left nav of icon buttons with count/needs badges
    (Agents · Needs · Backlog · Projects · Hosts); expands to the full text sidebar.
  - **Proper sub-tab strip** — the Floor's views (Agents / Backlog / Projects / Hosts)
    are now first-class tabs with count/needs badges, active-lime; Dispatch lives on the
    strip.
  - **One contextual controls bar** — the Group/Sort/filter controls swap to the active
    tab's set (agents Group/Sort vs backlog Group/Sort/LN/GH), so there's no more
    duplicated control bar. The old cluttered Status/Agent chip strip is gone — filtering
    lives in saved views + search.
  - **Double-click a task → its own closeable tab** — opens the full detail (rendered
    markdown, comments, images) with Dispatch right there; multiple task tabs at once.
  - **Human session labels** (`terminal-race-fix`, not `claude-596c4c07`) + a compact
    `<agent>·<id>` provenance chip; **project-link group headers** (`N agents` + Linear
    project pill).
  - **Detail-pane artifacts row** — the selected agent's PR / CI / spawned-team / created
    tickets as color-coded chips.
  - **Foreman corner FAB** — the voice orb is smaller and tucked into the corner.
  - **Grouped by project by default**, **checklist expanded by default** with the current
    step highlighted, **one-click PR link**, **created-ticket / spawned-team chips** on
    cards (backed by session scanning).

### Fixed

- **Markdown now renders in the ticket/task detail** instead of showing raw `##` /
  code-fences / `**bold**` (reuses the shared `renderTodoDescription` renderer).

## [0.9.284] - 2026-07-07

### Added

- **Factory Floor redesign — the card now shows the agent's outputs at a glance.**
  A cohesive pass over the live feed:
  - **Checklist expanded by default** on each card (still collapsible), with the
    current step highlighted so progress reads without a click.
  - **Feed grouped by project by default** (NEEDS YOU stays pinned above the groups).
  - **One-click PR link** — the `PR #N` pill is now a real link to the pull request.
  - **One unified search** — the TopBar center is the single live-feed filter; the
    duplicate search box in the Floor controls bar is gone (⌘K still opens the palette).
  - **Artifact chips** — cards surface the tracker refs the agent *created* (Linear
    `create_issue` / `gh issue create`) and any team it *spawned* (`agents teams
    create/add`), distinct from the injected/worked-on ticket. Backed by new session
    scanning (`createdTickets` / `spawnedTeam` on both the indexed scan and live
    session state).

### Fixed

- **Editor "Send to Agent" (slash-command + keyboard shortcut) silently did nothing.** The markdown editor webview may call VS Code's one-shot `acquireVsCodeApi()` only once per load, but `App.tsx` consumed it at startup while the Tiptap `KeyboardShortcuts` (`Mod-Shift-a` / `Mod-Shift-i`) and `SlashCommands` ("Send to Agent" / "Ask Agent") extensions each re-called `acquireVsCodeApi()` on use — a second acquisition that throws / yields `undefined`, so their `if (vscode)` guard fell through and the `postMessage` never fired. All four call sites plus `App.tsx` now share a single cached handle via a new `ui/editor/vscodeApi.ts` (`getVsCodeApi()`), acquired at most once. Regression test (`vscodeApi.test.ts`) simulates the single-acquire contract. Source: `apps/factory/ui/editor/vscodeApi.ts`, `App.tsx`, `extensions/KeyboardShortcuts.ts`, `extensions/SlashCommands.ts`.

## [0.9.283] - 2026-07-07

### Fixed

- **GitHub links pointed at a retired repo.** `package.json` `repository`, the
  settings "Open GitHub" action, and the Guide tab's "Learn More" link now all point
  to `github.com/phnx-labs/agents-cli` (`apps/factory`). Publish identity — publisher
  `swarmify`, name `swarm-ext`, appId — is unchanged.
- **Factory Floor feed showed identical, contextless cards for co-located sessions.**
  Ported the swarmify/extension feed fixes: fan-out remote-session enrichment now
  attributes each row to the correct device (`machine`), surfaces the worktree slug,
  live preview, structured ticket id, and real branch, and caches `startedAtMs` by
  PID so a terminal's start time no longer drifts to `Date.now()` on every republish.
  Consolidated the duplicated feed model into a single `@shared` implementation with
  a `MISSING_EXPORT` build-time drift guard.

### Added

- **tmux terminals by default** (`agents.terminalMode: auto | tmux | native`) with each
  agent terminal publishing its tmux pane (`%N`) and editor-tab index, surfaced as the
  pane handle and "viewing in <tab>" on Factory Floor cards. Gives same-cwd agents
  distinct, addressable identities.
- **tmux pane border now shows the live session label.** The border was seeded once with
  the bare agent code (e.g. `0: CC`) and never updated. It now tracks the same auto-label
  as the editor tab — the moment the session topic resolves (auto-label poller / focus
  fetch / manual rename), the border re-renders to `0: CC - <topic>` on the shared socket,
  even when the terminal isn't focused. This matters most when a session is reattached
  from a plain terminal outside the editor, where the border is the only label surface.
