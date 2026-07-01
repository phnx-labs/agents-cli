---
name: devices
description: "Register and connect to your machines over Tailscale SSH with agents-cli. Use this skill to sync devices from the tailnet, list them, open a shell on another machine, or see agent sessions running across your whole fleet."
argument-hint: "[sync|list|show|add|set|ssh]"
allowed-tools: Bash(agents devices*), Bash(agents ssh*), Bash(agents sessions*)
user-invocable: true
---

# Devices Skill

Manage a registry of SSH device profiles and reach your other machines. The
registry self-populates from `tailscale status --json`, so on a tailnet you
rarely hand-enter a host. This skill teaches the `agents devices` and
`agents ssh` CLIs, plus the fleet-wide `agents sessions --active` view.

## Register devices

```bash
# Ingest the tailnet into device profiles. In a terminal this opens a
# checkbox to register/unregister nodes; --yes registers every non-ignored one.
agents devices sync
agents devices sync --yes

# Register or dismiss a single discovered node.
agents devices register <name>
agents devices ignore <name>      # never suggest it again
agents devices unignore <name>    # undo an ignore
```

## Inspect

```bash
agents devices list               # platform, address, reachability (alias: ls)
agents devices list --json        # registry as a JSON array (for scripts/hooks)
agents devices show <name>        # full profile for one device
```

`list` marks the machine you are on with `▸ <name>  ← this machine`.

## Add / edit manually

```bash
# target is user@host or host; platform is windows | linux | macos
agents devices add <name> <target> --platform linux

# Update fields on an existing device.
agents devices set <name> --user muqsit --platform macos
agents devices set <name> --auth password --bundle <secrets-bundle>

agents devices rm <name>          # remove from the registry (alias: remove)
```

Auth is either `key` (system ssh agent / on-disk keys) or `password` (pulled
from a Keychain-backed secrets bundle — never stored on disk).

## Connect

```bash
# Open a shell (preflights reachability, picks the shell, authenticates).
agents ssh <name>

# Run a one-off command and return.
agents ssh <name> uname -a
```

To use plain `ssh <name>`, render the registry into your ssh config:

```bash
agents devices render            # print the Host stanzas to stdout
agents devices render --write    # write ~/.ssh/config.d/agents
```

## Fleet-wide active sessions

`agents sessions --active` groups running agent sessions by machine, pins the
local box first (`▸ <name> ← this machine`), and folds in sessions from your
registered, online devices over SSH:

```bash
agents sessions --active           # this machine + every online device
agents sessions --active --local   # this machine only (no SSH fan-out)
agents sessions --active --host zion --host mac-mini   # specific machines
agents sessions --active --json    # merged, machine-tagged, for scripts
```

Unreachable or CLI-less hosts are skipped with a note, never fatal. If no
devices are registered, it prints a tip pointing you at `agents devices sync`.

## Tips

- Reachability in `list` is a snapshot from the last `sync`; rerun `sync` to
  refresh it.
- iOS/tablet nodes can't run the CLI and are skipped by the `--active` fan-out.
- A device with password auth needs a bundle: `agents devices set <name>
  --auth password --bundle <name>`.
