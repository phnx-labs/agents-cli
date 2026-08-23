# Core Concepts

The mental model behind agents-cli: what a DotAgents repo is, what resources are, and how the layered resolution system works.

---

## DotAgents repo

A **DotAgents repo** is a directory with a canonical layout that defines resources for AI coding agents:

```
.agents/
  commands/        # Slash commands (Markdown or TOML)
  skills/          # Knowledge packs (subdirectory per skill)
  hooks/           # Lifecycle hooks (shell scripts + hooks.yaml manifest)
  rules/           # Memory files (AGENTS.md, symlinked per agent)
  mcp/             # MCP server definitions (YAML, one file per server)
  permissions/     # Permission groups (YAML)
  profiles/        # Model/endpoint bundles (YAML)
  routers/         # Named router allowlists: harnesses x models/tiers x accounts (YAML)
  subagents/       # Subagent definitions (Markdown)
  agents.yaml      # Version pins and repo metadata
```

Every agents-cli installation maintains two repos:

| Repo | Path | Owner | Purpose |
|------|------|-------|---------|
| **System repo** | `~/.agents/.system/` | agents-cli maintainers | Core resources and defaults shipped with every install. Updated via `npm update -g agents-cli`. |
| **User repo** | `~/.agents/` | You | Your personal additions and overrides. Synced with `agents repos push` / `agents repos pull` (`repo` is an alias). To git-back a fresh/Windows machine whose `~/.agents` isn't a clone yet, run `agents repos pull user <git-url>` once — it adopts the existing directory in place. |

A project can also have a local repo — drop a `.agents/` directory at the project root. Its resources apply only while you're inside that project tree.

Extra repos can be registered via `agents repos add <source>`. They clone into `~/.agents-<alias>/` (peer of `~/.agents/`) and participate in resolution after the user repo.

---

## Resources

A **resource** is any named item inside a DotAgents repo. Resources are typed by which subdirectory they live in — that type is called the **resource kind**.

| Kind | What it is | Agent format |
|------|-----------|--------------|
| `commands` | Slash commands and prompt shortcuts | `.md` (most agents), `.toml` only for legacy Gemini reads |
| `skills` | Knowledge packs injected into the agent's context | Directory with `SKILL.md` |
| `hooks` | Shell scripts that fire on agent lifecycle events | `.sh` scripts + `hooks.yaml` manifest |
| `rules` | Persistent memory / instructions for the agent | `AGENTS.md` → `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, … |
| `mcp` | MCP server definitions (transport, command, args, env) | Merged into each agent's settings file |
| `permissions` | Allow/deny tool permission groups | Converted to each agent's native format |
| `clis` | Named host-CLI wrappers (`clis/<name>.yaml`) | YAML, listed by `agents clis` |
| `profiles` | Model + endpoint + auth bundles | YAML, consumed by `agents run` and shims |
| `routers` | Named, task-typed allowlists of harnesses x models/tiers x linked accounts (a router is a generalization of a profile) | YAML, consumed by the Agent Router |
| `subagents` | Subagent workflow definitions | `.md` files |
| `workflows` | Named workflow scripts (Rhai / harness-native) | Synced into each capable agent's workflow dir |
| `secrets` | Named secret-bundle references (not the secret values) | YAML metadata; values live in `agents secrets` |

Resources are installed once in `~/.agents/` and synced to every supported agent's native format automatically. Sync happens when you run `agents use`, `agents repos pull`, or explicitly via `agents sync`.

To inspect what's installed, use the per-kind listers — `agents commands list`, `agents skills list`, `agents hooks list`, `agents mcp list`, `agents permissions list`, `agents subagents list`, `agents harness list`, `agents route list`. For a single merged cross-kind table — every resource with its winning layer resolved across project → user → extras → system — run `agents view --merged`.

To inspect a single repo on its own — its git state plus per-kind resource counts — use `agents repos view <repo>` (`system`, `user`, `project`, or an extra-repo alias). Omit the name for an interactive picker. It renders without opening anything; add `--brief` for the header only or `--json` for machine-readable output.

---

## Layered resolution

When agents-cli resolves a resource it searches four layers in order and stops at the first match:

```
project (.agents/ at project root)
  └─ user (~/.agents/)
       └─ extra repos (~/.agents-<alias>/)
            └─ system (~/.agents/.system/)
