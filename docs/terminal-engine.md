# Terminal Launch Engine

Open an *interactive* command — as a **tab** or a **split pane** — in iTerm,
Ghostty, or tmux, on this machine or a remote host over SSH. Lives in
[`src/lib/terminal/`](../src/lib/terminal/); the first caller is
`agents sessions resume`.

## Interactive surfaces vs. cloud providers

The engine is deliberately narrow. A **terminal surface** is *attended and live*
— you watch it and type into it. That is a different thing from a **cloud
provider** ([`src/lib/cloud/`](../src/lib/cloud/): Rush Cloud, Codex Cloud,
Factory, Antigravity), which dispatches an *autonomous, headless* task and hands
back a run id and a PR.

| | Terminal engine | Cloud providers |
|---|---|---|
| Opens | a tab / split you attach to now | a queued autonomous task |
| Backends | iTerm, Ghostty, tmux | Rush / Codex / Factory / Antigravity |
| Interface | `buildTab/buildSplit(cwd, command) → argv` | `dispatch(repo, branch, task) → runId` |
| Lifecycle | foreground, immediate | fire-and-forget, poll later |

They meet only one level up: a "where should this run?" router could offer both
families and dispatch down to the right subsystem. The engine itself never
touches the cloud path.

## Architecture

A **backend** is a pure builder — given `cwd`, `command`, and a layout it returns
the argv (an `osascript` script or a `tmux` invocation) that opens the surface.
It performs no I/O, so every backend is unit-tested without a display. A single
**transport** then runs that argv, locally or over SSH.

```
caller ─▶ openSurfaces(items, {backend, host, packing})
             │
             ├─ policy.planLayouts(n)      tab, split-right, tab, …  (2-per-tab)
             ├─ backend.buildTab/buildSplit → LaunchSpec { argv }     (pure)
             └─ transport.runSpec(spec, host)
                   ├─ local:  spawn(argv)                    (wait for exit)
                   └─ remote: sshExec(target, argv-as-shell) (src/lib/ssh-exec)
```

