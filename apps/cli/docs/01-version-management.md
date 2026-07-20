# Version Management

How agents-cli installs, switches, and isolates multiple versions of agent CLIs.

> This page covers versions of the *agent CLIs* agents-cli manages (Claude Code,
> Codex, etc.). To update **agents-cli itself**, run `agents upgrade` (see
> `agents upgrade --help`) -- unrelated to the mechanism below.

## Architecture

```
~/.agents/
  agents.yaml                           # Global defaults: agents.claude = "2.0.65"
  versions/
    claude/
      2.0.65/
        node_modules/.bin/claude        # Installed CLI binary
        home/
          .claude/                      # Isolated config for this version
            commands/  -> ~/.agents/commands/   (symlink)
            skills/    -> ~/.agents/skills/     (symlink)
            CLAUDE.md  -> ~/.agents/rules/AGENTS.md (symlink)
      2.0.70/
        node_modules/.bin/claude
        home/.claude/
    codex/
      0.98.0/
        ...
  shims/
    claude                              # Version-resolving wrapper script
    codex
  backups/
    claude/
      1709856000000/                    # Timestamped backup of original ~/.claude/
```

## Version Resolution

```
User runs: claude --help
           │
           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  ~/.agents-system/shims/claude (bash script)                               │
│                                                                     │
│  1. Walk up from $PWD looking for project agents.yaml               │
│     └─ Parse agents.claude: "2.0.70" (skips ~/.agents/agents.yaml)  │
│                                                                     │
│  2. If not found, read ~/.agents/agents.yaml (user default)         │
│     └─ Parse: agents.claude = "2.0.65"                              │
│                                                                     │
│  3. If version not installed, auto-install (project versions only)  │
│                                                                     │
│  4. exec ~/.agents-system/versions/claude/{version}/node_modules/.bin/claude │
└─────────────────────────────────────────────────────────────────────┘
```

## Agent-Spec Resolution

The shim above resolves a version from config for a *bare* `claude` launch. Every
CLI subcommand that takes an `<agent>[@<qualifier>]` argument — `view`, `inspect`,
`sync`, `run`, and the `*list*` commands — resolves that spec through one engine,
[`src/lib/agent-spec/`](../src/lib/agent-spec/). The core is **pure**: it takes a
`VersionProvider` instead of touching the filesystem (so it is unit-tested with
in-memory fixtures), and `provider.ts` binds the real one. Entry points:
`resolveAgentTargets` (multi), `resolveSingleAgentTarget` (exactly one),
`resolveVersionFilter` / `resolveListFilter` (read/list filters).

### Qualifier vocabulary

| Spec | Resolves to |
|------|-------------|
| `claude` (bare) | project pin (`agents.yaml`) → global default → the sole installed version. If more than one is installed with no default, state-changing commands error ("specify one"); `run`/`exec` pick the newest with a note. |
| `claude@2.1.187` | that exact version (must be installed) |
| `claude@latest` | newest **installed** version |
| `claude@oldest` | oldest installed version |
| `claude@pinned` / `claude@default` | the configured global default (synonyms) |
| `claude@all` | every installed version (multi-target; rejected where exactly one is required) |
| `claude@all,codex@latest` | comma-separated multi-spec |

Each resolved target carries a `source` provenance tag (`project-pin`,
`global-default`, `sole-installed`, `newest-installed`, `alias-latest`/`-oldest`,
`explicit`, `none`). Exact versions are validated against `VERSION_RE` before any
filesystem or exec use.

### Two meanings of `latest`

- **Install** — `agents add claude@latest` → the newest version published on
  **npm** (`getLatestNpmVersion`, network).
- **Resolve** — `agents view/run/sync claude@latest` → the newest **installed**
  version (no network).

The engine's domain is installed versions only.

### Non-semver versions

Ordering is by `compareVersions` (numeric per `.`-segment), so date-style schemes
like OpenClaw's `yyyy.m.d` sort correctly. A trailing `-N` rebuild suffix
(`2026.2.19-2`) breaks same-day ties — a higher `-N` is newer. This is
deliberately **not** full semver: OpenClaw's `-N` means *newer*, the opposite of a
semver pre-release, so a semver comparator would invert it. Suffix-free versions
are unaffected.

### `@default` in read/list commands

For the read/list commands (`skills list`, `hooks list`, `rules list`, …) a bare
spec shows **all** installed versions; `@default` / `@pinned` scopes to the
**configured default version** (matching `view`).

## Installation Flow

