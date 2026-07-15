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
| **User repo** | `~/.agents/` | You | Your personal additions and overrides. Synced with `agents repo push` / `agents repo pull`. To git-back a fresh/Windows machine whose `~/.agents` isn't a clone yet, run `agents repo pull user <git-url>` once — it adopts the existing directory in place. |

A project can also have a local repo — drop a `.agents/` directory at the project root. Its resources apply only while you're inside that project tree.

Extra repos can be registered via `agents repo add <source>`. They clone into `~/.agents-<alias>/` (peer of `~/.agents/`) and participate in resolution after the user repo.

---

## Resources

A **resource** is any named item inside a DotAgents repo. Resources are typed by which subdirectory they live in — that type is called the **resource kind**.

| Kind | What it is | Agent format |
|------|-----------|--------------|
| `commands` | Slash commands and prompt shortcuts | `.md` (most agents), `.toml` (Gemini) |
| `skills` | Knowledge packs injected into the agent's context | Directory with `SKILL.md` |
| `hooks` | Shell scripts that fire on agent lifecycle events | `.sh` scripts + `hooks.yaml` manifest |
| `rules` | Persistent memory / instructions for the agent | `AGENTS.md` → `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, … |
| `mcp` | MCP server definitions (transport, command, args, env) | Merged into each agent's settings file |
| `permissions` | Allow/deny tool permission groups | Converted to each agent's native format |
| `profiles` | Model + endpoint + auth bundles | YAML, consumed by `agents run` and shims |
| `subagents` | Subagent workflow definitions | `.md` files |

Resources are installed once in `~/.agents/` and synced to every supported agent's native format automatically. Sync happens when you run `agents use`, `agents repo pull`, or explicitly via `agents sync`.

To inspect what's installed, use the per-kind listers — `agents commands list`, `agents skills list`, `agents hooks list`, `agents mcp list`, `agents permissions list`, `agents subagents list`, `agents profiles list`. There is no single `agents resources` viewer that prints a merged cross-kind table today; if you want one, file an issue.

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
machines. The `-H, --host <name>` flag routes a command over SSH to that machine —
supported today on the read-only/config commands (`view`, `inspect`, `usage`,
`cost`, `doctor`, `list`, `sync`), on `agents run`, and across the `agents teams`
lifecycle. The target may be a registered host name, a capability tag
(`--host gpu --any`), or a raw `user@host`.

The two systems are parallel and independent — a machine can appear in both.
Devices auto-populate from Tailscale and back the interactive `agents ssh`; hosts
are enrolled deliberately and back `--host` dispatch. `agents devices render --write`
bridges them one way (device → ssh_config → enrollable as a host). See
[hosts.md](hosts.md) for the `--host` execution model.

---

## Capability matrix

`src/lib/agents.ts` is the canonical capability matrix for resource sync. Every gateable resource kind is declared per agent so prompt, sync, and staleness code can share the same source of truth.

| Agent | Hooks | MCP | Permissions | Skills | Commands | Plugins | Subagents | Rules | Workflows |
|------|-------|-----|-------------|--------|----------|---------|-----------|-------|-----------|
| Claude | yes | yes | yes | yes | yes | yes | yes | `CLAUDE.md` | yes |
| Codex | >= 0.116.0 | yes | >= 0.138.0 | yes | < 0.117.0 · skills ($name, >= 0.117) | >= 0.128.0 | >= 0.117.0 | `AGENTS.md` | no |
| Gemini † | >= 0.26.0 | yes | yes | yes | yes (.toml) | >= 0.8.0 | >= 0.36.0 | `GEMINI.md` | no |
| Cursor | no | yes | no | yes | yes | no | no | `.cursorrules` | no |
| OpenCode | no | yes | >= 1.1.1 | yes | yes | no | no | `AGENTS.md` | no |
| OpenClaw | yes | yes | yes | yes | gateway | yes | yes | `workspace/AGENTS.md` | no |
| Copilot | no | yes | no | yes | yes | no | no | `AGENTS.md` | no |
| Amp | no | yes | no | yes | yes | no | no | `AGENTS.md` | no |
| Kiro | no | yes | >= 2.8.0 | yes | yes | no | >= 1.23.0 | `AGENTS.md` | no |
| Goose | >= 1.34.0 | yes | yes | >= 1.25.0 | yes | yes | yes | `AGENTS.md` | yes |
| Roo Code | no | yes | no | yes | yes | no | no | `AGENTS.md` | no |
| Antigravity | yes | yes | yes | yes | yes | yes | >= 1.0.16 | `AGENTS.md` | >= 1.0.6 |
| Grok | yes | yes | yes | yes | skills ($name) | yes | no | `AGENTS.md` | no |
| Kimi | yes | yes | yes | yes | no | yes | yes | `AGENTS.md` | yes |
| Droid | yes | yes | >= 0.57.5 | >= 0.26.0 | yes | yes | yes | `AGENTS.md` | no |
| Hermes | no | yes | no | yes | no | yes | no | `MEMORY.md` | no |
| ForgeCode | no | yes | no | yes | yes | no | yes | `AGENTS.md` | no |

**† Gemini is deprecated.** Google retired the Gemini CLI for free/Pro/Ultra tiers on June 18, 2026 (announced at Google I/O 2026); Antigravity CLI (`antigravity`) is the successor. agents-cli still manages existing Gemini installs but warns on `agents add gemini` / `agents teams add … gemini`.

Permissions sync is gated on the `allowlist` capability (Claude, Codex >= 0.138.0, Gemini, Cursor, OpenCode >= 1.1.1, Antigravity, Grok, Kimi, Kiro 2.8.0+, Goose, Droid >= 0.57.5, and OpenClaw). Workflow sync writes Claude workflow bundles, Kimi `type: flow` skills with an `agents_workflow` ownership marker, Goose recipe YAML, and Antigravity workflow markdown (since 1.0.6). Antigravity workflows are the one non-version-isolated target: `agy` scans a single shared `~/.gemini/config/global_workflows/` at startup (a real HOME directory, never symlinked per version), so agents-cli writes there once for all installed antigravity versions and reads it back the same way — the `agents_workflow` marker guards user-authored files from being overwritten or removed. **Host CLIs** (`agents cli`) are agent-agnostic PATH binaries — not in this matrix. Install paths call `supports(agent, cap, version)` before writing; gated capabilities skip with a clear reason instead of silently ignored config.

Gemini permission sync maps canonical Bash rules to its native `ShellTool(...)` entries under `tools.core` / `tools.exclude`. Other canonical permission tools are not representable in Gemini's native allowlist grammar and are skipped.

OpenClaw gates at tool granularity only, so permission sync maps just **blanket** (whole-tool) rules to `~/.openclaw/openclaw.json` `tools.alsoAllow` (allow) / `tools.deny` (deny): `bash → exec`, `read → read`, `write`/`edit → write`, `webfetch → web_fetch`, `websearch → web_search`. Sub-command/path/domain rules (`Bash(git:*)`, `Write(secrets/**)`, `WebFetch(domain:x)`) have no tool-level equivalent and are skipped. The absolute `tools.allow` list is never touched.

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

Example: `.agents/commands/version.md` targets Claude, Codex, Gemini, Cursor, OpenCode, Copilot, and Grok; Antigravity is excluded until harness support is verified.