```

**Same-named resource wins at the highest layer.** A `commands/deploy.md` in your user repo overrides the system default. Everything without a name collision unions in — you get all resources from all layers, with higher layers taking precedence on conflicts.

This means:
- The system repo ships sensible defaults for everyone.
- You override or extend them in `~/.agents/` without touching system files.
- A project-local `.agents/` lets you scope resources to a single repo (e.g., a company-specific slash command or a tighter permission set).
- Extra repos let teams share a common set of skills and hooks without merging them into the primary user repo.

The resolution logic lives in `src/lib/resources.ts` — `resolveResource(kind, name)` for a single winner and `listResources(kind)` for the full union with `source` annotations.

### Aliases

A **skill** (its `SKILL.md`) or a **command** can declare alternate names in its frontmatter, and `resolveResource(kind, name)` matches those too:

```yaml
---
name: browser
description: Drive a browser to automate websites
aliases: [agi-browser, web]   # `browser` also resolves under these names
---
```

`aliases:` accepts a YAML list or a comma/space-separated string. Resolution tries the canonical file/dir name across every layer first; only if that misses does it match `name` against declared aliases (again in layer order). So **the canonical name always wins a collision** — a real resource named `browser` beats any resource that merely aliases `browser`, in any layer. `listResources(kind)` surfaces each resource's aliases on its `aliases` field (lazily read, so listing never pays for it unless inspected). Only `skills` and `commands` support aliases today. This is what lets a future `agi` plugin house `agi:browser` while a bare `browser` still resolves via an alias.

---

## Version homes

Each installed agent CLI version gets an isolated **version home** — a directory under `~/.agents/.history/versions/<agent>/<version>/home/` that contains a complete config environment for that version. Syncing copies (or symlinks) the resolved resource set into the version home in the format each agent expects.

When you run `claude` (via the shim), agents-cli reads `agents.yaml`, resolves the version, and sets `HOME` to the matching version home before exec-ing the binary. The agent sees only its version-specific config — no bleed between versions.

See [version-management.md](version-management.md) for install and switching details, and [resource-sync.md](resource-sync.md) for how resources are synced into version homes.

---

## Two application layers

agents-cli is two application-layer surfaces over one shared set of on-disk state.
**`apps/cli`** (the `agents` / `ag` CLI) is the framework: it owns the SQLite session
index, `sessions` / `teams` / `run` / `cloud`, the pid→id registry, the audit log,
and the SSH fan-out to peers. **`apps/ext`** (AGI EXT, the VS Code extension) is a
consumer: it spawns agent terminals, renders CLI-owned state, and sends controls back
through CLI commands. One elected extension monitor owns a long-lived
`agents sessions watch --json` stream; Resume and Fork query transcript history only
when their pickers open. The extension does not discover sessions, rank launch targets,
or read tracker/watchdog state itself. Fix a mechanism in the CLI and every consumer
benefits. Full detail in [architecture.md](architecture.md).

## Two kinds of "session"

"Session" names two unrelated things. A **transcript** is the conversation on disk,
indexed in `sessions.db` and read by `agents sessions` (see [sessions.md](sessions.md)).
A **live identity** is which running pid is which session right now, held in per-pid
cache files and read by `--active` and the extension. The transcript is durable; the
identity is ephemeral. [architecture.md](architecture.md) covers both, including the
two `pid → id` writers (the CLI's registry vs the SessionStart hook).

---

## Devices & Hosts

### Credential accounts

`agents accounts` shows two kinds of identity together. Harness-native auth stays in the
harness version home where its normal login flow created it. A provider account is
one `agents secrets` bundle that can authenticate every compatible harness; the
bundle name is the account label and rotating its key does not change `ACCOUNT_ID`.

```bash
agents accounts
agents accounts add work --provider anthropic --auth setup-token
agents accounts add gateway --provider openrouter --auth api-key \
  --from-secrets openrouter.ai:OPENROUTER_API_KEY
