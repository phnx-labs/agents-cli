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
  agent, which investigates and files one Linear ticket. Selected screenshot
  paths are identified as user-provided ticket material, and the agent uploads
  every selected file using whichever issue placement communicates it best.
- **Fix** fans out to every selected agent with `agents run <agent> --mode auto
  --name quick-<agent>-<timestamp>`, so the resulting sessions appear in normal
  `agents sessions` and menu-bar surfaces instead of as opaque background work.

Set `AGENTS_QUICK_DISPATCH_ROSTER=claude,codex` in the helper environment to
filter which agents appear in the picker, and
`AGENTS_QUICK_DISPATCH_AGENTS=claude,codex` to change which visible agents are
preselected. Without a roster override, the picker uses the same roster as the
menu bar's New Session submenu.

## The dropdown

One rule shapes the menu: **attention floats up, context groups down.**

```
 a !                      icon + badge (red ! = needs you, green N = N running)
 ┌─ agents ──────────────────────────────────────┐
 │ ⚠ NEEDS YOU (3)                               │   triage strip: wait-time sorted
 │   ⚠ Claude · api — Apply rename?    ·  2h 25m ›│   across ALL projects, question
 │   ⚠ Claude · web — awaiting input   ·  3m     ›│   + how long it's waited
 │   ✕ 2 routines failing                        ›│
 ├────────────────────────────────────────────────┤
 │ New Session                                ⌘N │   submenu: one entry per agent
 ├────────────────────────────────────────────────┤
 │ ACTIVE · api  ·  1 running                    │   live work grouped by repo;
 │   ● Claude — draining Linear queue          ›  │   rich rows carry the session's
 │ ACTIVE · web  ·  1 running                    │   own title inline
 │   ● Codex — building hero section           ›  │
 ├────────────────────────────────────────────────┤
 │ ROUTINES · 16 · next 7:00 PM · 2 paused       │   next few upcoming + failing
 │   ◔ triage-tickets  in 22m                  ›  │   inline; All routines… for
 │   ✕ crm-brief  failed                       ›  │   the rest
 │   All routines…                             ›  │
 ├────────────────────────────────────────────────┤
 │ RECENT TICKETS / RECENT                       │   dedicated, glanceable
 ├────────────────────────────────────────────────┤
 │ System    all set · auto-nudge off          ›  │   setup + watchdog collapsed
 ├────────────────────────────────────────────────┤
 │ Density: Auto                                 │   Auto → Rich → Compact
 │ Stop scheduler · Settings · Quit          ⌘Q  │
 └────────────────────────────────────────────────┘
```

- **⚠ NEEDS YOU** — the triage strip, pinned on top and never nested in a project
  group. Blocked sessions sorted by wait-time (most-stalled first, regardless of
  repo), each showing the actual question it's waiting on (attention-sentinel
  content) and elapsed wait (sentinel mtime). Failed / overdue routines and a
  stopped scheduler append here. Empty when nothing needs attention.
- **New Session** — launches `agents run <agent>` in a new Terminal window.
- **ACTIVE · \<repo\>** — live work grouped by repo. A session is *running* if
  its transcript was written in the last 2 minutes, else *idle*. Rich rows show
  the session's title inline; the row's submenu reveals the working dir.
- **ROUTINES** — kept glanceable: the next few upcoming plus any failing routine
  inline (Run now / Pause / Logs in each submenu), `All routines…` for the rest.
- **RECENT TICKETS / RECENT** — tickets filed via quick dispatch and recent
  sessions, unchanged dedicated sections.
- **System** — setup staleness + the auto-nudge watchdog collapsed into one row;
  the submenu keeps the doctor items and the auto-nudge toggle.
- **Density** — cycles Auto → Rich → Compact (persisted as `menubarDensity` in
  UserDefaults; `MENUBAR_DENSITY` env overrides for probes). Compact folds rows
  to one-liners and tucks Routines / Recent behind submenus. Auto is rich while
  something needs you, compact on a calm machine.

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
| Terminals | `~/.agents/.cache/terminals/live-terminals.json` | extension-registered terminals (agent, cwd, pid, label) — cold start + 10s badge poll |
| Active sessions | `agents sessions --active --local --json` (warm cache, 30s TTL) | every local session (tmux / IDE / headless) with running-vs-idle — feeds triage + ACTIVE once loaded |
| Teams | `~/.agents/.history/teams/agents/<id>/meta.json` | running teammate agents |
| Cloud | `~/.agents/.cache/cloud/tasks.db` (SQLite) | cloud tasks, incl. `input_required` or `needs_review` → "awaiting input" |
| Attention sentinels | `~/.agents/.cache/state/attention/<sessionId>` | terminal sessions awaiting input — mtime = wait start, content = the awaiting message (written by the Notification hook; empty content renders "awaiting input") |
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
