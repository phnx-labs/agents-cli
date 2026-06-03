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
| **System repo** | `~/.agents-system/` | agents-cli maintainers | Core resources and defaults shipped with every install. Updated via `npm update -g agents-cli`. |
| **User repo** | `~/.agents/` | You | Your personal additions and overrides. Synced with `agents repo push` / `agents repo pull`. |

A project can also have a local repo — drop a `.agents/` directory at the project root. Its resources apply only while you're inside that project tree.

Extra repos can be registered via `agents repo add <source>`. They clone into `~/.agents-system/.repos/<alias>/` and participate in resolution after the user repo.

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

---

## Layered resolution

When agents-cli resolves a resource it searches four layers in order and stops at the first match:

```
project (.agents/ at project root)
  └─ user (~/.agents/)
       └─ extra repos (~/.agents-system/.repos/<alias>/)
            └─ system (~/.agents-system/)
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

Each installed agent CLI version gets an isolated **version home** — a directory under `~/.agents-system/versions/<agent>/<version>/home/` that contains a complete config environment for that version. Syncing copies (or symlinks) the resolved resource set into the version home in the format each agent expects.

When you run `claude` (via the shim), agents-cli reads `agents.yaml`, resolves the version, and sets `HOME` to the matching version home before exec-ing the binary. The agent sees only its version-specific config — no bleed between versions.

See [01-version-management.md](01-version-management.md) for install and switching details, and [02-resource-sync.md](02-resource-sync.md) for how resources are synced into version homes.
