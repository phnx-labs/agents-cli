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

## Clip paste (`Cmd-Shift-V`)

`Cmd-Shift-V` hands whatever is on the clipboard to the agent in the focused
terminal as a native scp-style reference — `<host>:<abs-path>` — instead of
pasting raw bytes that would mangle a terminal or an ssh'd session. A screenshot
that lives only on the clipboard is written to
`~/.agents/.history/attachments/`, a copied file is snapshotted there under an
scp-safe name, and a copied directory is referenced in place. The agent reads
the path directly when `host` is its own machine and `scp`s it otherwise, so the
same token works whether the session is local or on another box.

The paste synthesizes a `Cmd-V` keystroke, which needs an **Accessibility**
grant for "Agents Menu Bar" (System Settings > Privacy & Security >
Accessibility). Without it the helper copies the reference to the clipboard and
notifies you to paste it yourself, so the clip is never lost.

### Do not hand-launch the helper

TCC grants are keyed to a code identity, and `RegisterEventHotKey` is
first-come. A helper started **from an ssh session** therefore breaks the paste
twice over: macOS attributes its Accessibility request to the responsible
process, `/usr/libexec/sshd-keygen-wrapper`, so the prompt names a process whose
grant does nothing for the helper — and granting it would let anything an ssh
session spawns synthesize keystrokes — while the chord it registered no longer
reaches the launchd-managed helper that *is* trusted.

The interactive mode refuses to start in that situation, and refuses
unrecognized arguments (an unknown flag used to fall through to the status-bar
app, leaving a permanent second helper). Start it through launchd instead:

```bash
agents menubar enable      # works over ssh — launchd starts it in the GUI session
```

If a chord stops working, `agents menubar status` lists any other live helper
process with its pid; end it and re-run `agents menubar enable`.

## Quick dispatch

`Cmd-Shift-O` opens the Spotlight-style capture panel. Type a short request,
optionally attach recent screenshots from the thumbnail strip, then pick one
agent for **File Ticket** or one or more agents for **Fix**.

- **File Ticket** sends the note and selected screenshots to the selected ticket
  agent, which investigates and returns ticket fields as JSON. The helper then
  runs `linear create` itself, appending `--image <path>` for every selected
  screenshot so the image bytes are uploaded at create time and embedded in the
  issue description — screenshot paths never pass through an LLM-authored shell
  string.
- **Fix** fans out to every selected agent with `agents run <agent> --mode auto
  --name quick-<agent>-<timestamp>`, so the resulting sessions appear in normal
  `agents sessions` and menu-bar surfaces instead of as opaque background work.

Set `AGENTS_QUICK_DISPATCH_ROSTER=claude,codex` in the helper environment to
filter which agents appear in the picker, and
`AGENTS_QUICK_DISPATCH_AGENTS=claude,codex` to change which visible agents are
preselected. Without a roster override, the picker uses the same roster as the
menu bar's New Session submenu.

If another app steals focus while you are typing, the panel hides but keeps the
draft note plus the selected screenshots, action, and agents for the next
`Cmd-Shift-O` summon. Return submits and clears the draft; Escape clears it
without dispatching.

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
  group. Blocked sessions are grouped by (agent, repo): a group of 1 renders
  inline with the actual question it's waiting on (or bare when the Notification
  hook wrote no message); a group of 2+ collapses to one
  `<Agent> · <repo> · N waiting · oldest <elapsed> ›` row with a submenu that
  lists each session (oldest first). Groups themselves sort by their oldest
  wait. Failed / overdue routines and a stopped scheduler append here. Empty
  when nothing needs attention.
- **New Session** — launches `agents run <agent>` in a new Terminal window.
- **ACTIVE · \<repo\>** — live work grouped by repo. A session is *running* if
  its transcript was written in the last 2 minutes, else *idle*. Rich rows show
  the session's title inline; the row's submenu reveals the working dir. Idle
  rows cap at 3 per repo; if the cap hides any, a `+ N more idle ›` row exposes
  the hidden count and opens the rest in a submenu — the header count always
  matches what's visible + explicit hidden. The `"other"` bucket (sessions with
  no repo — a dumping-ground group whose rows carry no per-row signal) collapses
  to a single `ACTIVE · other · N idle ›` row + submenu when it's idle-only.
