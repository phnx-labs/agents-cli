# Version Management

How agents-cli installs, switches, and isolates multiple versions of agent CLIs.

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
