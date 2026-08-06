# Quickstart

A guided path from a fresh machine to a working fleet: install the CLI, add
harnesses, run a team, then set up devices you can dispatch to. Each step
names the exact command; run `agents <cmd> --help` if anything below looks
stale — the code wins over this doc.

## 1. Install agents-cli

```bash
npm install -g @phnx-labs/agents-cli   # or: curl -fsSL agi-cli.sh | sh
agents --version
```

Bun works too (`bun install -g @phnx-labs/agents-cli`). Every command also
answers to the shorter alias `ag` — `ag view` and `agents view` are the same
call. Already installed? `agents upgrade` updates the CLI itself (`-y` to
skip the confirm prompt; there is no `agents update`).

## 2. Run first-time setup

```bash
agents setup
```

`agents setup` clones the system config repo into `~/.agents/.system/`,
imports any agent CLI you already had installed outside agents-cli, and — on
a terminal — walks a re-runnable capability hub: browser, computer (macOS),
share, secrets, fleet, watchdog, and two preferences (which machine you sit
at, which browser agents drive here). Everything it touches can also be set
up on its own later:

```bash
agents setup browser    # detect a browser + create the default profile
agents setup secrets    # choose secrets backend/policy defaults
agents setup fleet      # discover Tailscale devices + configure SSH access
```

To check overall health at any point (CLI availability, sign-in state,
resource drift) use `agents doctor`, not a `setup` subcommand:

```bash
agents doctor            # local diagnostics + cross-device divergence
agents doctor --fix      # heal every gap it found
```

## 3. Add harnesses and log in

Install the CLIs for the agents you want to run. `agents add <agent>[@version]`
downloads and installs it; the first version you add for an agent becomes its
default.

```bash
agents add claude@latest
agents add codex@latest
agents add grok@latest
```

Supported harness ids include `claude`, `codex`, `grok`, `kimi`, `antigravity`,
`opencode`, `cursor`, `openclaw`, `copilot`, `droid`, and more — run
`agents add --help` for the option reference, and `agents view` to see
everything currently installed. Don't invent a name that isn't on that list.

Log in the way each harness natively expects — most launch their own OAuth
flow the first time you run them interactively:

```bash
agents run claude   # opens Claude Code's native login on first run
agents run codex
agents run grok
```

Verify a harness is installed, signed in, and reachable headlessly:

```bash
agents view                                                    # installed versions, accounts, usage
agents doctor claude@default                                   # per-resource report for one version
agents run claude "Reply with exactly PINGOK" --mode plan       # headless read-only ping
```

`--mode plan` is read-only (safe to run against anything); `edit` lets the
agent write files, `auto` auto-approves safe operations and prompts for risky
ones, `skip` bypasses all permission prompts. Omit the prompt argument for an
interactive session instead of a headless one.

## 4. Smoke-test teams

`agents teams` runs several agents in parallel on one task, each optionally
isolated in its own git worktree. Check readiness first, then run a minimal
two-teammate team:

```bash
agents teams doctor                       # which agents are installed and available to join a team

agents teams create smoke-test
agents teams add smoke-test claude "Summarize README.md in three bullets" --name reader
agents teams add smoke-test codex  "List every TODO comment in src/" --name scanner
agents teams start smoke-test --watch     # launches both, streams status live
agents teams status smoke-test            # files touched, recent commands, last messages
agents teams disband smoke-test           # stop everyone, clean up the registry entry
```

If you only have one harness signed in, swap the second teammate for the same
agent (`agents teams add smoke-test claude "…" --name scanner`) — teams don't
require distinct harnesses, mixing them is just the common case. Teammates
rotate across signed-in accounts by default (`balanced` strategy); don't pin
every teammate to one account unless it genuinely needs a specific version.

## 5. What is a fleet?

A fleet is simply your own machines, reachable over Tailscale/SSH, that
agents-cli can run commands on or dispatch agents to. Two registries back
this:

- **Devices** — your Tailscale nodes, made addressable. `agents devices sync`
  reads `tailscale status --json` and records a profile (platform, user,
  address, online status) for each one.
- **Hosts** — dispatch targets for agent work. Every registered device is
  automatically also a host; `agents hosts add` can additionally enroll a
  machine from an existing `~/.ssh/config` entry.

See [`00-concepts.md`](00-concepts.md#devices--hosts) for the full model,
[`fleet.md`](fleet.md) for the reconcile profile, and [`hosts.md`](hosts.md)
for the `--host`/`--device` dispatch flags.

Set up the fleet:

```bash
agents setup fleet                  # discover Tailscale nodes, configure SSH access
agents devices sync --yes           # or run this directly — registers every discovered node
agents devices list                 # platform, address, reachability, live headroom
```

Pick the one machine that should show YOU rendered artifacts — a browser
window, a dashboard, a plan — when an agent opens something for you to look
at. This is usually the laptop or desktop you actually sit at:

```bash
agents devices set-interactive worker-1   # replace with your device's name
agents devices set-interactive             # print the current interactive host
```

Once several machines are registered, reconcile them all to one profile —
same agents installed, same config synced, logins propagated from whichever
box is already signed in:

```yaml
# agents.yaml -- add a fleet: block
fleet:
  devices: all                        # every online registered device (minus this one)
  defaults:
    agents: [claude@latest, codex@latest]
    sync: [user]                      # config scopes to reconcile
    login: sync                       # propagate logins where the token is portable
```

```bash
agents apply --plan       # device x dimension matrix; changes nothing
agents apply               # reconcile the fleet (confirms first; -y to skip)
```

`agents apply` is the fleet-wide counterpart to config sync: it installs
missing agents, syncs the named config scopes, and propagates logins so one
signed-in host seeds the rest — instead of running N harnesses' OAuth flows
on every machine by hand. Keep the machine you actually work from lighter than
your worker boxes: point long-running teams and routines at `--devices
worker-1,worker-2` rather than piling everything onto your daily driver.

## 6. Day-2 automation (pointer only)

Two things worth knowing exist, without dumping their full docs here:

- **Slash commands and skills** — a layer of ready-made workflows
  (`/drain`, `/code:loop`, and more) ships from the system config repo that
  `agents setup` already pulled. Details live in that repo's own README
  (`phnx-labs/.agents-system`) rather than duplicated here.
- **`agents routines`** — run any agent on a cron schedule or at a specific
  time, with sandboxed permissions and a long-running scheduler daemon that
  auto-starts on the first `routines add`. See [`03-routines.md`](03-routines.md).

## 7. Where next

| Topic | Doc |
|---|---|
| Concepts — DotAgents repos, resource resolution, devices vs hosts | [`00-concepts.md`](00-concepts.md) |
| Agent cheat sheet — the dozen concepts agents need on one page | [`AGENT-CHEATSHEET.md`](AGENT-CHEATSHEET.md) |
| Teams — DAG dependencies, worktree isolation, cloud dispatch | [`teams.md`](teams.md) |
| Fleet profile sync — the `fleet:` manifest and `agents apply` | [`fleet.md`](fleet.md) |
| Hosts — dispatching `agents run` over SSH | [`hosts.md`](hosts.md) |
| Browser — driving Chrome/Brave/Edge via CDP | [`browser.md`](browser.md) |
| Secrets — Keychain-backed env bundles | [`secrets.md`](secrets.md) |
| Routines — cron-scheduled and webhook-triggered runs | [`03-routines.md`](03-routines.md) |
| Full command reference | root [`README.md`](../../../README.md) and [`docs/README.md`](README.md) |
