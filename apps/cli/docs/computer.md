# Computer

Drive native macOS apps from AI agents via the Accessibility API.

## Overview

`agents computer` controls macOS applications through the Accessibility
(`AXUIElement`) framework, ScreenCaptureKit, and HID-tap event synthesis. It
requires a separate helper app (`Computer Helper.app`) installed in
`/Applications/` with two macOS TCC grants: Accessibility and Screen Recording.

The helper runs as a launchd user agent, listening on a UNIX socket. Agents
send JSON-RPC calls through the CLI; the helper translates them into AX
actions and synthesized input events on running apps.

Use this when you need to drive a macOS app that has no web interface and no
CDP endpoint — a desktop finance tool, a native editor, a VM window, or an app
that Electron automation cannot reach cleanly.

This is macOS-only. The daemon, socket, and all TCC plumbing are specific to
macOS APIs (`launchctl`, `AXUIElement`, `ScreenCaptureKit`, `CoreGraphics`).

## Architecture

```
agent process
     │
     │  agents computer <verb>
     ▼
  CLI (computer.ts / computer-actions.ts)
     │
     │  JSON-RPC over UNIX socket
     │  ~/.agents/.cache/helpers/computer.sock
     │  (per-call timeout 30s; COMPUTER_HELPER_RPC_TIMEOUT_MS overrides)
     │
     │  Fallback: spawn helper binary as child process
     │            (for dev builds without setup)
     ▼
  Computer Helper.app
  /Applications/Computer Helper.app
  [launchd: com.phnx-labs.computer-helper]
     │
     │  AXUIElement  (Accessibility framework)
     │  ScreenCaptureKit  (window/display capture)
     │  CGEvent via HID tap  (clicks, drags, keystrokes)
     ▼
  macOS app process
  (any app in the allow list)
```

The helper reads an allow-list policy file
(`~/.agents/.cache/helpers/computer-policy.json`) at startup and on SIGHUP.
By default the policy is deny-all. You must explicitly whitelist each app the
daemon may drive.

A peer-auth list (`~/.agents/.cache/helpers/computer-peers.json`) controls
which caller executables may connect to the socket. The CLI writes this list
at `start` time based on the currently installed Node binary path. This
prevents a malicious npm postinstall from connecting to the socket through a
different process.

## Setup

### 1. Install the helper

```bash
agents computer setup        # alias: install-helper
```

This copies `Computer Helper.app` to `/Applications/Computer Helper.app`,
verifies its codesign signature, writes a LaunchAgent plist at
`~/Library/LaunchAgents/com.phnx-labs.computer-helper.plist`, and prints
the next steps. It does **not** start the daemon.

### 2. Grant TCC permissions (one-time)

Open System Settings on macOS:

```
System Settings > Privacy & Security > Accessibility   — add Computer Helper.app
System Settings > Privacy & Security > Screen Recording — add Computer Helper.app
```

These grants are keyed to the app's signed bundle identity at
`/Applications/Computer Helper.app`. They survive `npm update` as long as the
app stays at that path and the same certificate signs it.

### 3. Whitelist the apps the daemon may drive

Add a YAML file under `~/.agents/permissions/groups/`:

```yaml
# ~/.agents/permissions/groups/computer.yaml
name: computer
allow:
  - "Computer(com.apple.mail)"
  - "Computer(com.apple.notes)"
  - "Computer(com.apple.finder)"
```

The bundle ID is the value from `CFBundleIdentifier` in the app's `Info.plist`.
Find it with:

```bash
defaults read /Applications/SomeApp.app/Contents/Info CFBundleIdentifier
```

### 4. Start the daemon when you need it

```bash
agents computer start
```

The daemon is not always-on. Start it when you need it, stop it when done.
This is intentional: Accessibility and Screen Recording are sensitive grants;
an always-on background listener that can drive any app is a large attack
surface.

```bash
agents computer stop   # when finished
```

## Command Reference

Verbs are grouped the way `agents computer --help` groups them.

### Installation & daemon lifecycle

| Command | Description |
|---------|-------------|
| `setup` (alias `install-helper`) | Copy helper to /Applications/, write LaunchAgent plist |
| `start` | Write policy + peers, load the LaunchAgent, start the daemon |
| `stop` | Unload the LaunchAgent, remove the socket |
| `reload` | Reload the allow-list policy from ~/.agents/permissions/groups/ (SIGHUP the daemon); with `--host`, restart the remote Windows daemon |
| `status` | Report install state, daemon state, TCC trust, policy, and peer list; with `--host`, tunnel + liveness of the remote Windows daemon |

