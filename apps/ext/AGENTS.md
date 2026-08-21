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
  store and derives no lifecycle state.
- Resume/Fork opens one on-demand listing with `agents sessions --all --json
  --no-interactive --limit 60`, then calls `agents sessions resume <id>
  --vscodium` or `agents sessions fork <id>`.
- Automatic launch is `agents run auto --interactive --device auto --strategy
  balanced --mode auto`, plus `--project <slug>` when the workspace resolves to
  a defined project and `--model <name>` when that harness has a Default Model
  set. Explicit harness/host controls pass the user's choice to agents-cli; the
  extension never scores hosts, harnesses, versions, or accounts. Every launch
  is built by `buildAgentLaunchCommand` (`src/core/agents.ts`) — the one place
  that owns flag construction. The two launch paths (`launchAgent` and
  `openSingleAgent`) register their tab through the shared
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
