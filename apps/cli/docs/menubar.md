# Menu bar

A macOS status-bar item that surfaces live agent activity on the machine.

## Overview

The menu bar helper (`MenubarHelper.app`) is a no-Dock, `.accessory` status-bar
app. Its icon — the agents-cli `a` mark — sits in the menu bar and answers, at a
glance, "what are my agents doing right now, and does anything need me?"

It reads state **directly from disk** and never invokes the `agents` CLI to
populate the menu, so opening it costs a few file reads and never triggers the
sessions transcript re-index. It shells the CLI only for *actions* (starting a
session, running a routine).

macOS only. It is auto-enabled for every user (see [Lifecycle](#lifecycle)); opt
out with `agents menubar disable`.

## Quick dispatch

`Cmd-Shift-O` opens the Spotlight-style capture panel. Type a short request,
optionally attach recent screenshots from the thumbnail strip, then pick one
agent for **File Ticket** or one or more agents for **Fix**.

- **File Ticket** sends the note and selected screenshots to the selected ticket
  agent, which investigates and files one Linear ticket.
- **Fix** fans out to every selected agent with `agents run <agent> --mode auto
  --name quick-<agent>-<timestamp>`, so the resulting sessions appear in normal
  `agents sessions` and menu-bar surfaces instead of as opaque background work.

Set `AGENTS_QUICK_DISPATCH_ROSTER=claude,codex` in the helper environment to
filter which agents appear in the picker, and
`AGENTS_QUICK_DISPATCH_AGENTS=claude,codex` to change which visible agents are
preselected. Without a roster override, the picker uses the same roster as the
menu bar's New Session submenu.

## The dropdown

```
 a !                      icon + badge (red ! = needs you, green N = N running)
 ┌─ agents ─────────────────────────────┐
 │ NEEDS YOU (2)                         │   sessions awaiting input +
 │   ! claude  api  awaiting input    ›  │   failed / overdue routines
 │   ! routine nightly-sync  failed   ›  │
 ├────────────────────────────────────────┤
 │ New session                       ⌘N  │   submenu: one entry per installed agent
 ├────────────────────────────────────────┤
 │ AGENTS · 2 running · 3 idle           │
 │   claude    ● 2 running            ›  │   per-agent counts; submenu lists the
 │   codex     ○ idle                ›  │   sessions and a "New <agent>" launcher
 │   …                                   │
 ├────────────────────────────────────────┤
 │ routines  next 9:00am · 1 failed   ›  │   one compact line (secondary)
 ├────────────────────────────────────────┤
 │ Stop scheduler                        │   shown when the routines daemon is up
 │ Quit menu bar                     ⌘Q  │   disables the launchd service
 └────────────────────────────────────────┘
```

- **NEEDS YOU** — pinned on top. Sessions blocked waiting for you, plus routines
  whose last run failed, timed out, or that are overdue. Empty when nothing needs
  attention.
- **New session** — launches `agents run <agent>` in a new Terminal window.
- **AGENTS** — every installed agent with running / idle counts. A session is
  *running* if its transcript was written in the last 2 minutes, else *idle*.
- **routines** — next run and failed count; the submenu lists all routines with
  Run now / Logs.

The icon badges **red `!`** when anything needs you and **green with a count**
when sessions are running; otherwise it is the bare mark.

## Commands

```
agents menubar            # status (also: agents menubar status)
agents menubar enable     # install + start the launchd login service
agents menubar disable    # stop + remove it (sticky opt-out)
agents menubar status     # installed / running, versions, staleness; --json
```

`status` reports the installed bundle version vs. the current CLI version and
whether the install is stale (see [Lifecycle](#lifecycle)).

## Data sources

The helper assembles the menu by reading these directly — no CLI, no re-index:

| Source | Path | Gives |
|---|---|---|
| Terminals | `~/.agents/.cache/terminals/live-terminals.json` | terminal / IDE sessions (agent, cwd, pid) |
| Teams | `~/.agents/.history/teams/agents/<id>/meta.json` | running teammate agents |
| Cloud | `~/.agents/.cache/cloud/tasks.db` (SQLite) | cloud tasks, incl. `input_required` or `needs_review` → "awaiting input" |
| Attention sentinels | `~/.agents/.cache/state/attention/<sessionId>` | terminal sessions awaiting input (written by the Notification hook) |
| Installed agents | `~/.agents/.history/versions/<agent>/` | the agent roster |

Liveness is a `kill(pid, 0)` check; running-vs-idle is the transcript file's
mtime. The teams directory accumulates history, so the periodic badge refresh
skips it — the full teams scan runs only when the menu opens.

## Lifecycle

The helper is a launchd user service (`com.phnx-labs.agents-menubar`,
`RunAtLoad` + `KeepAlive`), installed to
`~/Library/Application Support/agents-cli/MenubarHelper.app`.

- **Auto-enable.** On every macOS CLI invocation a cheap self-heal installs the
  service if it is missing — so a fresh install brings the icon up without a
  manual step.
- **Upgrade refresh.** The installed bundle is stamped with the CLI version. When
  a newer release ships a newer helper (or the installed copy goes missing), the
  self-heal re-copies the bundle, rewrites the plist, and restarts it — so
  `npm update` actually moves users onto the new helper instead of leaving the
  old one running.
- **Opt-out is sticky.** `agents menubar disable` writes
  `~/.agents/.cache/state/menubar.disabled`; the auto-enable honors it, so a
  disabled menu bar never silently returns on the next upgrade. Re-enable with
  `agents menubar enable`.

## Files

| Path | Purpose |
|---|---|
| `~/Library/LaunchAgents/com.phnx-labs.agents-menubar.plist` | launchd service |
| `~/Library/Application Support/agents-cli/MenubarHelper.app` | installed helper bundle |
| `~/Library/Application Support/agents-cli/.menubar-version` | installed-version stamp |
| `~/.agents/.cache/state/menubar.disabled` | sticky opt-out marker |
| `~/.agents/.cache/helpers/menubar/menubar.log` | helper stdout / stderr |
