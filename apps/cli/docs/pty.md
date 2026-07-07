# PTY

Drive interactive terminal programs from AI agents — REPLs, TUI wizards, anything that needs a real pseudoterminal.

## Overview

`agents pty` allocates a real pseudoterminal (PTY) via `forkpty`, runs a shell
or program inside it, and exposes read/write/screen operations over a local
HTTP sidecar. Agents interact through simple CLI calls rather than raw terminal
I/O.

The primary use cases are:

- Drive REPLs (Python, Node, Ruby irb, psql) from agent code
- Automate TUI programs (`npm init`, `git add -p`, interactive installers)
- Test CLI tools that require a real PTY
- Run the `agents` CLI itself from inside another agent

The sidecar server auto-starts on the first `pty` command and runs in the
background until you stop it explicitly. You do not need to start it manually.

## Architecture

```
agent process
     │
     │  agents pty <subcommand> <id>
     ▼
  CLI (pty.ts)
     │
     │  HTTP  →  localhost:<pty-port>
     ▼
  PTY sidecar (pty-server.ts)
  [auto-started on first use]
     │
     │  forkpty()
     ▼
  child process  (zsh / python3 / node / ...)
     │
     ├── stdin  ← write / exec
     ├── stdout → ring buffer → read / screen
     └── signals ← signal
```

The `screen` command renders the current terminal buffer as clean text (no
ANSI escape codes). This is the interface intended for LLM consumption — parse
it without a terminal emulator.

## Setup

No installation step. The sidecar starts automatically:

```bash
SID=$(agents pty start)
```

The session ID is a short random string. Store it in a variable and pass it to
every subsequent command.

Verify the server is running at any time:

```bash
agents pty server status
```

## Command Reference

### Session lifecycle

| Command | Description |
|---------|-------------|
| `agents pty start` | Start a new PTY session; prints session ID to stdout |
| `agents pty stop <id>` | Stop a session and clean it up; ID becomes invalid |
| `agents pty list` | List all active sessions |

`start` flags:

| Flag | Default | Description |
|------|---------|-------------|
| `-r, --rows <n>` | 24 | Terminal height in rows |
| `-c, --cols <n>` | 120 | Terminal width in columns |
| `-s, --shell <shell>` | `$SHELL` | Shell or program to launch (e.g., `python3`, `zsh`) |
| `-d, --cwd <dir>` | current dir | Working directory |
| `--json` | — | Output full session metadata as JSON |

### I/O

| Command | Description |
|---------|-------------|
| `agents pty exec <id> <command>` | Send a command string (non-blocking; returns immediately) |
| `agents pty write <id> <input>` | Send raw keystrokes; processes `\n`, `\t`, `\e`, `\xHH` escape codes |
| `agents pty read <id>` | Read raw output including ANSI codes; use `screen` for clean text |
| `agents pty screen <id>` | Render the terminal buffer as clean text (no ANSI) |

`exec` flags:

| Flag | Description |
|------|-------------|
| `--wait <ms>` | Wait this many milliseconds then return the screen (convenience; default 0) |
| `--json` | Output as JSON |

`read` flags:

| Flag | Default | Description |
|------|---------|-------------|
| `-m, --ms <ms>` | 200 | Wait up to this many milliseconds for new output (50–5000) |
| `--json` | — | Output as JSON |

`write` flags:

| Flag | Description |
|------|-------------|
| `--raw` | Send input literally without processing `\n \t \e \xHH` escape codes |
| `--json` | Output as JSON |

`screen` flags:

| Flag | Description |
|------|-------------|
| `--json` | Output as JSON including cursor position and dimensions |

### Control

| Command | Description |
|---------|-------------|
| `agents pty signal <id> [signal]` | Send POSIX signal: INT (default), TERM, or KILL |
| `agents pty resize <id>` | Resize the terminal; `-r <rows>`, `-c <cols>` |

### Server management

| Command | Description |
|---------|-------------|
| `agents pty server status` | Show PID, session count, and log path |
| `agents pty server start` | Start the server manually (auto-starts anyway) |
| `agents pty server stop` | Stop the server and kill all active sessions |

## Recipes

### 1. Start a Python REPL and run code

```bash
SID=$(agents pty start --shell python3)
sleep 1 && agents pty screen $SID   # see the >>> prompt

agents pty write $SID "import math\n"
agents pty write $SID "math.sqrt(144)\n"
sleep 0.5 && agents pty screen $SID  # see 12.0

agents pty stop $SID
```

### 2. Send a multi-line program

```bash
SID=$(agents pty start --shell python3)
sleep 1

# Each \n is processed as a real newline character
agents pty write $SID "def greet(name):\n    return f'hello, {name}'\n\n"
agents pty write $SID "greet('world')\n"
sleep 0.5 && agents pty screen $SID

agents pty stop $SID
```

### 3. Snapshot the screen after a slow command

```bash
SID=$(agents pty start)

# exec + --wait avoids a manual sleep in the caller
agents pty exec $SID "git log --oneline -20" --wait 500

# Or poll manually with screen
agents pty exec $SID "npm install"
sleep 5 && agents pty screen $SID

agents pty stop $SID
```

### 4. Send Ctrl-C to interrupt a running program

```bash
# Via signal subcommand
agents pty signal $SID INT

# Or via write with the ETX byte
agents pty write $SID "\x03"
```

## Demo

<video autoplay loop muted playsinline width="100%" src="../assets/videos/pty.mp4"></video>

## See also

- [docs/browser.md](browser.md) — drive real browsers via CDP; part of the automation triad
- [docs/computer.md](computer.md) — drive native macOS apps via Accessibility; part of the automation triad
- [docs/00-concepts.md](00-concepts.md) — DotAgents repos, resource resolution model