### Observe

| Command | Description |
|---------|-------------|
| `apps` | List running allow-listed apps (pid, bundle id, active flag) |
| `describe` | Dump the accessibility tree; element ids (`@eN`) feed `--id` flags |
| `screenshot` | Capture a window (default: largest), `--list` windows, or `--display` |
| `get-text` | Extract visible text from the app (or a subtree via `--id`) without OCR |

`screenshot` flags: `--bundle` / `--pid` (target), `--list` (enumerate windows
with id/title/layer/`on_screen`/bounds), `--window-id <n>` (capture a specific
window — the way to shoot a modal or dialog), `--display` (whole display,
composites stacked windows), `--out <path>`, `--quality <n>`, `--json`.

Every capture reports `origin` (global point origin of the captured region)
and `scale` (backing-store pixels per point). To click a feature seen at
screenshot pixel `(px, py)`:

```
global_x = origin_x + px / scale
global_y = origin_y + py / scale
```

Re-capture after any raise or window move — a window on an inactive
fullscreen Space reports shifted global coordinates.

### Interact

| Command | Description |
|---------|-------------|
| `launch` | Launch an app by `--bundle`, `--path`, or `--name` |
| `raise` | Bring an app — or one window via `--window-id`/`--title` — frontmost; switches Spaces for fullscreen windows |
| `click` | Click an element (`--id`) or coordinate (`--x --y`); `--count 2` double-clicks |
| `right-click` | Context-menu click (AXShowMenu when advertised, synthesized otherwise) |
| `type` | Set an AX field value (`--id`) or paste at a coordinate; `--commit` confirms |
| `type-text` | Stream unicode keystrokes into the focused field; `--commit` presses Return |
| `key` | Send a key chord: `enter`, `esc`, `cmd+shift+s`, ... |
| `drag` | Drag `--from "x,y"` `--to "x,y"` |
| `scroll` | Scroll by `--dy`/`--dx` at an element or coordinate |
| `ax-action` | Perform any advertised AX action (`AXConfirm`, `AXCancel`, ...) on an element |
| `focus` | Set AX keyboard focus to an element |
| `wait` | Sleep (`--duration`) or poll an element/locator until `exists`/`enabled`/`disappears` |

Shared flags: every interact verb takes `--bundle`/`--pid`; reads take
`--json`. `click`/`type-text`/`key`/`drag`/`scroll` accept `--raise` to bring
the target frontmost before acting.

### Focus discipline

Keystrokes are posted to the target pid. Apps that gate input on key-window
status (VM guests such as Parallels, some Catalyst apps) silently drop them
when the app is not frontmost. The daemon therefore reports `"frontmost"` in
every `type-text`/`key` result, and the CLI prints a stderr warning when it is
`false`. Pass `--require-frontmost` to turn that situation into a hard
`not_frontmost` error instead. The reliable sequence for key-window-gated
apps:

```bash
agents computer raise --bundle <id> --title "<window>"
agents computer type-text --bundle <id> --text "..." --require-frontmost
```

### Errors worth knowing

| Error code | Meaning | Fix |
|------------|---------|-----|
| `not_frontmost` | Keystrokes would be dropped | `raise`, then retry |
| `window_offscreen` | Window is on an inactive fullscreen Space; SCK cannot capture it | `raise --window-id <n>`, re-screenshot |
| `element_not_found` | No window/element matched | `screenshot --list` / re-`describe` |
| `rpc_timeout` | Daemon did not respond within the per-call timeout | `status`; `stop` + `start` |
| `permission_denied` | Target app not in the allow list | Add `Computer(<bundle-id>)`, `reload` |

`status` output fields:

| Field | Description |
|-------|-------------|
| `installed` | Whether `/Applications/Computer Helper.app` exists |
| `daemon` | Socket up (running) or down (stopped) |
| `policy` | Count and names of allowed apps from the policy file |
| `peers` | Count of caller executables allowed to connect |
| `trust` | `granted` or `denied` from a live `trust_status` RPC call |
| `pid` | Helper process PID (when trust is probed successfully) |

## Remote Windows (`--host`)

