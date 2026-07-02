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

`buildTab`/`buildSplit` return a `LaunchSpec { argv }`. Ghostty carries `cwd`
natively via the surface configuration; iTerm/tmux `cd` inside the wrapped shell.

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

## Interactive login shell

Every backend wraps its command in `zsh -ilc '…'`. The `-i` is load-bearing: the
version-pinned shims (`claude@2.1.187`) live in `~/.agents/.cache/shims`, which
`.zshrc` adds to PATH for *interactive* shells only. A non-interactive
`zsh -lc` can't find the shim and the surface dies with "command not found".

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
| `--iterm` / `--ghostty` / `--tmux` | Force a backend (else auto-detect / prompt). |
| `--host <alias>` | Resume on a remote host over SSH (defaults to `tmux`). |
| `--tabs` | One tab per session (default packs two-per-tab). |

Non-resumable agents (where `buildResumeCommand` returns null) are skipped with a
note, never silently dropped. With no GUI backend and no tmux, resume falls back
to an in-place, sequential takeover of the current terminal.

## Not yet: VSCodium agent terminals

A `vscodium-agent` backend is planned but needs a change in the **swarmify**
extension: it can only *focus* existing terminals from outside (its
`vscode://…/focus` URI handler and `~/.agents/.tmp/watchdog.sock`), with no
"open a terminal" verb. Adding a `/spawn` path to that URI handler — wired to the
extension's `openSingleAgent` — is the seam; the engine backend would then just
build an `open "vscode://…/spawn?…"` argv, which flows over `--host` like the
rest. Tracked as a separate, cross-repo change.
