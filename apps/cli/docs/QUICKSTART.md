# Quickstart

A guided path from a fresh machine to a working fleet: install the CLI, add
harnesses, run a team, then set up devices you can dispatch to. Each step
names the exact command; run `agents <cmd> --help` if anything below looks
stale — the code wins over this doc.

## 1. Install agi-cli

```bash
npm install -g @phnx-labs/agents-cli   # or: curl -fsSL agi-cli.sh | sh
agents --version
```

Bun works too (`bun install -g @phnx-labs/agents-cli`). Every command also
answers to the shorter alias `ag` — `ag view` and `agents view` are the same
call. Already installed? `agents upgrade` updates the CLI itself (`-y` to
skip the confirm prompt). `agents update` is a different command — it moves an
installed agent harness to a new release, not agi-cli.

## 2. Run first-time setup

```bash
agents setup
```

`agents setup` clones the system config repo into `~/.agents/.system/`,
imports any agent CLI you already had installed outside agi-cli, and — on
a terminal — walks a re-runnable capability hub: browser, computer (macOS),
share, secrets, fleet, watchdog, and two preferences (which machine you sit
at, which browser agents drive here). Everything it touches can also be set
up on its own later:

```bash
agents setup browser    # detect a browser + create the default profile
agents setup secrets    # choose secrets backend/policy defaults
agents setup fleet      # discover Tailscale devices + configure SSH access
```

Check setup readiness at any point with `agents setup status` (add `--json`
for a machine-readable view). For deeper diagnostics — CLI availability,
sign-in state, resource drift, cross-device divergence — use `agents doctor`
instead; it's the broader umbrella health check, not a `setup` subcommand:

```bash
agents setup status      # readiness for core, browser, computer, secrets, fleet, share, watchdog
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

Need a credential that isn't a browser login — a setup-token, an API key for a
BYOK gateway, a team's shared key? `agents accounts add <name> --provider <p>
--auth <type>` stores it as a named, Touch-ID-free bundle you select with
`agents run <agent> --account <name>` or make the default with `agents
accounts set-default <agent> <name>`; `agents accounts sync <name> --device
<device>` copies it to another machine. See [Accounts](../../../README.md#accounts)
in the root README.

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
agi-cli can run commands on or dispatch agents to. Two registries back
this:

- **Devices** — your Tailscale nodes, made addressable. `agents devices sync`
  reads `tailscale status --json` and records a profile (platform, user,
  address, online status) for each one.
- **Hosts** — dispatch targets for agent work. Every registered device is
  automatically also a host; `agents hosts add` can additionally enroll a
  machine from an existing `~/.ssh/config` entry.

See [`concepts.md`](concepts.md#devices--hosts) for the full model,
[`fleet.md`](fleet.md) for the reconcile profile, and [`hosts.md`](hosts.md)
for the `--host`/`--device` dispatch flags.

Set up the fleet:

```bash
agents setup fleet                  # discover Tailscale nodes, configure SSH access
agents devices sync --yes           # or run this directly — registers every discovered node
agents devices list                 # platform, address, reachability, live headroom
```

Register/ignore decisions are stored in `~/.agents/agents.yaml` under
`fleet.discovery`. Push and pull the user DotAgents repo to carry those decisions
between machines; each machine reconstructs connection details from its own live
Tailscale state.

Pick the one machine that should show YOU rendered artifacts — a browser
window, a dashboard, a plan — when an agent opens something for you to look
at. This is usually the laptop or desktop you actually sit at:

```bash
agents devices config worker-1 interactive.host worker-1   # replace with your device's name
agents devices config worker-1 interactive.host            # print the current interactive host
```

Once several machines are registered, reconcile them all to one profile —
same agents installed and same config synced. Native logins remain local to
each box; portable provider accounts move only through explicit account sync:

```yaml
# agents.yaml -- add a fleet: block
fleet:
  devices: all                        # every online registered device (minus this one)
  defaults:
    agents: [claude@latest, codex@latest]
    sync: [user]                      # config scopes to reconcile
    login: sync                       # report per-device login/account readiness; never copies native OAuth
```

```bash
agents apply --plan       # device x dimension matrix; changes nothing
agents apply               # reconcile the fleet (confirms first; -y to skip)
```

`agents apply` is the fleet-wide counterpart to config sync: it installs
missing agents, syncs the named config scopes, and reports boxes that still need
an interactive login or provider account. Keep the machine you actually work from lighter than
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
  starts at install/upgrade and on setup when `daemon.enabled` is not false.
  See [`routines.md`](routines.md).

## 7. Where next

| Topic | Doc |
|---|---|
| Concepts — DotAgents repos, resource resolution, devices vs hosts | [`concepts.md`](concepts.md) |
| Agent cheat sheet — the dozen concepts agents need on one page | [`AGENT-CHEATSHEET.md`](AGENT-CHEATSHEET.md) |
| Teams — DAG dependencies, worktree isolation, cloud dispatch | [`teams.md`](teams.md) |
| Fleet profile sync — the `fleet:` manifest and `agents apply` | [`fleet.md`](fleet.md) |
| Hosts — dispatching `agents run` over SSH | [`hosts.md`](hosts.md) |
| Browser — driving Chrome/Brave/Edge via CDP | [`browser.md`](browser.md) |
| Secrets — Keychain-backed env bundles | [`secrets.md`](secrets.md) |
| Routines — cron-scheduled and webhook-triggered runs | [`routines.md`](routines.md) |
| Full command reference | root [`README.md`](../../../README.md) and [`docs/README.md`](README.md) |