Every verb takes `--host <device>` to drive a Windows machine registered with
`agents devices`: `setup --host` pushes the C# daemon
(`computer-helper-win.exe`) and registers a LOGON scheduled task,
`start --host` opens an `ssh -L` tunnel to its loopback port, and every other
verb reconnects through that tunnel. The daemon mirrors the macOS wire
contract, with these Windows specifics:

- **Screenshots are pid-scoped, PNG-encoded.** `--list` enumerates the target
  pid's top-level windows (`window_id` is the Win32 HWND — the same id
  `raise --window-id` takes), the default capture crops to the pid's largest
  on-screen window, `--window-id` shoots one window, `--display` the whole
  display the app is on. `--quality` is ignored (lossless PNG).
- **Lifecycle:** `status --host <device>` reports the recorded tunnel and a
  live daemon probe; `reload --host <device>` restarts the daemon's scheduled
  task (the way to pick up a freshly pushed exe) and confirms it answers.
  There is no allow-list policy on Windows — the daemon is tunnel-gated.
- **`--require-frontmost` is enforced:** Windows synthetic input lands in the
  *focused* window, so `type-text`/`key` report `frontmost` and the flag turns
  a non-foreground target into a hard `not_frontmost` error.
- **`--background` is rejected** (`action_unsupported`): the macOS
  focus-safe postToPid delivery has no Win32 analogue — synthetic input is
  global. Element mode (`--id` on an invokable element) is the focus-safe path.
- **`get-text` needs `--id`** (from `describe`); `--max-chars` caps the
  extraction (default 20k).

```bash
agents computer setup --host win-mini      # push exe + register LOGON task
agents computer start --host win-mini      # open the tunnel
agents computer status --host win-mini     # tunnel + daemon liveness
agents computer screenshot --host win-mini --pid 27180 --list
agents computer reload --host win-mini     # restart the remote daemon
agents computer stop --host win-mini       # tear down tunnel + task
```

## Recipes

### 1. Install helper and grant accessibility

```bash
# Install
agents computer setup

# Grant permissions in System Settings (manual step)
# Then:
agents computer start
agents computer status
# trust: granted means you are ready
```

### 2. Screenshot the active app

```bash
agents computer start

# Bring the app you want to the foreground, then:
agents computer screenshot --out /tmp/app-snapshot.jpg

# Or target a specific app by bundle ID:
agents computer screenshot --bundle com.apple.mail --out /tmp/mail.jpg

# Or enumerate windows (reveals modals) and capture one:
agents computer screenshot --bundle com.apple.mail --list --json
agents computer screenshot --bundle com.apple.mail --window-id 1234 --out /tmp/dialog.jpg

agents computer stop
```

### 3. Add a new app to the allow list, then reload

```bash
# Add the bundle ID to your permissions group
cat >> ~/.agents/permissions/groups/computer.yaml << 'EOF'
  - "Computer(com.apple.calendar)"
EOF

# Reload without restarting the daemon
agents computer reload
# Output: policy: 4 apps allowed (com.apple.mail, com.apple.notes, ...)

# Now screenshot Calendar
agents computer screenshot --bundle com.apple.calendar --out /tmp/calendar.jpg
```

### 4. Drive a native app end-to-end

The loop is observe → act → verify: act, then re-screenshot and compare —
a byte-identical image means the action did not land.

```bash
agents computer start
agents computer status                                  # confirm trust: granted

agents computer raise --bundle com.apple.notes
agents computer describe --bundle com.apple.notes       # element ids @eN
agents computer click --bundle com.apple.notes --id @e7
agents computer type-text --bundle com.apple.notes --text "meeting notes" --require-frontmost
agents computer screenshot --bundle com.apple.notes --out /tmp/notes-after.jpg

agents computer stop
```

For AX-opaque surfaces (VM guests, Chromium/UXP canvases) `describe` shows
nothing useful inside the content area — work in coordinate mode from
screenshot `origin`/`scale` instead, and gate keystrokes with
`--require-frontmost`. The `computer` skill in the system DotAgents repo
(`skills/computer/`) is the agent-facing playbook for both modes.

## Demo

<video autoplay loop muted playsinline width="100%" src="../assets/videos/computer.mp4"></video>

## See also

- [docs/browser.md](browser.md) — drive real browsers via CDP; part of the automation triad
- [docs/pty.md](pty.md) — drive REPLs and TUI programs from an agent; part of the automation triad
- [docs/00-concepts.md](00-concepts.md) — DotAgents repos, resource resolution model
