# Agents Extension

AGI EXT is the VS Code/VSCodium presentation client for agents-cli. It owns
editor terminals, tabs, windows, QuickPicks, webviews, readiness signals, and
the `swarm-ext://` endpoint. It does not own fleet or agent policy.

## Thin-client contract

- agents-cli owns sessions, devices, accounts, teams, watchdog,
  routines, lifecycle, ranking, deduplication, and scheduling.
- The elected extension monitor owns one `agents sessions watch --json` child
  across editor windows. It broadcasts versioned `reset`, `upsert`, `remove`,
  `scope`, and `heartbeat` events; each extension host has one presentation
  store and derives no lifecycle state. Editor tabs reconcile their provisional
  topic-based auto-labels from that same stream when a harness-owned session
  `label` arrives; a manual tab label still wins.
- Resume/Fork opens one on-demand listing with `agents sessions --all --json
  --no-interactive --limit 60`, then calls `agents sessions resume <id>
  --vscodium` or `agents sessions fork <id>`.
- `Agents: New <Harness>` passes the configured target to
  `agents run <harness> --interactive --strategy balanced`, so agents-cli
  resolves the device and the account without prompting — the everyday launch
  opens an agent, never a question. `(Pick Host)` is the one explicit-choice
  route: it asks for the device, then uses `agents run <harness>@` so the picker
  shows that device's installed versions/accounts, and emits the CLI's canonical
  `--device` flag, never the retired `--host` spelling. `(Auto)` uses
  `agents run <harness> --strategy balanced`, so agents-cli chooses both. The
  generic automatic launch stays `agents run auto --interactive --device auto
  --strategy balanced --mode auto`. Launches also add `--project <slug>` when
  the workspace resolves to a defined project and `--model <name>` when that
  harness has a Default Model set. The extension never scores hosts, harnesses,
  versions, or accounts. Every launch
  is registered and assembled by `harnessLaunchRegistrations` and
  `buildNewAgentLaunchCommand` (`src/core/launchTarget.ts`), which delegate flag
  construction to `buildAgentLaunchCommand` (`src/core/agents.ts`). The two
  launch paths (`launchAgent` and `openSingleAgent`) register their tab through the shared
  `registerAgentTerminal`; other creation sites still call `terminals.register`
  directly. An automatic launch registers against the `shell` def until adoption
  re-keys it to the harness the CLI picked — the `sh` prefix is load-bearing,
  since `armShellAdoptionForTerminal` only arms for it. An unregistered tab is
  invisible to Copy Session ID / Resume / Fork and is not restored after a
  window reload.
- Other reads use their CLI noun: `devices list/status/accounts`, `teams ...
  --json`, `watchdog status/history`, and `routines ... --json`. Ticket reads
  use `linear tasks --json` and `gh issue list` (the former `agents tickets`
  command is gone, RUSH-2932). Missing nouns are upgrade errors, never
  filesystem/polling fallbacks.
- The extension must not add an action scheduler, transcript parser/watcher,
  lifecycle classifier, candidate cache, or raw agents config reader.

## Layout

```
src/core       Presentation-only pure functions
src/monitor    Elected stream leader and cross-window broadcast
src/vscode     VS Code commands, terminals, URI endpoint, webview bridge
ui/settings    React dashboard
ui/editor      Custom document viewers
assets         Extension artwork
```

## Fleet session row

The Sessions surface (`ui/settings/components/mission-control/SessionsPane.tsx`)
renders every row as three aligned lines, matching the committed mockup at
`.agents/artifacts/2026-08-23/mockup-session-row.html`:

- **Title** (bold) + provenance badge (`agent recap` | `last line` | `renamed`).
- **You ›** — the user's prompt, processed: image → `screenshot` chip (no path),
  pasted command → `$ cmd` chip, skill → `/continue` chip, plain text as-is.
  Role tags are a fixed 62px right-aligned column.
- **Claude ›** (or the harness name) — last agent line, dimmed; `⌄ more`
  expands the full last message inline.
- Chips: repo (cwd basename), PR # with a CI dot (green/amber/red), branch, host.
- Per-row **↻ Resume** posts the same `onResume` the group's **Resume all N** uses.
- Right-edge live dot: green working, amber idle, grey done. Reconnect is the
  left pdot + group band.

Prompt processing and the CLI-watch adapter live in `recapModel.ts`
(`processUserPrompt`, `sessionRowView`). Prefer watch JSON fields (`title`,
`recapSource`, `userPromptClean`, `userPromptKind`, `lastAgentLine`) when
present; otherwise bind `TerminalDetail` / `FloorAgent`
(`narrative`, `lastAssistantMessage`, `firstUserMessage`, `branch`, `cwd`,
`status`, `prompt`, `resp`).

## Build and test

Run `bun install` once in `apps/ext`, then:

```bash
bun run compile:ext
bun test
```

Use `scripts/build.sh <version>` and `scripts/release.sh <version>` for packaged
builds/releases; do not hand-roll `tsc`, `vsce publish`, or `ovsx publish`.

Tests sit beside source and exercise real command boundaries. User-visible
changes update this file, `README.md`, and `CHANGELOG.md`.