- **ROUTINES** — kept glanceable: the next few upcoming plus any failed, timed-out,
  or overdue routine inline. Failed and timed-out routines include the latest
  failure reason when available; overdue routines are labeled `overdue` even when
  their previous run succeeded. Each submenu has Run now / Pause / Logs, and Logs
  opens the concise routine summary in a text viewer.
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
whether the install is stale (see [Lifecycle](#lifecycle)). `running` tracks the
**installed bundle** specifically, identified by its resolved executable; any
other live `MenubarHelper` process is listed separately with its pid (
`foreignInstances` in `--json`) because a second copy silently takes the global
chords — see [Do not hand-launch the helper](#do-not-hand-launch-the-helper).

## Data sources

The helper assembles the menu by reading these directly — no CLI, no re-index:

| Source | Path | Gives |
|---|---|---|
| Terminals | `~/.agents/.cache/terminals/live-terminals.json` | extension-registered terminals (agent, cwd, pid, label) — cold start + 10s badge poll |
| Active sessions | `agents sessions --active --local --json` (warm cache, 30s TTL) | every local session (tmux / IDE / headless) with running-vs-idle — feeds triage + ACTIVE once loaded |
| Teams | `~/.agents/.history/teams/agents/<id>/meta.json` | running teammate agents |
| Cloud | `~/.agents/.cache/cloud/tasks.db` (SQLite) | cloud tasks, incl. `input_required` or `needs_review` → "awaiting input" |
| Attention sentinels | `~/.agents/.cache/state/attention/<sessionId>` | terminal sessions awaiting input — mtime = wait start, content = the awaiting message (written by the Notification hook). On read, sentinels whose sessionId is not in the current live-terminals set are unlinked as orphans (defense against sessions killed hard, hookless Claude versions, or sessionId mismatches). |
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

## Notifications

The helper doubles as the daemon's branded desktop-notification channel
(RUSH-2030). The daemon fires a notification by spawning the installed bundle in
a one-shot mode:

```bash
MenubarHelper --notify --title T --body B [--subtitle S] [--action A]
```

Because the poster is the app bundle, macOS attributes the notification to the
agents-cli helper and shows its `AppIcon` (the agents-cli mark) instead of the
generic osascript icon. The one-shot delivers via `NSUserNotificationCenter`,
briefly spins the runloop so delivery flushes, then exits — it never starts the
status-bar UI. The persistent menu-bar instance registers the click delegate at
launch (`Notifier.wireClickHandler`), so clicking a daemon notification runs its
`--action`: `open:<path>` opens a run report/log, `routines:list` opens the runs
folder. The Node side lives in `src/lib/menubar/notify-desktop.ts` (routing) and
`src/lib/routine-notify.ts` (routine start/finish content + anti-spam
threshold); see [routines.md](03-routines.md#desktop-notifications).

**Bounded lifetime (no pile-up).** A one-shot posts and exits in well under a
second, but a stalled delivery — a locked screen, a WindowServer/XPC hiccup —
could otherwise leave a detached notifier hanging and duplicate "Agents"
instances accumulating in the menu bar. Two independent watchdogs bound it:
`runOneShot` arms a background-thread force-exit at 3s (it runs off the main
queue so a wedged main thread can't starve it, unlike the 0.6s runloop deadline
it backs up), and the Node spawner (`spawnDetachedQuiet`) SIGKILLs the child at
4s if it never self-exits. So a notifier can never linger indefinitely. Stale
helpers that predate `--notify` (and would ignore it and hang) are replaced by
the upgrade self-heal (`installMenubarLaunchAgentOnUpgrade`), which reinstalls
the current bundle on any version bump.

## Files

| Path | Purpose |
|---|---|
| `~/Library/LaunchAgents/com.phnx-labs.agents-menubar.plist` | launchd service |
| `~/Library/Application Support/agents-cli/MenubarHelper.app` | installed helper bundle |
| `~/Library/Application Support/agents-cli/.menubar-version` | installed-version stamp |
| `~/.agents/.cache/state/menubar.disabled` | sticky opt-out marker |
| `~/.agents/.cache/helpers/menubar/menubar.log` | helper stdout / stderr |
