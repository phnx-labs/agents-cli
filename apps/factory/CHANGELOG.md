# Changelog

All notable changes to the Factory extension are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); `scripts/release.sh` requires a
`## [<version>]` section for the version being published.

## [Unreleased]

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
