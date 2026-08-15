# Browser

Drive Chromium-family browsers from AI agents via the Chrome DevTools Protocol.

## Overview

`agents browser` gives agents a real browser — the same Chrome, Brave, or Edge you use manually, with your existing cookies, fingerprint, and IP. There is no Playwright subprocess, no automation flags, no relay extension. Sites that block Puppeteer and Playwright let it through because there is nothing to detect.

The CLI manages browser processes, tab lifetimes, and network capture through a background daemon (`agents browser` IPC server). Each agent creates a named **task**. Multiple agents run tasks in parallel without sharing state: profile A has its own `chrome-data/`, profile B has its own — no cookie bleed, no race on focus.

Intended users: LLM agents that need to log in to real web apps, scrape authenticated pages, fill forms, upload files, or capture screenshots to feed back into a reasoning loop.

## Architecture

```
agent process
     │
     ├─ agents browser <subcommand> (one request, then exit)
     │
     └─ agents browser stream (long-lived NDJSON; process + socket stay warm)
        (both resolve $AGENTS_BROWSER_TASK or --task)
     ▼
  CLI (browser.ts)
     │
     │  JSON-RPC over UNIX socket
     │  ~/.agents/.cache/helpers/browser.sock
     ▼
  Browser Daemon (ipc.ts / service.ts)
     │
     │  Chrome DevTools Protocol
     │  ws://127.0.0.1:<port>/json
     ▼
  Browser process
  (Chrome / Brave / Edge / Chromium / Comet)
     │
     ├── Profile A  chrome-data/A/  →  Task swift-crab-a1b2
     └── Profile B  chrome-data/B/  →  Task bold-phoenix-c3d4

  Remote variant (ssh:// endpoint):
  CLI → SSH tunnel → CDP on remote host → remote Chrome
```

The daemon auto-starts on the first command that needs it. Commands that only
inspect local state (`ps`, `profiles list`) do not start it.

Task names are auto-generated as `<adjective>-<noun>-<noun>-<hex8>` (e.g.,
`swift-crab-falcon-a3f92b1c`). Set `AGENTS_BROWSER_TASK` once at the start of
an agent run; every subsequent command in that process reads it without
`--task`.

## Setup

### 1. Create a profile

A profile names a browser + CDP endpoint pair. **A new profile is machine-local
by default** (RUSH-2716): it is written to this machine's own
`~/.agents/devices/<machine>/agents.yaml` under `browser:`, and no other machine
sees it. That is the right default because a profile pins an OS-specific
`binary:` path and a locally chosen CDP port, so a synced copy is wrong on every
other box — and because agents create throwaway profiles freely, syncing each one
filled the shared file with junk.

Pass `--fleet` for a profile that really is fleet config — a remote `ssh://`
endpoint, or a shape you want on every machine. That writes it to the central
`~/.agents/agents.yaml` `browser:` map, which syncs with `agents repo push/pull`
so the same name resolves everywhere.

Runtime state — the Chrome `chrome-data` cookie jar — lives separately under
`~/.agents/.cache/browser/<profile>@<endpoint>/`, which is gitignored and
per-machine, so each machine logs in once.

```bash
# Minimal: let agents pick a free port and auto-detect the binary (machine-local)
agents browser profiles create work --browser chrome

# Pin an endpoint explicitly
agents browser profiles create work --browser chrome --endpoint "cdp://127.0.0.1:9222"

# Remote host via SSH, shared with every machine
agents browser profiles create staging --browser chrome --fleet \
  --endpoint "ssh://deploy@staging.example.com?port=9222"
```

Existing profiles are **not** migrated: `--fleet` only decides where a NEW entry
is written, so a profile created before this change keeps syncing. `agents
browser profiles list` shows a `SCOPE` column (`local` / `fleet`) for each one.

If you skip `--profile` on `agents browser start`, the profile is resolved in
this order:

1. **Your configured default** — the profile set via
   `agents browser profiles set-default <name>` on THIS machine, when it can
   launch here. This also re-points an explicit `--profile default`, so an agent
   that hardcodes `default` still lands on your chosen profile (e.g. a logged-in
   Comet). If its browser/binary isn't installed on this machine, it warns and
   falls through to auto-detect.
