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
     │  agents browser <subcommand>
     │  (resolves $AGENTS_BROWSER_TASK or --task)
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

A profile names a browser + CDP endpoint pair. The profile config lives in
`~/.agents/.history/versions/<agent>/<version>/home/` but is addressed by
name everywhere.

```bash
# Minimal: let agents pick a free port and auto-detect the binary
agents browser profiles create work --browser chrome

# Pin an endpoint explicitly
agents browser profiles create work --browser chrome --endpoint "cdp://127.0.0.1:9222"

# Remote host via SSH
agents browser profiles create staging --browser chrome \
  --endpoint "ssh://deploy@staging.example.com?port=9222"
```

If you skip `--profile` on `agents browser start`, the profile is resolved in
this order:

1. **Your configured default** — the profile set via
   `agents browser profiles set-default <name>` on THIS machine. This also
   re-points an explicit `--profile default`, so an agent that hardcodes
   `default` still lands on your chosen profile (e.g. a logged-in Comet).
2. **An existing `default` profile**, if one has already been created.
3. **Auto-detect** — the first installed Chromium-family browser, saved as the
   `default` profile. Detection priority:
   - macOS: Chrome > Brave > Edge > Chromium > Comet
   - Linux: Chrome > Chromium > Brave > Edge
   - Windows: Edge > Chrome > Brave > Comet

The configured default is **device-local**: it lives in
`~/.agents/devices/<machine>/agents.yaml` and never syncs to your other
machines (they keep auto-detecting), because the profile it points at may hold
machine-local logins. Set it once per machine.

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

## Command Reference

### Profile management

| Command | Description |
|---------|-------------|
| `agents browser profiles list` | List all configured profiles (marks the machine's default) |
| `agents browser profiles create <name>` | Create a new profile (see flags below) |
| `agents browser profiles show <name>` | Show profile details |
| `agents browser profiles set-default [name]` | Set the profile a bare `start` (and `--profile default`) uses; `--unset` to clear; no name prints the current value. Device-local. |
| `agents browser profiles logins` | Show which login-gated services each profile has a live session for (reads cookie presence only) |
| `agents browser profiles delete <name>` | Delete profile config and chrome-data cache |
| `agents browser profiles doctor <name>` | Diagnose binary, port, user-data-dir, onboarding state |

`profiles create` flags:

| Flag | Description |
|------|-------------|
| `-b, --browser <type>` | Required. One of: `chrome`, `comet`, `chromium`, `brave`, `edge`, `custom` |
| `-e, --endpoint <url>` | CDP endpoint URL (repeatable). Auto-assigned if omitted |
| `-s, --secrets <bundle>` | Secrets bundle to inject at browser start |
| `-d, --description <text>` | Human-readable description |
| `--headless` | Run in headless mode |
| `--window <WxH>` | Window size in CSS pixels (default: 1512x982, MacBook Pro 14") |
| `--position <X,Y>` | Window position on screen |
| `--binary <path>` | Absolute path to browser binary (required for `--browser custom`) |
| `--electron` | Treat as an Electron desktop app; never creates new targets |
| `--target-filter <expr>` | Pick the visible CDP page target. Format: `url:<substring>` or `title:<substring>`. Requires `--electron` |

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

`start` flags:

| Flag | Description |
|------|-------------|
| `-p, --profile <name>` | Profile to use (auto-picks if omitted) |
| `--task <name>` | Override auto-generated task name |
| `-e, --endpoint <name>` | Endpoint preset within the profile |
| `-u, --url <url>` | Open URL in first tab |
| `--no-skills` | Skip domain-skill auto-discovery |
| `--record` | Start recording immediately after tab opens |
| `--fps <n>` | Recording frames per second (1–30, default 5) |
| `--duration <sec>` | Recording duration cap (default 60s) |
| `--max-mb <mb>` | Recording size cap (default 25 MB) |

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

## Profile Schema

Profiles are stored in the agents metadata layer, not as standalone YAML files.
Use `agents browser profiles show <name> --json` to inspect the full config.
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
- [docs/00-concepts.md](00-concepts.md) — DotAgents repos, resource resolution model