| Module | Role |
|---|---|
| [`types.ts`](../src/lib/terminal/types.ts) | `Backend`, `Layout`, `LaunchRequest`, `LaunchSpec`, `TerminalBackend`. |
| [`backends/iterm.ts`](../src/lib/terminal/backends/iterm.ts) · [`ghostty.ts`](../src/lib/terminal/backends/ghostty.ts) · [`tmux.ts`](../src/lib/terminal/backends/tmux.ts) | Pure tab + split builders per emulator. |
| [`backends/index.ts`](../src/lib/terminal/backends/index.ts) | Registry, `detectCurrentBackend`, `availableBackends`. |
| [`policy.ts`](../src/lib/terminal/policy.ts) | `planLayouts` — the packing policy. |
| [`transport.ts`](../src/lib/terminal/transport.ts) | `runLocal` / `runRemote` / `runSpec`, argv → ssh serialization. |
| [`engine.ts`](../src/lib/terminal/engine.ts) | `specForRequest`, `buildRequests`, `openSurface`, `openSurfaces`. |
| [`shell.ts`](../src/lib/terminal/shell.ts) | `zsh -ilc` wrappers (see [Interactive login shell](#interactive-login-shell)). |

## Backends

Each backend opens either a **tab** or a **split** (`right` = side-by-side,
`down` = stacked). Syntax below is verified against iTerm 3.6 and Ghostty 1.3.

| Backend | Available when | Tab | Split |
|---|---|---|---|
| `iterm` | macOS + `/Applications/iTerm.app` | `create tab … command` (a window if none open) | `split vertically`/`split horizontally … command` |
| `ghostty` | macOS + `/Applications/Ghostty.app` | `new tab … with configuration cfg` | `split (focused terminal of selected tab of front window) direction …` |
| `tmux` | inside tmux (`$TMUX` set) | `tmux new-window -c <cwd>` | `tmux split-window -h`/`-v -c <cwd>` |
| `vscodium-agent` | macOS + `/Applications/VSCodium.app` | `codium --open-url 'vscodium://swarmify.swarm-ext/spawn?p=<payload>'` | same URL, payload carries `split` |

`buildTab`/`buildSplit` return a `LaunchSpec { argv }`. Ghostty carries `cwd`
natively via the surface configuration; iTerm/tmux `cd` inside the wrapped shell.
`vscodium-agent` is different in kind — see [VSCodium agent terminals](#vscodium-agent-terminals).

## Layout policy — two panes per tab

`planLayouts(count, packing)` assigns a layout to each surface in a batch:

- **`two-per-tab`** (default) — session 1 opens a new **tab**, session 2 **splits**
  it (right), session 3 a new tab, session 4 splits it, … so each tab holds a
  left+right pair. Splits target the front pane, and because the batch runs
  sequentially the split always lands in the tab just opened.
- **`tabs`** — every session gets its own tab.

```
5 sessions, two-per-tab:
  tab 1            tab 2            tab 3
  ┌──────┬──────┐  ┌──────┬──────┐  ┌──────┐
  │ s1   │ s2   │  │ s3   │ s4   │  │ s5   │
  └──────┴──────┘  └──────┴──────┘  └──────┘
```

## Remote (`--host`)

`runRemote` serializes the backend argv into one POSIX-quoted string and runs it
through [`sshExec`](../src/lib/ssh-exec.ts) — the same hardened primitive
`agents sessions --host` and the browser driver use (target-injection guard,
connection multiplexing). Host aliases resolve via the `~/.ssh/config.d/agents`
include that `agents devices` / `agents hosts` maintain, so `--host zion` "just
works".

Caveat: driving a GUI app (iTerm/Ghostty) over SSH needs the remote user logged
into the Mac's GUI session — `osascript` reaches the app through it. `tmux` over
`--host` is unconditional (headless), which is why remote defaults to `tmux`.
`vscodium-agent` also needs a running editor: `codium --open-url` forwards the URL
to the already-open VSCodium instance over its user-scoped IPC socket, so it works
from an SSH session as the same user (no `osascript`, no new window spawned).

## Interactive login shell

The `iterm`, `ghostty`, and `tmux` backends wrap their command in `zsh -ilc '…'`.
The `-i` is load-bearing: the version-pinned shims (`claude@2.1.187`) live in
`~/.agents/.cache/shims`, which `.zshrc` adds to PATH for *interactive* shells
only. A non-interactive `zsh -lc` can't find the shim and the surface dies with
"command not found". The `vscodium-agent` backend does **not** wrap — the command
is sent (via the extension's `sendText`) into an editor terminal that is already
an interactive login shell, so the shims are on PATH already.

## Usage

```ts
import { openSurfaces, availableBackends, currentContext } from '../lib/terminal/index.js';

const items = sessions.map(s => ({ cwd: s.cwd, command: ['claude@' + s.version, '--resume', s.id] }));

await openSurfaces(items, {
  backend: 'ghostty',       // or detectCurrentBackend(currentContext())
  host: 'zion',             // omit for local
  packing: 'two-per-tab',   // or 'tabs'
});
```

### `agents sessions resume`

| Flag | Effect |
|---|---|
| `--iterm` / `--ghostty` / `--tmux` / `--vscodium` | Force a backend (else auto-detect / prompt). |
| `--host <alias>` | Resume on a remote host over SSH (defaults to `tmux`). |
| `--tabs` | One tab per session (default packs two-per-tab). |

Non-resumable agents (where `buildResumeCommand` returns null) are skipped with a
note, never silently dropped. With no GUI backend and no tmux, resume falls back
to an in-place, sequential takeover of the current terminal.

## VSCodium agent terminals

The `vscodium-agent` backend opens each session as an **agent terminal tab** in a
running VSCodium (or Cursor / VS Code) window, driven by the **swarmify**
`swarm-ext` extension. Unlike the terminal-app backends, the editor is already
running — the engine hands it a URL rather than scripting a GUI app:

```
codium --open-url 'vscodium://swarmify.swarm-ext/spawn?p=<base64url(JSON)>'
```

- **The payload is one base64url-encoded JSON param** (`{command, cwd, split?}`),
  not one param per field. VS Code percent-*decodes* `uri.query` once before the
  extension parses it, so a `command`/`cwd` containing `&` or `=` would be
  mis-split by a multi-param query; base64url (`[A-Za-z0-9_-]`) survives that
  decode untouched and round-trips exactly (see `spawnUri`).
- **The `/spawn` verb** (swarmify `extension.ts`) opens an editor-tab terminal in
  `cwd`, sends `command`, and arms *shell adoption* — so a resume command like
  `claude --resume <id>` is auto-promoted to the Claude chip with session
  tracking. `split` splits beside the previous `/spawn` pane, giving the same
  two-per-tab packing as the other backends.
- **Why `--open-url`, not `open`** — the editor CLI forwards the URL to the
  running instance. That needs no OS URL-scheme handler registration, works on
  Linux, and flows over `--host` (the SSH session reaches the same user's editor).
  The per-product scheme must match the CLI: `codium`→`vscodium://`,
  `cursor`→`cursor://`, `code`→`vscode://` (see `EDITOR_VARIANTS` /
  `makeVscodiumAgentBackend`).
- **No `zsh -ilc` wrap** — the command runs in an editor terminal that is already
  an interactive login shell (see [above](#interactive-login-shell)).

Auto-detection is intentionally *not* wired for this backend: a VS Code integrated
terminal reports `TERM_PROGRAM=vscode` for all three products, so the engine can't
tell which one to target. Select it explicitly with `--vscodium` (defaults to
VSCodium), or it appears in the picker when `/Applications/VSCodium.app` is present.
