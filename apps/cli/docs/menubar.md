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
session spawns synthesize keystrokes — and, if it wins the chord, Cmd-Shift-V
stops reaching the launchd-managed helper that *is* trusted. Which of the two
wins comes down to which registered the chord first, so the outcome is
arbitrary.

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
optionally attach recent screenshots from the thumbnail strip, pick the repo to
work in, then pick one agent for **Plan** or one or more agents for **Run**.

- **Plan** sends the note and selected screenshots to the selected ticket agent,
  which investigates and returns ticket fields as JSON. The helper then runs
  `linear create` itself, appending `--image <path>` for every selected
  screenshot so the image bytes are uploaded at create time and embedded in the
  issue description — screenshot paths never pass through an LLM-authored shell
  string.
- **Run** fans out to every selected agent with `agents run <agent> --mode auto
  --balanced --notify --name <slug-of-your-note>`, so the resulting sessions
  appear in normal `agents sessions` and menu-bar surfaces instead of as opaque
  background work.

The repo dropdown comes from recent session working directories, never `$HOME`
(running an agent straight in the home directory is too broad a permission
surface), and passes `--cwd` to the dispatch. The last pick is remembered.

`--notify` is what makes a dispatch report back. The run is launched **detached**
and posts its own "finished"/"failed" notification when it ends (see
[Notifications](#notifications)). Earlier the helper monitored the child and
posted from the process-termination callback — which lived in the helper, so a
helper that restarted mid-run (an upgrade replacing the bundle, a crash) took the
callback with it. The run carried on, reparented to launchd, and could never
report back. Nothing about the menu bar's lifetime affects the notice now.

Set `AGENTS_QUICK_DISPATCH_ROSTER=claude,codex` in the helper environment to
filter which agents appear in the picker, and
`AGENTS_QUICK_DISPATCH_AGENTS=claude,codex` to change which visible agents are
preselected. Without a roster override, the picker uses the same roster as the
menu bar's New Session submenu.

If another app steals focus while you are typing, the panel hides but keeps the
draft note plus the selected screenshots, action, and agents for the next
`Cmd-Shift-O` summon. Return submits and clears the draft; Escape clears it
without dispatching.

### The ticket list

The panel captures new work; the rows under it are the work that already exists —
the open Linear tickets of the project scoped to the repo you picked, so you can
pick one up instead of filing a duplicate.

Controls sit on **one compact row** of popups (same language as the repo picker —
not a chip grid or two-column block):

```
Tickets  [Agents CLI ▾]  [All open ▾]  [Urgent first ▾]  12/58 · urgent first · ⌘N
 ⌘1  P1  RUSH-1968  Doing  …
 ⌘2  …                                    ← scroll when there are more rows
```

- **Project is 1:1 with Linear.** The project popup is the ticket scope. Switching
  the repo dropdown auto-selects the matching Linear project (the repo name is
  matched against `linear projects` after both are reduced to lowercase
  alphanumerics, so `agents-cli` finds **Agents CLI** with nothing to configure).
  A repo whose name matches no project says so — pick the project once and that
  choice is remembered for that repo. A worktree resolves to its parent repo
  (via git's common dir), not to the worktree's own directory name.
- **Quick filter (dropdown).** One popup, not chips: All open · Todo · Doing ·
  Backlog · P1 only · P2 only · Overdue. The last pick is remembered.
- **Quick sort (dropdown).** Flat list only — no status group headers. Options:
  Urgent first (default: Linear priority, then overdue, then in progress, then
  newest) · Newest · Oldest · Due date · Priority. The last pick is remembered.
- **Scrollable rows.** The list viewport shows about five rows; more matches
  scroll inside the bar so the capture field stays put. Up to 40 rows are kept
  after filter+sort.
- **Typing also filters.** Every word you type has to appear in a row's
  identifier or title (AND with the filter), so an existing ticket surfaces
  before Return files a new one.
- **Click a row to dispatch it** to the selected agents in the picked repo
  (`⌘1` … `⌘9` for the first nine listed). **Plan** posts an implementation plan
  as a comment on the ticket and changes no code; **Run** claims the ticket
  (moving it to whichever state `linear states` reports as `started`), implements
  it per the repo's `AGENTS.md`, and comments the result. Both are the same
  headless `agents run --mode auto --balanced --notify` dispatch as a quick Run,
  named after the ticket (`rush-2098`, `rush-2098-plan`) so it reads as that
  ticket in `agents sessions`. **`⌘`-click** opens the ticket in Linear instead.

A `linear tasks` round trip costs seconds, so the list renders from a warm cache
(`~/.agents/.history/menubar/linear-cache.json`) and refreshes in the background;
entries older than 90 seconds are re-fetched on the next summon.

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
 │ New Task…                                  ⌘T │   opens the quick-dispatch bar
 │ New Session                                ⌘N │   submenu: one entry per agent
 ├────────────────────────────────────────────────┤
 │ ACTIVE · 3 run · 1 idle · 2 projects          │   projects collapsed by default
 │   ▶ agents-cli  ●2 ◐1  zion                   │   accordion: ▶ folds agents open
 │   ▼ web  ●1  zion                             │
 │     ● Codex · zion · 12m  ⌥ PR#42 — title   › │   › side submenu = full detail
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
- **New Task…** — opens the quick-dispatch bar (the same panel as `Cmd-Shift-O`):
  type the task, pick agents and a repo, and it runs headless. One panel serves
  both entry points, so an interrupted capture is restored whichever way you come
  back to it. Use this when you want work *done*; use New Session when you want
  to sit in the TUI.
- **New Session** — shells `agents run <agent> --terminal`, which opens the agent
  in **the terminal you actually work in**. The CLI resolves that from your live
  sessions' host app (`agents sessions --active` → `host`), so a Ghostty user gets
  a Ghostty tab and an iTerm user an iTerm tab; Terminal.app is the fallback when
  nothing running names a terminal the engine can drive. See
  [terminal-engine.md → Choosing a terminal](terminal-engine.md#choosing-a-terminal-for-a-gui-caller).
  (It used to always open Terminal.app.)
- **ACTIVE** — **project accordion** + **session detail submenu**. Projects are
  **collapsed by default** as a status strip (`▶ agents-cli  ●8 ◐1  zion`).
  Click `▶`/`▼` to fold the project open **inline** and list its agents.
  Focusing an agent row opens a **side submenu (›)** with richer detail and
  **linkable actions**: work title (and open URL if the title contains one),
  local/remote + surface, clickable cwd, Linear ticket, GitHub PR, duration,
  copy session id, optional preview snippet. Chips on the agent row itself
  (`🎫 RUSH-…`, `⌥ PR#N`) surface links at a glance. All of that comes from the
  warm `sessions --active --local` cache; expand never shells the CLI or
  re-indexes transcripts. Work titles prefer the session `topic` over a bare
  agent name.
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

The icon badges **red `!`** when anything needs you, **red `⏻`** when the
scheduler has been unreachable for ~30s (see
[Daemon-down watchdog](#daemon-down-watchdog) below — independent of the
dropdown ever opening), and **green with a count** when sessions are running;
otherwise it is the bare mark.

## Commands

```
agents menubar            # status (also: agents menubar status)
agents menubar setup      # configure end-to-end: one instance, started at login
agents menubar enable     # install + start the launchd login service
agents menubar disable    # stop + remove it (sticky opt-out)
agents menubar status     # installed / running, versions, staleness; --json
```

`setup` is the command to reach for when the menu bar is wrong — a duplicate
icon, a helper that did not come up, a machine that was never configured. It is
idempotent, and each concern is a reported step, so a partial failure names
itself instead of hiding behind "enabled":

```
$ agents menubar setup
Menu bar setup

  + duplicates      ended 2 running helpers (93048, 97417) — launchd restarts exactly one
  ✓ bundle          /Users/me/Library/Application Support/agents-cli/MenubarHelper.app (1.20.89)
  ✓ signature       valid
  ✓ login item      com.phnx-labs.agents-menubar — starts at login, restarts if it dies
  ✓ single instance pid 98566

Menu bar configured.  One agents mark, started at login.
```

It ends **every** live helper and lets launchd restart one, so the survivor is
always the login-managed copy — picking a survivor out of a process list cannot
guarantee that, and keeping the un-managed copy would re-create the duplicate at
the next login. It also clears a previous `agents menubar disable`, and exits
nonzero if it cannot reach the one-instance end state. `--check` reports the
current state without changing anything; `--json` emits the step list.

`status` reports the installed bundle version vs. the current CLI version and
whether the install is stale (see [Lifecycle](#lifecycle)). Live helper processes
are split two ways in `--json`: `instances` are copies of the **installed
bundle**, identified by resolved executable, and `foreignInstances` is every
other `MenubarHelper` process. **More than one entry in `instances` is the
duplicate menu-bar icon** — see [One instance, always](#one-instance-always).
`RegisterEventHotKey` is first-come, so a second copy may be the one holding the
global chords — which of the two won is not answerable from a process list, so
status reports the conflict rather than a winner. See
[Do not hand-launch the helper](#do-not-hand-launch-the-helper).

## One instance, always

The helper refuses to be the second status item. At launch it takes an
`flock(2)` on `~/.agents/.cache/state/menubar.lock` and holds the descriptor for
its whole life; a helper that cannot take the lock posts a distributed
notification that pops the **running** helper's menu open, then exits 0:

```
$ "…/MenubarHelper.app/Contents/MacOS/MenubarHelper"
MenubarHelper: already running (pid 6815) — surfaced it instead of adding a second status item.
```

Re-launching a menu-bar app means "show me the one I already have", so
surfacing the incumbent is the answer, and exiting 0 keeps launchd's `KeepAlive`
from reading the surrender as a crash.

An `flock` rather than a pid file: a helper `SIGKILL`ed by the code-signing
monitor leaves its pid behind, and every later launch would then read a stale
"already running" and never start. The kernel releases an `flock` when the holder
dies however it dies, so the state cannot go stale.

Two copies of the installed bundle used to be reachable through ordinary paths —
launchd's `KeepAlive` service plus a LaunchServices/`open` launch of the same
`.app` (a Finder open, a re-open after a crash, a second `agents menubar
enable`). Both ran the same executable, so status collapsed them to a healthy
`running: yes` while the user looked at two agents marks. Both halves are fixed:
the helper can no longer become the second, and `status` now lists every copy.

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
| Linear tickets | `linear projects` / `linear tasks --all --project <p> --status open --cycle all` (warm cache, 90s TTL) | the quick-dispatch ticket list, scoped to the picked repo's project |

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
  `agents menubar setup` (or `agents menubar enable`), either of which clears the
  sentinel.
- **Recovery is one command.** When any of the above has gone wrong on a
  machine — never configured, helper down, duplicate icon —
  `agents menubar setup` re-establishes the whole intended state and says which
  parts it had to change.

## Notifications

The helper doubles as the branded desktop-notification channel for the daemon
(RUSH-2030) and for any `agents run --notify`. The caller fires a notification by
spawning the installed bundle in a one-shot mode:

### Daemon-down watchdog

The daemon's own overdue check (`notifyOverdue`, `src/lib/overdue.ts`) can only
ever fire from **inside** `runDaemon()` — so it is structurally blind to the one
outage that matters most: the daemon itself being down, at which point no
routine fires and nothing says so. `MenubarHelper` closes that gap because it is
a **separate** launchd `KeepAlive` service — it stays alive exactly when the
daemon dies.

`StatusItemController.tick()` (the same 10s timer that refreshes the badge)
calls `checkDaemonLiveness()` on every fire, independent of whether the dropdown
is ever opened:

- Liveness is the same cheap, synchronous `AgentsCLI.daemonPid()` probe
  `menuWillOpen` already uses (a pid-file read + `kill(pid, 0)`; no CLI spawn).
- A debounce of `daemonDownTickThreshold` (3) consecutive dead ticks — about
  30 seconds — must elapse before alerting, so a routine restart (a version
  upgrade, an `agents doctor` self-heal, a crash-relaunch) never pages the user
  for a blip.
- Once past the threshold it fires **one** notification per outage —
  `"Scheduler stopped — routines won't run"` — via `Notifier.post` directly
  (this persistent process's own `NSUserNotificationCenter` delivery, the same
  call site `AgentsCLI.swift`'s ticket-flow notices already use), not a spawned
  `--notify` child process. It also lights the always-visible menu-bar badge
  (`⏻`, ranked just under NEEDS-YOU attention) so the outage is glanceable
  without opening the dropdown at all. Both the notification flag and the badge
  clear the moment the daemon is observed alive again, so the next real outage
  alerts fresh.

The dropdown's own "Scheduler stopped" row (`addNeedsAttention`, rendered only
while the menu is open and only when routines exist) is unchanged and
complementary — the tick-driven watchdog is what makes the outage visible
*before* you think to open the menu.

```bash
MenubarHelper --notify --title T --body B [--subtitle S] [--action A] [--agent claude]
```

Because the poster is the app bundle, macOS attributes the notification to the
agents-cli helper and shows its `AppIcon` (the agents-cli mark) instead of the
generic osascript icon. The one-shot delivers via `NSUserNotificationCenter`,
briefly spins the runloop so delivery flushes, then exits — it never starts the
status-bar UI. The persistent menu-bar instance registers the click delegate at
launch (`Notifier.wireClickHandler`), so clicking a notification runs its
`--action`: `open:<path>` opens a run report/log, `url:<https…>` opens a web
target (the PR or ticket a finished run produced — `http`/`https` only, so a
notification argument can never become an open-anything primitive), and
`routines:list` opens the runs folder. The Node side lives in
`src/lib/menubar/notify-desktop.ts` (routing), `src/lib/routine-notify.ts`
(routine start/finish content + anti-spam threshold; see
[routines.md](03-routines.md#desktop-notifications)), and `src/lib/run-notify.ts`
(the `agents run --notify` finish notice).

**Two images: the app on the left, the agent on the right.** macOS draws the
sending bundle's icon on the LEFT of a banner and its `contentImage` on the
RIGHT — the layout a YouTube notification uses for "YouTube" plus the channel's
avatar. The left slot is the agents-cli mark, resolved by LaunchServices from the
installed bundle (`refreshBundleIconRegistration` re-registers it at install, or
that slot renders blank). The right slot is `--agent`: the harness the
notification is *about*, drawn by `AgentAvatar` (`menubar/Sources/MenubarHelper/
AgentAvatar.swift`) as a brand-colored tile with the agent's two-letter mark —
`CL` for claude, `CX` for codex, `GK` for grok. The mark is drawn rather than
shipped as an image set: fifteen bundled logos would be fifteen more binaries to
code-sign each release, and the upstream marks are trademarks agents-cli does not
redistribute. An id with no brand entry falls back to its own initial on the
agents-cli lime, so a harness new to the registry still renders.

Omit `--agent` when no single harness owns the event — a daemon heal, an overdue
sweep, a command routine, a fan-out across several agents. The right slot then
stays empty rather than repeating the left one, which is what it did before
`--agent` existed (`contentImage` was the app icon, so both slots showed the same
lime `a`).

**A run notifies for itself.** `agents run --notify` arms the finish notification
on the run process's own `exit`, so it covers every dispatch path — local spawn,
`--host`, `--lease`, the error path — and, more importantly, does not depend on
whatever launched the run still being alive. That is the whole point: the menu
bar's quick dispatch used to post from its own process-termination callback and
lost it whenever the helper restarted. A run killed with SIGKILL never reaches an
exit handler and so never notifies; that is the documented limit.

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
| `~/.agents/.history/menubar/recent-tickets.json` | tickets filed from the quick-dispatch panel (RECENT TICKETS) |
| `~/.agents/.history/menubar/linear-cache.json` | warm cache of Linear projects + each project's open tickets |