agents accounts switch claude
agents accounts switch claude gateway
agents accounts set-default claude gateway
agents accounts sync gateway --device yosemite-s0
agents run claude --account work
```

The account bundle has a fixed shape: `ACCOUNT_ID`, `PROVIDER`, `AUTH_TYPE`,
optional `BASE_URL`, and either `API_KEY` or `TOKEN`. It always uses secrets policy
`never`, so a background agent launch cannot raise Touch ID. On Linux workers,
`accounts sync` writes the bundle to the encrypted file backend using a
machine-local key; Windows uses Credential Manager. Values cross SSH on stdin,
never argv. Sync is explicit and copies provider bundles only. It never copies
harness-native auth files.

Resolution order is explicit `--account`, then the compatible account selected by
`accounts set-default` / `accounts switch`, then the harness's native/balanced behavior. An incompatible
provider/host pair or a bundle absent from the destination fails before the agent
process starts. A migrated v2 `accounts.yaml` becomes these bundles transactionally;
the old registry is archived only after every bundle was written successfully.

Routine `account:` accepts either kind of identity. A provider-bundle name uses the
same provider adapter and device-local secret as `agents run --account`; when omitted,
the harness default applies before native balancing. A harness-native login identity
(for example a Claude login email) pins the installed version home that owns it and
is never copied or converted into a provider bundle. Missing native pins, mismatched
`version:` pins, missing provider bundles, and incompatible providers all fail before
spawn instead of rotating to another identity.

Usage and authentication health are device-local read models owned by the
agents-cli daemon. Every ordinary consumer (`agents run`, `view`, `versions`,
`teams`, device inventory, and the ext) reads the same persisted snapshots and
never calls a provider or scans usage logs on its render path. The daemon
considers usage every 60 seconds (each account retains its provider-aware due
time and backoff) and authentication every three minutes. `agents usage
<agent> --refresh`, `agents view --refresh`, and inventory refreshes request an
explicit collection through the same per-account cross-process lease; concurrent
CLI processes wait for and reuse the first published result.

Only safe metadata crosses devices: account identity, quota snapshots, and auth
verdicts. Raw API keys remain in each device's credential store. OAuth remains
per-device and harness-managed; use the harness's interactive login on the
interactive device rather than copying its OAuth files to another machine.

agents-cli can run commands on **other machines**, not just the local one. Two
independent registries back this, both using SSH as the only transport (no daemon).

**Devices** — your Tailscale fleet, made addressable. `agents devices sync` reads
`tailscale status --json` and records a profile per machine (platform, login user,
Tailscale DNS name / IP, auth method, online status) in
`~/.agents/.history/devices/registry.json`. That registry is **machine-local** — it
embeds addresses, so it lives under `.history/` and is *not* carried by
`agents repo push`. `agents ssh <name>` connects through it: it fails fast when a
device is offline, runs PowerShell or POSIX per platform, and can pull an SSH
password from a Keychain bundle via an askpass shim. `agents devices render --write`
emits a `~/.ssh/config.d/agents` include so plain `ssh`/`scp`/`rsync` resolve the
same logical names.

Approval is portable even though connection metadata is not. Registering or
ignoring a device records `approved` or `ignored` under `fleet.discovery` in
the central `~/.agents/agents.yaml`; no entry means the device is still pending.
`agents repo push user` carries those decisions, and `agents repo pull user`
reconciles them into each machine's local registry and ignore-list. Approved
devices resolve their address live from Tailscale; addresses, SSH auth, and
reachability never enter Git.

**Per-device and fleet-wide settings** live in a three-layer store, read in
order — built-in default < fleet default < per-device value:

| Layer | Home | Tracked | Written by |
|---|---|---|---|
| Per-device operator config | `~/.agents/devices/<name>/agents.yaml` → `config:` | yes (syncs via repo push/pull) | `agents devices config <name> …` |
| Fleet-wide defaults | central `~/.agents/agents.yaml` → `fleet.defaults.config` | yes | `agents devices config --fleet <key> <value>` |
| Agent pins / machine state | `~/.agents/.history/devices/pins-<host>.json` | no (runtime, like version-resources.json) | auto-pin code paths |

Per-device docs are conflict-free by construction: each machine writes only
its own folder, and the churny auto-written agent pins no longer share the
file (they moved to the untracked pins JSON — the root-cause fix that let
`devices/` be tracked again). ONE command owns the settings: `agents devices
config <name> [key] [value] [--unset] [--json]` — bare opens an interactive
settings menu on a TTY (and prints the resolved config when piped), `key`
reads the effective value back, `key value` sets it with validation,
`key --unset` removes the device value so the fleet default applies, `notes
<text>` appends a free-form operator note, and `--fleet` targets the
fleet-wide defaults layer. `--json` reports each key's `source` (`device` |
`fleet` | `default`). Device-scope keys: `role` (`worker` \| `personal`; also
`agents devices role`), `description` (one line saying what the box is for —
synced fleet-wide, rendered in tables; capped at 80 chars, single line only),
`agents.max-concurrent`, `scheduler.enabled`,
`daemon.enabled`, `watchdog.enabled`, `tmux.enabled`,
`browser.remote-control`, `browser.profile`, `notes` (an appended list of
long-form operator scratch — not the one-line `description`), the `ssh.*` profile
overrides, `platform`, `auto-launch.*`. Keys only the owning box reads
(`scheduler.enabled`, `daemon.enabled`, `tmux.enabled`,
`browser.remote-control`, `browser.task-idle-minutes`, `browser.profile`) are
refused for a peer — run them on that box. The device registry stays the **discovery cache** (address,
tailscale snapshot, reachability); the config's `ssh.*` / `platform` / user
values overlay the registry profile at dial time
(`src/lib/devices/resolve-profile.ts`), so `agents ssh`, the ssh_config
render, host dispatch, and the `devices list` table all honor them. User-scope
keys live in the central file: `interactive.host` (`config.interactiveHost`)
names the device agents show YOU artifacts on (browser opens, dashboards), so
skills stop guessing "the online macOS box"; `auto.pool` (`config.autoPool`)
selects which devices `--device auto` may pick (`workers` or `all`). Usage
collection has a separate user-scope pin, `usage.primary-host`
(`config.usagePrimaryHost`), operated only through `agents config
set|get|unset|list`. `resolveUsagePrimaryHost()` resolves the explicit usage
pin first, then falls back to `interactive.host`, then to no primary host. The
interactive host answers where the user sees artifacts; it does not by itself
declare that device authoritative for usage. The interactive host is marked
`★ interactive` in `agents devices list`; `list --json` carries each row's
effective profile plus its device-layer `config` block and an `interactive`
flag. The retired subcommands (`configure`, `note`, `set`, `set-interactive`,
`enable`/`disable`/`prefer`/`unprefer`) still work as hidden tombstones that
forward into `devices config` with a stderr notice. Unset keys always mean
today's behavior. The key registry is `src/lib/device-config.ts`.

The keys are consumed, not just stored. `scheduler.enabled=false` keeps the
routines scheduler from starting on that device — `routines add` skips the
auto-start with the reason, `routines start` refuses, and a running daemon
re-evaluates the gate on every SIGHUP reload, so flipping the key never needs a
daemon restart. `agents.max-concurrent` feeds host ranking, and what counts
toward it depends on the consumer: AGI EXT auto-launch counts device-wide
running agents, while teams placement counts the team's own roster on the
device (local teammates included); a capped device is excluded from auto-pick
with a stated reason, and an all-capped pool fails loud. Setup asks instead of
guessing: bare `agents setup` opens a re-runnable capability hub with live
ready/missing status for core, browser, computer, secrets, fleet, share,
watchdog, and preferences. Selecting preferences runs the skippable questions
(which machine you sit at → `interactive.host`; which browser agents drive here
→ `browser.profile`), `agents setup fleet` offers the interactive host after a
sync, and `agents setup browser` highlights the auto-detect winner in its
picker. `agents setup status --json` exposes the same probes to automation.

**Hosts** — machines you dispatch agent work to. `agents hosts add` enrolls a
target either from an existing `~/.ssh/config` stanza (connection details stay in
ssh config; agents-cli stores only a caps/os overlay) or *inline* (with its own
`user@address`). The host registry lives in `agents.yaml` under `hosts:` and **is**
git-synced with `agents repo push`/`pull`, so a fleet definition travels between
machines. The `-D, --device <name>` flag routes a command over
SSH to that machine — supported on virtually every first-class group (`repos`,
`view`, `inspect`, `usage`, `cost`, `doctor`, `list`, `sync`, `plugins`, `skills`,
`teams`, `routines`, …), plus commands with their own richer host
handling (`run`, `sessions`, `feed`, `computer`, `secrets`, `logs`). Groups with
no remote semantics reject the flag with a clear message rather than commander's
raw `unknown option`. The target may be a registered host name, a capability tag
(`--device gpu --any`), a raw `user@host`, or the special value `auto`
(`--device auto`) to pick the least-loaded reachable host where
the requested agent is installed and signed in, keeping execution local when no
remote is better. `agents run` and `agents teams add` use this live harness-aware
pick. Generic host-only callers such as `agents ssh auto`, which have no requested
harness to validate, retain the 14-day `sessions.db` affinity resolver; `agents
ssh` also refuses a pick that lands on the current machine because its purpose is
to dial out. Harness is always the agent you type, never auto-picked. Probe
failure aborts automatic placement.

UI clients read the owning JSON surfaces: `agents devices list --json` for the
effective profile/config and resource health, `agents devices status --json` for
the fleet health report, and `agents devices accounts --json` for account quota
verdicts and timestamps. These reads are advisory; launch remains one CLI-owned
transaction, for example `agents run auto --interactive --device auto --strategy
balanced --mode auto`.

The two registries feed **one host pool** behind the `HostProvider` seam:
`local` (agents.yaml overlay ∪ ssh-config) registers first, `devices` (the
Tailscale registry) second, so an enrolled host shadows a same-name device.
A device registered once with `agents devices sync` therefore shows up in
`agents hosts list` (SOURCE `devices`), resolves as a `--device` target, and
participates in capability routing — password-auth devices are listed but
marked non-dispatchable (offload rides `BatchMode=yes` ssh). To tag a device
with capabilities, `agents hosts add <device> --cap gpu` enrolls it inline,
sourcing the address from its device profile. `agents devices render --write`
still bridges to plain `ssh`/`scp` via ssh_config.

Hosts are execution targets everywhere runs and tasks dispatch: `agents run
--device`, `agents teams` placement, `agents cloud run --device <name>` (the `host`
cloud provider — tasks visible in both `agents cloud ps` and `agents hosts
ps`), and routines placement (`agents routines add … --run-on <name>`). See
[hosts.md](hosts.md) for the `--device` execution model and the option-forwarding
contract.

## Placement

**One question, one object:** *where does the agent body run?*

```yaml
where:
  kind: local | device | fleet | cloud | lease
  target: yosemite-s0 | auto | hetzner   # optional
