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
| `profiles` | Model + endpoint + auth bundles | YAML, consumed by `agents run` and shims |
| `subagents` | Subagent workflow definitions | `.md` files |

Resources are installed once in `~/.agents/` and synced to every supported agent's native format automatically. Sync happens when you run `agents use`, `agents repos pull`, or explicitly via `agents sync`.

To inspect what's installed, use the per-kind listers — `agents commands list`, `agents skills list`, `agents hooks list`, `agents mcp list`, `agents permissions list`, `agents subagents list`, `agents profiles list`. For a single merged cross-kind table — every resource with its winning layer resolved across project → user → extras → system — run `agents view --merged`.

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

---

## Version homes

Each installed agent CLI version gets an isolated **version home** — a directory under `~/.agents/.history/versions/<agent>/<version>/home/` that contains a complete config environment for that version. Syncing copies (or symlinks) the resolved resource set into the version home in the format each agent expects.

When you run `claude` (via the shim), agents-cli reads `agents.yaml`, resolves the version, and sets `HOME` to the matching version home before exec-ing the binary. The agent sees only its version-specific config — no bleed between versions.

See [01-version-management.md](01-version-management.md) for install and switching details, and [02-resource-sync.md](02-resource-sync.md) for how resources are synced into version homes.

---

## Two application layers

agents-cli is two application-layer surfaces over one shared set of on-disk state.
**`apps/cli`** (the `agents` / `ag` CLI) is the framework: it owns the SQLite session
index, `sessions` / `teams` / `run` / `cloud`, the pid→id registry, the audit log,
and the SSH fan-out to peers. **`apps/factory`** (the Factory VS Code extension) is a
consumer: it spawns agent terminals and renders the Factory Floor, but for live state
it shells out to `agents sessions --active --json` and reshapes the JSON — it holds no
data models of its own. Fix a mechanism in the CLI and every consumer benefits. Full
detail in [architecture.md](architecture.md).

## Two kinds of "session"