```
agents add claude@2.0.65
           │
           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  installVersion(agent, version)                                     │
│  src/lib/versions.ts:installVersion()                               │
│                                                                     │
│  1. Create ~/.agents-system/versions/claude/2.0.65/                        │
│  2. npm install @anthropic-ai/claude-code@2.0.65                    │
│  3. Create home dir: versions/claude/2.0.65/home/.claude/           │
│  4. syncResourcesToVersion() - symlink central resources            │
│  5. createShim() - generate ~/.agents-system/shims/claude                  │
│  6. createVersionedAlias() - generate ~/.agents-system/shims/claude@2.0.65 │
└─────────────────────────────────────────────────────────────────────┘
```

## Config Symlink Switching

When `agents use claude@2.0.65` runs, the user's `~/.claude/` becomes a symlink:

```
BEFORE (first use):
~/.claude/                    # Real directory with user's config
  settings.json
  commands/
  CLAUDE.md

AFTER:
~/.claude/ -> ~/.agents-system/versions/claude/2.0.65/home/.claude/   (symlink)
~/.agents-system/backups/claude/1709856000000/                        (backup)
  settings.json
  commands/
  CLAUDE.md
```

Key behaviors:
- Only `agents use` can set the global default (via `setGlobalDefault()`)
- Real directories are backed up before being replaced with symlinks
- Subsequent switches just update the symlink target (no new backups)
- Each version has isolated auth in its `home/` directory

## Uninstalling (reversing adoption)

`agents uninstall` is the reverse of `agents setup`: it completely removes
agents-cli **and restores the config directories adoption took over**, so the
machine is left as it was before agents-cli was installed.

The ordering matters — the config backups live inside `~/.agents`, so restore
runs before disposal:

```
agents uninstall
    │
    ▼
  1. Restore each adopted ~/.<agent>          (lib/uninstall.ts: planUninstall/executeUninstall)
       owned symlink? (getConfigSymlinkVersion != null)
         → newest backup exists  → move backups/<agent>/<ts> back to ~/.<agent>
         → else (importAgent)     → copy the symlink target (version home) back
       real, un-adopted dir?      → LEFT UNTOUCHED
  2. Restore owned home files      (~/.claude.json, ...)
  3. releaseAdoptedLauncher()      restore native binaries on PATH
  4. stripShimPathLines()          remove the shim dir from every shell rc file
  5. dispose ~/.agents             move aside to ~/.agents.removed-<ts> (default)
                                    or hard-delete with --purge
  6. print `npm uninstall -g @phnx-labs/agents-cli`   (a CLI can't delete its own binary)
```

Guarantees:
- **A `~/.<agent>` that agents-cli never adopted is never touched.** Ownership is
  decided structurally by `getConfigSymlinkVersion()` (non-null only for a symlink
  into the versions dir) — the same check `removeVersion()` uses.
- **Recoverable by default.** `~/.agents` (installed versions, session history,
  secrets metadata) is moved to `~/.agents.removed-<timestamp>`, not deleted.
  `--purge` hard-deletes it instead.
- **`--purge` self-downgrades on error.** If any restore step fails, `--purge` is
  automatically demoted to the recoverable move-aside — a swallowed error can never
  take the user's only copy of a config with it. The command says so in its output.
- **Cross-volume safe.** Restores move data with a rename, falling back to
  copy-then-remove when `~/.agents` lives on a different filesystem than `$HOME`
  (`renameSync` would throw `EXDEV`). Resource symlinks that point back into
  `~/.agents` are stripped from a restored config so nothing dangles post-uninstall.
- **`--dry-run`** prints the full plan (what is restored, what is left untouched,
  what is removed) without changing anything.
- `uninstall` is exempt from the setup gate, so it runs even from a broken or
  half-initialized state.

Note: with `--purge`, macOS Keychain items created by `agents secrets` are not
removed (they are managed by the signed helper app); remove those with
`agents secrets` before uninstalling if you want them gone.

## Isolated Installs

`agents add <agent>@<version> --isolated` installs a fully self-contained copy
that never touches the user's existing setup. It is the escape hatch for "give me
a clean, separate <agent> without disturbing my current one."

An isolated install deliberately SKIPS every adopting side effect of a normal
install:

- No global default is set or offered (`setGlobalDefault()` is never called).
- No bare `<agent>` shim is created, so nothing on `PATH` is shadowed.
- The real `~/.<agent>` is never backed up or replaced with a symlink
  (`switchConfigSymlink()` is never called).
- No settings carry-over and no resource sync — the copy starts pristine, with
  its own `home/` config and its own login.

What it DOES create is just enough to launch the copy explicitly:

```
agents add claude@2.1.112 --isolated
           │
           ▼
  installVersion()                 # same npm install into versions/claude/2.1.112/
  createVersionedAlias()           # ~/.agents-system/shims/claude@2.1.112
  markVersionIsolated()            # writes versions/claude/2.1.112/.isolated
```

Run it with an explicit version selector (PATH-independent):

```
agents run claude@2.1.112 "your prompt"
```

The `.isolated` sentinel lives at the version-dir root, so it travels to trash on
removal and is restored intact. Two consequences follow from the marker:

- `removeVersion()` never auto-promotes an isolated version to the global
  default; if the only survivors are isolated, it clears the default instead.
- `agents remove <agent>@<version> --isolated` refuses to remove anything that is
  NOT an isolated install, and its picker only lists isolated versions — so a
  normal/default install (and the real `~/.<agent>`) can never be removed by
  accident. Removal is still a soft-delete to trash, recoverable via
  `agents trash restore`.

`--isolated` cannot be combined with `--project` (an isolated copy is
global-but-separate; a project pin selects a shared install for one directory).

## Resource Syncing

`syncResourcesToVersion()` links central `~/.agents/` resources into version homes:

```
~/.agents/commands/foo.md  ──symlink──▶  ~/.agents-system/versions/claude/2.0.65/home/.claude/commands/foo.md
~/.agents/skills/bar/      ──symlink──▶  ~/.agents-system/versions/claude/2.0.65/home/.claude/skills/bar/
~/.agents/rules/AGENTS.md ──symlink──▶  ~/.agents-system/versions/claude/2.0.65/home/.claude/CLAUDE.md
```

Special case: Gemini requires TOML format, so commands are converted (not symlinked).

## Shim Process Contract

The shim is more than a version router — it's a process-model contract that
downstream consumers (VS Code extensions, IDEs, daemons) depend on. Two
guarantees:

### 1. `exec`-replacement, not `fork+exec`

The shim's final line is always:

```bash
exec "$BINARY" "$@"
```

`exec` replaces the shim process in place. The shell's direct child pid *is*
the shim pid — which, after `exec`, *is* the agent CLI. No wrapper process
remains as a parent of the agent.

```
Process tree after `claude@2.1.112` runs at the shell:

  zsh(shell_pid)
    └─ /bin/bash(shim_pid)              ← shim script starts here
         ├─ (transient) agents sync     ← project resource sync, ~100ms
         └─ (exec replaces) node claude ← same pid, now IS claude
```

### 2. Signals propagate cleanly

Because `exec` replaces rather than forks, `SIGINT` (Ctrl+C) and `SIGTERM`
from the shell hit the agent CLI directly. A second `SIGINT` exits the agent
and returns control to the shell — `pgrep -P shell_pid` returns empty, the
shell is idle at prompt.

### Why this matters

Any consumer that drives an agent terminal programmatically — Companion's VS
Code extension is the primary one today — relies on these two guarantees to
observe lifecycle transitions via `pgrep`/`ps` without hooking the terminal's
pty output. Specifically:

- **"Agent is running"** is detectable as "shell has a child pid."
- **"Agent has exited, shell is idle"** is detectable as "shell has no
  children."
- **"Which process is the agent"** is always the immediate child of the
  shell, not a deeper descendant.

### What would break the contract

| Hypothetical change | Breaks |
|---|---|
| Shim uses `$BINARY "$@"` instead of `exec $BINARY "$@"` | `pgrep -P shell_pid` keeps returning the shim pid even after the agent exits; consumers can't detect "shell idle" |
| Shim wraps the agent in `tmux`/`screen`/`agents pty` as a persistent parent | `pgrep -P shell_pid` returns the wrapper pid; the actual agent is a deeper descendant, requiring a tree-walk |
| Shim daemonizes or backgrounds the agent | Terminal's pty is not the agent's stdin; typed input goes to the wrong process |

When introducing new launch modes, preserve this contract or provide an
explicit alternative detection path for consumers.

## Key Functions

| Function | File | Purpose |
|----------|------|---------|
| `installVersion()` | versions.ts | Install agent CLI version |
| `removeVersion()` | versions.ts | Remove installed version |
| `resolveVersion()` | versions.ts | Find version from project/global config |
| `syncResourcesToVersion()` | versions.ts | Symlink resources into version home |
| `switchConfigSymlink()` | shims.ts | Replace ~/.{agent} with symlink |
| `createShim()` | shims.ts | Generate version-resolving wrapper |
| `setGlobalDefault()` | versions.ts | Set default in agents.yaml |