```

The CLI still accepts the historical flags; they all map onto this shape
(`src/lib/placement.ts`). Prefer **`--where`** on `agents run` when you want
one door:

| Intent | Placement | Flag / path (aliases still work) |
|---|---|---|
| This machine | `kind: local` | (default) · `--where local` |
| Named fleet / host box | `kind: device, target: <name>` | `--where device:<name>` · `--device` |
| Live healthy/load-aware pick | `kind: device, target: auto` | `--where auto` · `--device auto` |
| Disposable crabbox | `kind: lease` | `--where lease` · `--lease` |
| Warm crabbox reuse | `kind: lease, target: <slug>` | `--box <slug>` |
| Routines: body on one box | `kind: device` | `--run-on <name>` · `--placement host` |
| Routines: pick any online | `kind: fleet` | `--placement fleet` |
| Vendor cloud task | `kind: cloud` | `--cloud` · `--where cloud[:provider]` · `agents cloud run …` |

**Cloud placement.** `--cloud` routes the run to the agent's native vendor
cloud through the provider registry — the same dispatch as `agents cloud run
--agent <agent>`, tracked by `agents cloud list/status/logs/cancel/message`.
Routing: claude→rush, codex→codex, cursor→cursor, droid→factory, antigravity→antigravity;
`--provider` overrides. An agent with no native cloud (kimi, grok,
opencode, …) fails loud unless `--provider` is given. Cloud tasks run in the
provider's workspace on the provider's accounts, so local-run flags
(`--loop`, `--resume`, `--secrets`, `--terminal`, `--cwd`, account strategy,
…) are rejected rather than silently dropped, and `--repo` / `--branch` /
`--cloud-env` require `--cloud`. Source: `src/commands/run-cloud.ts`,
`src/lib/cloud/dispatch.ts` (the one dispatch path both surfaces share).

**Owner is not placement.** On monitors, `--device` pins who *evaluates and
fires* (exactly-once owner). `--run-on` is where the *action body* runs. Same
word `--device`, opposite jobs — always say "owner" vs "body placement" in
docs and help.

Mixing doors fails loud (`--where` + `--device`, `--device` + `--lease`, …). Source
of truth: [`src/lib/placement.ts`](../src/lib/placement.ts).

---

## Capability matrix

`src/lib/agents.ts` is the canonical capability matrix for resource sync. Every gateable resource kind is declared per agent so prompt, sync, and staleness code can share the same source of truth.

| Agent | Hooks | MCP | Permissions | Skills | Commands | Plugins | Subagents | Rules | Workflows |
|------|-------|-----|-------------|--------|----------|---------|-----------|-------|-----------|
| Claude | yes | yes | yes | yes | yes | yes | yes | `CLAUDE.md` | yes |
| Codex | >= 0.116.0 | yes | >= 0.138.0 | yes | < 0.117.0 · skills ($name, >= 0.117) | >= 0.128.0 | >= 0.117.0 | `AGENTS.md` | no |
| Cursor | yes | yes | yes | yes | IDE + skills ($name) | yes | >= 2026.1.22 | `.cursorrules` | no |
| OpenCode | no | yes | >= 1.1.1 | yes | yes | no | no | `AGENTS.md` | no |
| OpenClaw | yes | yes | yes | yes | gateway | yes | yes | `workspace/AGENTS.md` | no |
| Copilot | no | yes | no | yes | yes | no | no | `AGENTS.md` | no |
| Amp | no | yes | no | yes | yes | no | no | `AGENTS.md` | no |
| Kiro | no | yes | >= 2.8.0 | yes | yes | no | >= 1.23.0 | `AGENTS.md` | no |
| Goose | >= 1.34.0 | yes | no | >= 1.25.0 | yes | yes | yes | `AGENTS.md` | yes |
| Roo Code | no | yes | no | yes | yes | no | no | `AGENTS.md` | no |
| Antigravity | yes | yes | yes | yes | yes | yes | >= 1.0.16 | `AGENTS.md` | >= 1.0.6 |
| Grok | yes | yes | yes | yes | skills ($name) | yes | no | `AGENTS.md` | >= 0.2.111 |
| Kimi | yes | yes | yes | yes | no | yes | yes | `AGENTS.md` | yes |
| Droid | yes | yes | >= 0.57.5 | >= 0.26.0 | yes | yes | yes | `AGENTS.md` | no |
| Hermes | no | yes | yes | yes | no | yes | no | `MEMORY.md` | no |
| Pi (Oh My Pi) | no | yes | no | yes | yes | no | yes | `AGENTS.md` | no |
| Warp Agent CLI | no | yes | no | yes | no | no | no | `AGENTS.md` | no |

Pi (`omp`) is Claude-compatible — it natively reads `.claude/commands`, `.mcp.json`, and
Claude-shaped subagents, and keeps its own native resources under `~/.omp/agent/`
(skills, commands, `agents/`, the `AGENTS.md` context file, and `.mcp.json`). Its MCP
covers stdio + http + headers. Hooks are off (omp hooks are per-tool JS/TS extension
modules, not event→shell-command registrations); allowlist is off (approval is per-TOOL
only via `tools.approval`, no command/path patterns); plugins are off (npm/TS modules, not
the Claude marketplace manifest). Its cross-provider model catalog (OpenRouter, OpenAI,
Anthropic, xAI, DeepSeek, …) surfaces in `agents view` / `agents models pi` via
`omp models --json`.

Warp Agent CLI (`oz`) is the coding-agent CLI on Warp's Oz platform. Install is
self-updating (`brew install --cask oz` / the `oz-stable` apt|yum|pacman package);
config lives under `~/.warp/`, the rules file is `AGENTS.md`, and auth is `oz login`
(browser OAuth) or a `WARP_API_KEY` token for headless/CI. MCP rides the Claude
`.mcp.json` schema at `~/.warp/.mcp.json` (stdio + http + headers); skills come from
`--skill` + `oz agent skills`. Hooks, allowlist, commands, plugins, subagents,
workflows, and memory are off (Oz exposes no matching install surface — its
permissions are profile-based, its slash-commands native/server-managed, its cloud
agents server-side). Warp is absent from `SESSION_AGENTS`: Oz stores conversations
server-side (retrieved via `oz run conversation get <id>`), so there is no local
transcript for `agents sessions` to index, and it exposes no usage/limits endpoint.

**Gemini is hard-deprecated.** Google retired the Gemini CLI for free/Pro/Ultra
tiers on June 18, 2026 (announced at Google I/O 2026); Antigravity CLI
(`antigravity`) is the successor. agents-cli keeps the legacy `gemini` id only
for old sessions/config, and blocks `agents add gemini`, `agents import gemini`,
and `agents sync gemini`.

Permissions sync is gated on the `allowlist` capability (Claude, Codex >= 0.138.0, Cursor, OpenCode >= 1.1.1, Antigravity, Grok, Kimi, Kiro 2.8.0+, Droid >= 0.57.5, OpenClaw, Copilot, and Hermes). Goose is deliberately excluded: its `permission.yaml` gates whole tools (`developer__shell`, `developer__text_editor`), so distinct canonical rules collapse onto one entry and cannot be read back faithfully. Workflow sync writes Claude workflow bundles, Kimi `type: flow` skills with an `agents_workflow` ownership marker, Goose recipe YAML, Antigravity workflow markdown (since 1.0.6), and OpenClaw Lobster `.lobster` files under `.openclaw/workflows/` with an `AGENTS_CLI_WORKFLOW` ownership marker. Antigravity workflows are the one non-version-isolated target: `agy` scans a single shared `~/.gemini/config/global_workflows/` at startup (a real HOME directory, never symlinked per version), so agents-cli writes there once for all installed antigravity versions and reads it back the same way — the `agents_workflow` marker guards user-authored files from being overwritten or removed. **Host CLIs** (`agents clis`) are agent-agnostic PATH binaries — not in this matrix. Install paths call `supports(agent, cap, version)` before writing; gated capabilities skip with a clear reason instead of silently ignored config.

OpenClaw gates at tool granularity only, so permission sync maps just **blanket** (whole-tool) rules to `~/.openclaw/openclaw.json` `tools.alsoAllow` (allow) / `tools.deny` (deny): `bash → exec`, `read → read`, `write`/`edit → write`, `webfetch → web_fetch`, `websearch → web_search`. Sub-command/path/domain rules (`Bash(git:*)`, `Write(secrets/**)`, `WebFetch(domain:x)`) have no tool-level equivalent and are skipped. The absolute `tools.allow` list is never touched.

Hermes permission sync maps canonical Bash allow rules to `~/.hermes/config.yaml` `command_allowlist` and Bash deny rules to `approvals.deny`. Hermes stores command globs only; session-scoped `/tools` toggles are not config-persistent and are not written.

### Per-command targeting

Slash commands in `commands/*.md` can narrow sync with optional YAML frontmatter:

```yaml
---
description: Required one-line summary
agents: [claude, cursor, codex]   # omit = all compatible agents; Cursor receives both formats
since: "0.116.0"                  # minimum agent CLI version (inclusive)
until: "0.117.0"                  # exclusive upper bound
aliases: [deploy, ship]           # alternate names this command also resolves under
---
```

`commandAppliesTo()` in `src/lib/commands.ts` evaluates these fields after the agent-level `commands` / commands-as-skills gate. The check runs on central sync (`~/.agents/commands/` user/system → version home) and on `agents commands install`; project `.agents/commands/` files are discovered in place and are not filtered by `agents:`.