"Session" names two unrelated things. A **transcript** is the conversation on disk,
indexed in `sessions.db` and read by `agents sessions` (see [05-sessions.md](05-sessions.md)).
A **live identity** is which running pid is which session right now, held in per-pid
cache files and read by `--active` and the extension. The transcript is durable; the
identity is ephemeral. [architecture.md](architecture.md) covers both, including the
two `pid → id` writers (the CLI's registry vs the SessionStart hook).

---

## Devices & Hosts

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

**Hosts** — machines you dispatch agent work to. `agents hosts add` enrolls a
target either from an existing `~/.ssh/config` stanza (connection details stay in
ssh config; agents-cli stores only a caps/os overlay) or *inline* (with its own
`user@address`). The host registry lives in `agents.yaml` under `hosts:` and **is**
git-synced with `agents repo push`/`pull`, so a fleet definition travels between
machines. The `-H, --host <name>` (alias `--device`) flag routes a command over
SSH to that machine — supported on virtually every first-class group (`repos`,
`view`, `inspect`, `usage`, `cost`, `doctor`, `list`, `sync`, `plugins`, `skills`,
`status`, `teams`, `routines`, …), plus commands with their own richer host
handling (`run`, `sessions`, `feed`, `computer`, `secrets`, `logs`). Groups with
no remote semantics reject the flag with a clear message rather than commander's
raw `unknown option`. The target may be a registered host name, a capability tag
(`--host gpu --any`), a raw `user@host`, or the special value `auto`
(`--device auto` / `--host auto`) to affinity-pick a host from 14-day session
usage on `sessions.db` (weighted sample among online devices). Harness is always
the agent you type — never auto-picked. Affinity failure degrades to local.

The two registries feed **one host pool** behind the `HostProvider` seam:
`local` (agents.yaml overlay ∪ ssh-config) registers first, `devices` (the
Tailscale registry) second, so an enrolled host shadows a same-name device.
A device registered once with `agents devices sync` therefore shows up in
`agents hosts list` (SOURCE `devices`), resolves as a `--host` target, and
participates in capability routing — password-auth devices are listed but
marked non-dispatchable (offload rides `BatchMode=yes` ssh). To tag a device
with capabilities, `agents hosts add <device> --cap gpu` enrolls it inline,
sourcing the address from its device profile. `agents devices render --write`
still bridges to plain `ssh`/`scp` via ssh_config.

Hosts are execution targets everywhere runs and tasks dispatch: `agents run
--host`, `agents teams` placement, `agents cloud run --host <name>` (the `host`
cloud provider — tasks visible in both `agents cloud ps` and `agents hosts
ps`), and routines placement (`agents routines add … --run-on <name>`). See
[hosts.md](hosts.md) for the `--host` execution model and the option-forwarding
contract.

---

## Capability matrix

`src/lib/agents.ts` is the canonical capability matrix for resource sync. Every gateable resource kind is declared per agent so prompt, sync, and staleness code can share the same source of truth.

| Agent | Hooks | MCP | Permissions | Skills | Commands | Plugins | Subagents | Rules | Workflows |
|------|-------|-----|-------------|--------|----------|---------|-----------|-------|-----------|
| Claude | yes | yes | yes | yes | yes | yes | yes | `CLAUDE.md` | yes |
| Codex | >= 0.116.0 | yes | >= 0.138.0 | yes | < 0.117.0 · skills ($name, >= 0.117) | >= 0.128.0 | >= 0.117.0 | `AGENTS.md` | no |
| Cursor | no | yes | no | yes | yes | no | no | `.cursorrules` | no |
| OpenCode | no | yes | >= 1.1.1 | yes | yes | no | no | `AGENTS.md` | no |
| OpenClaw | yes | yes | yes | yes | gateway | yes | yes | `workspace/AGENTS.md` | no |
| Copilot | no | yes | no | yes | yes | no | no | `AGENTS.md` | no |
| Amp | no | yes | no | yes | yes | no | no | `AGENTS.md` | no |
| Kiro | no | yes | >= 2.8.0 | yes | yes | no | >= 1.23.0 | `AGENTS.md` | no |
| Goose | >= 1.34.0 | yes | yes | >= 1.25.0 | yes | yes | yes | `AGENTS.md` | yes |
| Roo Code | no | yes | no | yes | yes | no | no | `AGENTS.md` | no |
| Antigravity | yes | yes | yes | yes | yes | yes | >= 1.0.16 | `AGENTS.md` | >= 1.0.6 |
| Grok | yes | yes | yes | yes | skills ($name) | yes | no | `AGENTS.md` | >= 0.2.111 |
| Kimi | yes | yes | yes | yes | no | yes | yes | `AGENTS.md` | yes |
| Droid | yes | yes | >= 0.57.5 | >= 0.26.0 | yes | yes | yes | `AGENTS.md` | no |
| Hermes | no | yes | yes | yes | no | yes | no | `MEMORY.md` | no |

**Gemini is hard-deprecated.** Google retired the Gemini CLI for free/Pro/Ultra
tiers on June 18, 2026 (announced at Google I/O 2026); Antigravity CLI
(`antigravity`) is the successor. agents-cli keeps the legacy `gemini` id only
for old sessions/config, and blocks `agents add gemini`, `agents import gemini`,
and `agents sync gemini`.

Permissions sync is gated on the `allowlist` capability (Claude, Codex >= 0.138.0, Cursor, OpenCode >= 1.1.1, Antigravity, Grok, Kimi, Kiro 2.8.0+, Goose, Droid >= 0.57.5, OpenClaw, Copilot, and Hermes). Workflow sync writes Claude workflow bundles, Kimi `type: flow` skills with an `agents_workflow` ownership marker, Goose recipe YAML, Antigravity workflow markdown (since 1.0.6), and OpenClaw Lobster `.lobster` files under `.openclaw/workflows/` with an `AGENTS_CLI_WORKFLOW` ownership marker. Antigravity workflows are the one non-version-isolated target: `agy` scans a single shared `~/.gemini/config/global_workflows/` at startup (a real HOME directory, never symlinked per version), so agents-cli writes there once for all installed antigravity versions and reads it back the same way — the `agents_workflow` marker guards user-authored files from being overwritten or removed. **Host CLIs** (`agents cli`) are agent-agnostic PATH binaries — not in this matrix. Install paths call `supports(agent, cap, version)` before writing; gated capabilities skip with a clear reason instead of silently ignored config.

OpenClaw gates at tool granularity only, so permission sync maps just **blanket** (whole-tool) rules to `~/.openclaw/openclaw.json` `tools.alsoAllow` (allow) / `tools.deny` (deny): `bash → exec`, `read → read`, `write`/`edit → write`, `webfetch → web_fetch`, `websearch → web_search`. Sub-command/path/domain rules (`Bash(git:*)`, `Write(secrets/**)`, `WebFetch(domain:x)`) have no tool-level equivalent and are skipped. The absolute `tools.allow` list is never touched.

Hermes permission sync maps canonical Bash allow rules to `~/.hermes/config.yaml` `command_allowlist` and Bash deny rules to `approvals.deny`. Hermes stores command globs only; session-scoped `/tools` toggles are not config-persistent and are not written.

### Per-command targeting

Slash commands in `commands/*.md` can narrow sync with optional YAML frontmatter:

```yaml
---
description: Required one-line summary
agents: [claude, cursor, codex]   # omit = all command-capable agents
since: "0.116.0"                  # minimum agent CLI version (inclusive)
until: "0.117.0"                  # exclusive upper bound
---
```

`commandAppliesTo()` in `src/lib/commands.ts` evaluates these fields after the agent-level `commands` / commands-as-skills gate. The check runs on central sync (`~/.agents/commands/` user/system → version home) and on `agents commands install`; project `.agents/commands/` files are discovered in place and are not filtered by `agents:`.

Example: `.agents/commands/version.md` targets Claude, Codex, Cursor, OpenCode, Copilot, and Grok; Antigravity is excluded until harness support is verified.