2. **An existing `default` profile**, if one exists and its browser is installed
   on this machine.
3. **Auto-detect** — the first installed Chromium-family browser, saved as the
   `default` profile. Detection priority:
   - macOS: Chrome > Brave > Edge > Chromium > Comet
   - Linux: Chrome > Chromium > Brave > Edge
   - Windows: Edge > Chrome > Brave > Comet

   A `default` profile that came from another OS whose binary is missing here — a
   `/Applications/...` Chrome path resolved on Linux, say — is **regenerated for
   this machine** rather than failing with "Custom binary not found". Remote
   (`ssh://`) defaults skip this check: their browser lives on the far host.

The configured default is a **per-device setting**: it lives in this machine's
`browser.profile` config key (centrally, under `fleet.devices.<machine>.config`
in `~/.agents/agents.yaml`), so each machine keeps its own choice — the profile
it points at may hold machine-local logins. Set it once per machine.

Safari and Firefox are not supported. They do not implement the Chrome
DevTools Protocol.

### 2. First-run onboarding

On the first `start`, Chrome opens to a new user-data directory with no
cookies or saved state. Complete any first-run screens (agree to terms,
sign in) before automating. Run `agents browser profiles doctor <name>` to
check if onboarding is complete.

### 3. Export the task name

```bash
export AGENTS_BROWSER_TASK=$(agents browser start --profile work)
# stdout = task name only; stderr = human commentary
```

Every subsequent command in that shell reads `$AGENTS_BROWSER_TASK`
automatically.

### Keep the action loop warm

Normal `agents browser <command>` calls are convenient for individual actions,
but each shell invocation starts a new Node process and opens a new daemon IPC
connection. For an observe-and-act loop, start `browser stream` once and send one
IPC request object per line. It keeps both the narrow browser CLI process and the
existing browser-daemon socket open until stdin closes; the daemon continues to
reuse its existing CDP connection.

```bash
printf '%s\n' \
  '{"action":"screenshot","path":"/tmp/page.jpg"}' \
  '{"action":"click","atX":320,"atY":540}' \
  | agents browser stream --task "$AGENTS_BROWSER_TASK"
```

The response is one compact JSON object per non-empty input line, in the same
order. A long-lived caller can leave stdin open and write later requests to the
same process. `--task` supplies the default `task` field; a task returned by a
`start` request becomes the default for subsequent lines. Malformed JSON returns
an error response without closing the stream. A fleet-remote `start` line obeys
the same device-local `browser remote-control` consent gate as the ordinary
`browser start` command.

## Command Reference

### Profile management

| Command | Description |
|---------|-------------|
| `agents browser profiles list` | List all configured profiles with their `SCOPE` (`local` / `fleet`). A `*` marks this machine's configured default — which is NOT the same thing as the profile named `default`. `--json` adds `scope` + `isConfiguredDefault` |
| `agents browser profiles create <name>` | Create a new profile, machine-local unless `--fleet` (see flags below) |
| `agents browser profiles prune` | Remove dead machine-local profiles — browser not installed here, or never started (see below) |
| `agents browser profiles show <name>` | Show profile details |
| `agents browser profiles set-default [name]` | Set the profile a bare `start` (and `--profile default`) uses; `--unset` to clear; no name prints the current value. Device-local. |
| `agents browser profiles logins` | Per profile: `SERVICE \| ACCOUNT \| CREDS` — live session, the signed-in account (plaintext username, never decrypts), and whether login creds are in the profile's secrets bundle |
| `agents browser profiles delete <name>` | Delete profile config and chrome-data cache |
| `agents browser profiles doctor <name>` | Diagnose binary, port, user-data-dir, onboarding state |

`profiles create` flags:

