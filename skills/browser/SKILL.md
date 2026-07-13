---
name: browser
description: "Drive a browser via CDP — navigate, click, type, screenshot. Profiles persist login state across sessions, so agents log in once and stay authenticated. Triggers on: 'automate a website', 'browser automation', 'click', 'screenshot', 'scrape', 'log in', 'fill form'."
argument-hint: "[profiles|start|refs|click|type|screenshot|done]"
allowed-tools: Bash(agents browser*), Bash(browser*)
user-invocable: true
---

# Browser

Control a real browser via CDP. Profiles persist login state, so agents log in once and stay authenticated. Screenshots auto-resize to save tokens.

`browser` is shorthand for `agents browser` — use the short form.

## Task binding

Every action command targets a *task*. Bind the task once per shell, then drop the flag:

```bash
export AGENTS_BROWSER_TASK=$(browser start --profile work)
browser refs
browser click 42
browser screenshot
```

`start` writes the resolved task name (e.g. `swift-crab-falcon-a3f92b1c`) to **stdout**; human commentary goes to stderr — `$(...)` capture stays clean.

For per-call overrides, pass `--task <name>`. Env vars are per-process, so parallel agents in different shells never collide.

## "I need to automate a site that blocks bots"

Use your real browser. Same fingerprint, same IP, nothing to detect:

```bash
browser profiles create work --browser chrome
export AGENTS_BROWSER_TASK=$(browser start --profile work --url https://linkedin.com)
browser refs
browser click 5
```

## "I don't want to log in every time"

Log in once to a profile — the session persists. Every future task is already authenticated:

```bash
browser profiles create social --browser chrome
export AGENTS_BROWSER_TASK=$(browser start --profile social)
# Log in manually or via automation
browser done

# Next time — already logged in
export AGENTS_BROWSER_TASK=$(browser start --profile social --url https://twitter.com)
```

## "I have multiple accounts and want to keep them separate"

Profiles are identities. Create one per account group:

```bash
browser profiles create social --browser chrome    # Twitter, LinkedIn
browser profiles create email --browser chrome     # Gmail, work email
browser profiles create finance --browser chrome   # Banking, trading
```

An agent using `social` can't see your `finance` cookies.

## "I'm running multiple agents and they keep stepping on each other"

Each agent gets its own task. Tasks share the window but own separate tabs:

```bash
# Agent 1 — research
export AGENTS_BROWSER_TASK=$(browser start --profile work --url https://arxiv.org)
browser tabs

# Agent 2 (different shell) — monitoring
export AGENTS_BROWSER_TASK=$(browser start --profile work --url https://dashboards.example.com)
browser tabs   # only sees its own tabs

# Completing one doesn't affect the other
browser done   # closes only this agent's tabs
```

## "I need to give an agent login credentials safely"

**Cookie persistence comes first.** A profile keeps its login cookies across sessions,
so the goal is: log in once (by hand or agent-driven), and the profile stays
authenticated — no credential handling on the hot path. Check state before assuming a
re-login is needed:

```bash
browser profiles logins          # per profile: SERVICE | ACCOUNT | CREDS
```

`ACCOUNT` is the signed-in identity (from saved logins, read plaintext — no decryption);
`CREDS` shows whether the profile's secrets bundle holds login creds for that service.

**When a session lapses**, drive the login with the credential resolved *inside* the
browser layer so the plaintext never crosses stdout or your transcript. Store creds in
the profile's bundle under the `<SERVICE>_USERNAME` / `<SERVICE>_PASSWORD` convention:

```bash
browser profiles create acme --browser comet --secrets acme-login
agents secrets add acme-login GITHUB_USERNAME
agents secrets add acme-login GITHUB_PASSWORD

# Log in — the agent drives the form and handles 2FA/selectors adaptively:
export AGENTS_BROWSER_TASK=$(browser start --profile acme --url https://github.com/login)
browser refs                                              # find the field refs
browser type <user-ref> --secret acme-login/GITHUB_USERNAME   # value never printed
browser type <pass-ref> --secret acme-login/GITHUB_PASSWORD
browser click <submit-ref>
browser screenshot                                        # inspect: 2FA? captcha? done?
```

If a 2FA/OTP or "unusual activity" checkpoint appears, the agent screenshots it and asks
the human (or reads the OTP from a connected mailbox) — the CLI never auto-solves it.
For scripts that genuinely need the raw value, `agents secrets get <bundle> <KEY>` prints
one value (audited) — but prefer `type --secret` so nothing lands in the transcript.

Note: `--secrets` also injects the bundle as env vars into the browser *process* at
launch (useful for extensions/CDP tooling that read env) — that is separate from web
login, which needs the form-fill flow above.

## "I want to use a cloud browser instead of local"

Connect to BrowserBase, Steel, or any CDP service:

```bash
browser profiles create cloud --browser chrome \
  --endpoint "wss://connect.browserbase.com?apiKey=..."
```

## "I need to automate an Electron app"

Three flags work together for Electron desktop apps:

```bash
browser profiles create canva --browser custom \
  --binary "/Applications/Canva.app/Contents/MacOS/Canva" \
  --electron \
  --target-filter "url:https://www.canva.com/"
```

- `--browser custom` plus `--binary` tells the launcher how to start the app with `--remote-debugging-port`.
- `--electron` switches the runtime into single-window mode: tabs are never created with `Target.createTarget` (most production Electron apps reject it); navigation reuses the existing window.
- `--target-filter` picks the visible WebContents. Electron apps frequently expose several `type: page` CDP targets — background services, OAuth windows, and `file://` shells — and the first one CDP returns is almost never the UI. Use `url:<substring>` or `title:<substring>`.

Without `--target-filter`, a skip-invisible heuristic excludes `about:blank`, `file://`, and URLs matching `_desktop-background-service` / `_internal` / `_background`. That covers most apps; use the filter for the ones it doesn't.

## Common workflows

### Navigate and interact

```bash
export AGENTS_BROWSER_TASK=$(browser start --profile work --url https://example.com)
browser refs                              # Get clickable elements
browser click 3                           # Click element ref 3
browser type 5 --text "search query"      # Type into element ref 5
browser press Enter                       # Press Enter key
browser screenshot                        # Take screenshot (auto-saved)
browser done                              # Close task's tabs
```

### Manage tabs

```bash
browser tab add --url https://github.com  # Open new tab (becomes current)
browser tab focus github                  # Switch by URL substring
browser tabs                              # List all tabs
browser tab close                         # Close all tabs
```

### Check status

```bash
browser status                            # Show all profiles and tasks
browser tasks                             # List just tasks
```

## Quick reference

All action commands read the task from `$AGENTS_BROWSER_TASK` unless `--task <name>` is passed.

| Task | Command |
|------|---------|
| Create profile | `browser profiles create <name> --browser chrome` |
| Start task | `browser start --profile <name> [--url <url>]` |
| Navigate | `browser navigate --url <url>` |
| Get elements | `browser refs` |
| Click | `browser click <ref>` |
| Type | `browser type <ref> --text "text"` |
| Press key | `browser press Enter` |
| Hover | `browser hover <ref>` |
| Scroll | `browser scroll --dx 0 --dy 1000` (negatives scroll up/left) |
| Screenshot | `browser screenshot` |
| Evaluate JS | `browser evaluate --expression "document.title"` (or `--file ./script.js`) |
| New tab | `browser tab add --url <url>` |
| Switch tab | `browser tab focus <hint>` |
| Complete task | `browser done` |
| Status | `browser status` |