| Flag | Description |
|------|-------------|
| `-b, --browser <type>` | Required. One of: `chrome`, `comet`, `chromium`, `brave`, `edge`, `custom` |
| `--fleet` | Store in the synced `agents.yaml` so every machine sees it. Default is machine-local |
| `-e, --endpoint <url>` | CDP endpoint URL (repeatable). Auto-assigned if omitted |
| `-s, --secrets <bundle>` | Secrets bundle for this profile: injected as env vars at launch, AND the credential store for `browser type --secret` (keys `<PREFIX>_USERNAME`/`<PREFIX>_PASSWORD`). Warns if the bundle doesn't exist yet |
| `-d, --description <text>` | Human-readable description |
| `--headless` | Run in headless mode |
| `--window <WxH>` | Window size in CSS pixels (default: 1512x982, MacBook Pro 14") |
| `--position <X,Y>` | Window position on screen |
| `--binary <path>` | Absolute path to browser binary (required for `--browser custom`) |
| `--electron` | Treat as an Electron desktop app; never creates new targets |
| `--target-filter <expr>` | Pick the visible CDP page target. Format: `url:<substring>` or `title:<substring>`. Requires `--electron` |

### Cleaning up dead profiles (`prune`)

Profiles accumulate — an agent mints one for a task and never removes it.
`agents browser profiles prune` removes the ones that are provably dead:

| Reason | Meaning |
|--------|---------|
| `binary-missing` | The profile's browser/binary is not installed on this machine, so it cannot launch here at all |
| `never-used` | No runtime dir has ever been created for it (`~/.agents/.cache/browser/<name>*` is absent) |

```bash
agents browser profiles prune --dry-run   # preview; changes nothing
agents browser profiles prune             # apply
agents browser profiles prune --json      # machine-readable plan
```

Four guards, each because removing that profile would be wrong rather than untidy:

- **In use** — a live browser, an SSH tunnel, or an open task on *any* of its
  runtime dirs, composite (`<name>@<endpoint>`) dirs included.
- **This machine's configured default** — a bare `agents browser start` resolves
  to it.
- **The auto `default`** — regenerated on demand, so pruning it is pure churn.
- **Fleet-synced profiles** — skipped unless you pass `--fleet`, because deleting
  one removes it from **every** machine.

Removing a profile drops its config entry and wipes its cache dirs, exactly like
`profiles delete`.

> A profile config records no creation time, so one you created seconds ago and
> have not started yet is indistinguishable from an abandoned one and reports
> `never-used`. Preview with `--dry-run` first.

### Session lifecycle

| Command | Description |
|---------|-------------|
| `agents browser start` | Start a browser task; prints task name to stdout |
| `agents browser done` | Complete the task and close its tabs |
| `agents browser stop` | Stop a task (or `--profile <name>` to detach whole profile) |
| `agents browser status` | Show running tasks (interactive picker in TTY) |
| `agents browser tasks` | List all tasks in non-interactive table form |
| `agents browser ps` | List all tracked browser/electron/tunnel processes, alive or stale |
| `agents browser history` | Recent task history |
| `agents browser stream [--task <name>]` | Keep one CLI process and daemon IPC socket open; NDJSON requests in, NDJSON responses out |
| `agents browser gc [--dry-run]` | Run the abandoned-task reaper now instead of waiting for the daemon's next tick |

`start` flags:

| Flag | Description |
|------|-------------|
| `-p, --profile <name>` | Profile to use (auto-picks if omitted) |
| `--task <name>` | Override auto-generated task name |
| `-e, --endpoint <name>` | Endpoint preset within the profile |
| `-u, --url <url>` | Open URL in first tab. If an abandoned task on this profile already holds a tab showing that exact URL, the tab is reclaimed instead of a duplicate being opened (RUSH-2622) — a tab held by a live task, or one you opened yourself, is never taken |
| `--fresh` | Always open a new tab, skipping the reclaim above |
| `--no-skills` | Skip domain-skill auto-discovery |
| `--record` | Start recording immediately after tab opens |
| `--fps <n>` | Recording frames per second (1–30, default 5) |
| `--duration <sec>` | Recording duration cap (default 60s) |
| `--max-mb <mb>` | Recording size cap (default 25 MB) |

### Tab hygiene — automatic reaping (RUSH-2622)

`agents browser done` / `stop` close a task's tabs, but agents routinely never
call them — the run ends, the process exits, and the tabs stay open in the
profile window forever. The daemon runs a periodic reaper so leftover tabs
don't pile up, on the same 5-minute cadence as its other housekeeping ticks:

- **Session-end reap.** When the agent session (or run) that started a task is
  no longer alive on this host, the daemon closes that task's tabs and marks it
  done — the same code path `done` uses. This always runs; there is no way to
  turn it off.
- **Idle reap.** A task with no IPC action (navigate, click, type, screenshot,
  evaluate, …) for `browser.task-idle-minutes` (default **30**) is closed the
  same way. Set it to `0` to disable idle reaping only — a task with no
  recorded identity then never gets closed by this path, though session-end
  reaping still catches every task that *does* carry one:

  ```bash
  agents devices config <this-machine> browser.task-idle-minutes 15
  agents devices config <this-machine> browser.task-idle-minutes 0   # idle reap off
  ```

  Machine-local, like `browser.profile` and `browser.remote-control` — it
  lives in this box's own config and cannot be set for a peer.

Both reasons are conservative: only tabs in `task.tabs` are ever closed (a tab
you opened yourself is never touched), a task mid-recording is always left
alone, and the shared profile window itself is never closed or killed.

Run the same pass on demand instead of waiting for the next tick:

```bash
agents browser gc --dry-run   # list what would be closed, close nothing
agents browser gc             # actually close it
agents browser gc --idle-minutes 5   # override the idle window for this run
```

### Driving another machine's browser (`--host`) and consent

Any `agents browser` command takes the fleet `--host <device>` flag (same as
`agents sessions`/`teams`/`run`): it runs the command on that device over SSH and
drives *its* browser, streaming the output back. No hand-built `ssh://` profile
needed — `agents browser start --host zion` starts a task on `zion`'s own daemon.

Because that lets one machine open a browser on another, the **target decides**
whether it allows it:

| Command | Description |
|---------|-------------|
| `agents browser remote-control` | Print whether this machine accepts remote drives |
| `agents browser remote-control on` | Allow other fleet machines to drive this browser |
| `agents browser remote-control off` | Refuse remote drives (the default) |

Consent is a **per-device setting** (the `browser.remote-control` config key,
stored centrally under `fleet.devices.<machine>.config` in `~/.agents/agents.yaml`)
and **off by default**: a `browser --host <this-machine> start` from
elsewhere is refused with a message naming how to enable it, until the owner runs
`agents browser remote-control on` here. Local starts (no `--host`) are never gated.

### Navigation

| Command | Description |
|---------|-------------|
| `agents browser navigate --url <url>` | Navigate current tab to URL |
| `agents browser tabs` | List open tabs |
| `agents browser tab add --url <url>` | Open URL in a new tab |
| `agents browser tab focus <tabId>` | Switch to tab by ID, prefix, or URL substring |
| `agents browser tab close [tabId]` | Close a tab; omit to close all |

### Interaction

| Command | Description |
|---------|-------------|
| `agents browser refs` | Get numbered refs for interactive DOM elements |
| `agents browser click <ref>` | Click element by ref |
| `agents browser type <ref> --text <text>` | Type text into element; `--clear` to empty first |
| `agents browser type <ref> --secret <bundle>/<KEY>` | Type a credential resolved in-process from a secrets bundle — the value never crosses stdout or the transcript (leak-free login) |
| `agents browser press <key>` | Press a key (Enter, Tab, Escape, etc.) |
| `agents browser hover <ref>` | Hover over element by ref |
| `agents browser scroll` | Scroll by pixels; `--dx` horizontal, `--dy` vertical, `--at-x/--at-y` origin |
| `agents browser upload` | Upload files; supports hidden inputs, drag-drop, OS chooser interception |
| `agents browser set viewport <W> <H>` | Set viewport size; `--mobile`, `--scale` |
| `agents browser set device <name>` | Emulate a device preset (iPhone 14, iPad, MacBook Pro) |
| `agents browser devices` | List available device presets |
| `agents browser download --path <dir>` | Set download directory for a task |
| `agents browser waitdownload` | Wait for a download to complete |

`upload` flags:

| Flag | Description |
|------|-------------|
| `-r, --ref <n>` | Ref of the upload target (file input or drop zone) |
| `--trigger <n>` | Ref of a button that opens the OS file chooser |
| `-f, --file <path...>` | Absolute path(s) to file(s) (repeatable) |
| `--drop` | Force drag-drop pattern |
| `--input` | Force file-input pattern |
| `--timeout <ms>` | Timeout for chooser interception |

### Observation

| Command | Description |
|---------|-------------|
| `agents browser screenshot` | Capture current tab; path printed to stdout |
| `agents browser evaluate --expression <js>` | Run JavaScript; `--file <path>` to read from file |
| `agents browser console` | Read console logs; `--level` (log/info/warn/error), `--clear` |
| `agents browser errors` | Read uncaught page errors; `--clear` |
| `agents browser requests` | Captured network requests; `--filter <text>` |
| `agents browser responsebody <url-pattern>` | Wait for and read a response body |
| `agents browser logs <task>` | Read app JSONL logs; `--source`, `--lines`, `--since`, `--until`, `--level`, `--message`, `--filter` |

`screenshot` flags:

| Flag | Description |
|------|-------------|
| `-t, --tab <tabId>` | Tab to capture (defaults to current) |
| `-o, --output <path>` | Specific output path; auto-saves under sessions/<task>/ if omitted |
| `-q, --quality <mode>` | `compressed` (JPEG, ~100 KB cap) or `raw` (PNG pixel-faithful) |

### Recording

| Command | Description |
|---------|-------------|
| `agents browser record start` | Start recording; auto-saved under sessions/<task>/recordings/ |
| `agents browser record stop` | Stop recording; prints output path to stdout |

`record start` flags: `--fps`, `--duration <sec>`, `--max-mb`.

### History and discovery

| Command | Description |
|---------|-------------|
| `agents browser history` | Recent task history; `--limit <n>` |
| `agents browser refs --all` | Include non-interactive elements; `--limit <n>` |
| `agents browser wait` | Wait for a condition: `--time`, `--selector`, `--url`, `--fn`, `--state` |
| `agents browser sessions` | Browse captured screenshots, PDFs, recordings, and downloads, grouped by task. `agents sessions --browser` is the same view. |

`agents browser sessions` flags: `--profile <name>` (default: every profile with
captures), `--open [selector]` (open `latest` or a filename match in the OS
default app), `--json`, `--no-interactive`.

On a real terminal (no `--json`/`--open`/`--no-interactive`), `sessions` opens an
interactive, **task-first** browser: one row per browser task, newest first —
not one row per screenshot. Each task records the agent session that started it
(`AGENT_SESSION_ID`, resolved in the calling CLI process — the shared browser
daemon cannot know it), plus `owner` and `launchId`. That identity is written
once at task start to a durable `browser_sessions` row in the local session DB
and is **never deleted**, so a task still links to its session after
`agents browser stop` and after a daemon restart. The preview pane then shows
the same digest as `agents sessions` (prompt, changes, tests, last response),
followed by that task's captures newest-first with filename/age/size.

A row shows **unresolved** when it recorded an identity this machine cannot
index (a rotated or peer-owned session), and **unlinked** when no identity was
recorded at all — captures taken before this shipped, whose identity was
discarded at stop and cannot be recovered. Either way the captures are still
listed and openable. Downloads sit in their own row, separate from any task.

The DB row is **metadata only** — task, profile, identity, timing, and the
capture directory path. The screenshots, PDFs and recordings themselves stay on
disk under `~/.agents/.cache/browser/<profile>/sessions/<task>/`; nothing copies
them into the database, and the listing counts captures by reading that
directory rather than trusting a stored tally.

**Known gap — `--host` drives record no session.** `agents browser start --host
<device>` runs the CLI on the remote box, and the SSH dispatch forwards only
`AGENTS_ACTOR*` and `AGENT_TERMINAL_ID` — not `AGENT_SESSION_ID`. A task started
that way therefore records no session and lists as `unlinked`. Local drives are
unaffected. Forwarding session identity across the SSH hop is tracked on
RUSH-2549 and is not fixed here. Search matches task name, profile, the
linked session's agent/topic, or an artifact filename; `enter` opens the
highlighted capture directly (or drills into a capture list first when a task
holds more than one). `--no-interactive` prints the flat per-artifact table
instead — the stable, scriptable surface `--json` also uses.

## Profile Schema

Profiles are stored in the agents metadata layer, not as standalone YAML files —
in the `browser:` map of either this machine's `~/.agents/devices/<machine>/agents.yaml`
(the default) or the fleet-synced `~/.agents/agents.yaml` (`--fleet`). Both maps
use the identical schema below, and a machine-local entry wins a name collision.
Use `agents browser profiles show <name> --json` to inspect the full config, or
`agents browser profiles list --json` to see which store each one is in.
The fields map to:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Lowercase alphanumeric with hyphens |
| `browser` | string | `chrome`, `comet`, `chromium`, `brave`, `edge`, or `custom` |
| `endpoints` | string[] or map | CDP URLs: `cdp://host:port`, `ssh://host?port=N`, or `wss://...` |
| `defaultEndpoint` | string | Key into `endpoints` map to use by default |
| `binary` | string | Absolute path; required for `browser: custom` |
| `electron` | boolean | Suppress `Target.createTarget`; bind to visible window |
| `targetFilter` | string | `url:<substring>` or `title:<substring>` for Electron window selection |
| `description` | string | Human-readable label |
| `secrets` | string | Secrets bundle name to inject at browser start |
| `chrome.headless` | boolean | Run headless |
| `viewport` | `{width, height, x?, y?}` | Initial window size in CSS pixels |
| `logDir` | string | Local path to source-side JSONL logs |
| `logHost` | string | SSH host where `logDir` lives |

## Recipes

### 1. Create a profile and log in manually

```bash
# Create the profile (auto-assigns a free port)
agents browser profiles create work --browser chrome

# Start a session and open the app
export AGENTS_BROWSER_TASK=$(agents browser start --profile work --url https://app.example.com)

# Complete the login in the browser window that opens.
# Then verify onboarding is done:
agents browser profiles doctor work

# On future runs, cookies are already there.
```

Logins persist across browser restarts, including sites that issue
memory-only session cookies (`expires=-1`, e.g. idealista): each launch pins
`session.restore_on_startup: 1` in the profile's Preferences, which stops
Chromium purging session cookies at startup, while `--no-startup-window`
keeps the visible side of session restore from ever happening — no tabs from
a previous task reopen. The only logouts left are server-side session
expiries, which no client can prevent.

### 2. Screenshot a logged-in page

```bash
export AGENTS_BROWSER_TASK=$(agents browser start --profile work --url https://dashboard.example.com)
# Wait for the page to load, then capture:
agents browser wait --state networkidle
P=$(agents browser screenshot)
# P is the path to the saved JPEG; pass it to your vision model.
agents browser done
```

### 3. Extract data with evaluate

```bash
export AGENTS_BROWSER_TASK=$(agents browser start --profile work --url https://app.example.com/orders)
agents browser wait --selector "table.orders"
agents browser evaluate --expression "
  Array.from(document.querySelectorAll('table.orders tr')).map(r =>
    Array.from(r.querySelectorAll('td')).map(c => c.innerText)
  )
"
agents browser done
```

### 4. Drive an Electron app (e.g. Slack)

```bash
# Create the profile once
agents browser profiles create slack \
  --browser custom \
  --binary "/Applications/Slack.app/Contents/MacOS/Slack" \
  --electron

# Then use it exactly like a web profile
export AGENTS_BROWSER_TASK=$(agents browser start --profile slack)
agents browser screenshot
agents browser refs
agents browser click 7
agents browser done
```

### 5. Attach to a remote Chrome via SSH

```bash
# The profile stores the SSH endpoint; the daemon opens the tunnel at start time
agents browser profiles create staging \
  --browser chrome \
  --endpoint "ssh://deploy@staging.example.com?port=9222"

export AGENTS_BROWSER_TASK=$(agents browser start --profile staging)
agents browser navigate --url https://internal.staging.example.com
agents browser screenshot
agents browser done
```

## Demo

<video autoplay loop muted playsinline width="100%" src="../assets/videos/browser.mp4"></video>

## See also

- [docs/pty.md](pty.md) — drive REPLs and TUI programs from an agent; part of the automation triad
- [docs/computer.md](computer.md) — drive native macOS apps via Accessibility; part of the automation triad
- [docs/concepts.md](concepts.md) — DotAgents repos, resource resolution model
