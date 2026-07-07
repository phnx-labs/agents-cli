# Subagents

Lightweight named agent definitions that parent agents can spawn for focused subtasks.

## Overview

A subagent is a directory in `~/.agents/subagents/<name>/` containing an `AGENT.md` file with YAML frontmatter and an instruction body. Parent agents with `subagents: true` in the capability matrix (today Claude and OpenClaw — see `capableAgents('subagents')` in `src/lib/agents.ts`) discover installed subagents and can spawn them using their native task-dispatch mechanism (e.g., Claude's `Task()` tool). Each subagent definition specifies a model, a display color, and a focused instruction set. The resource resolution order is `project > user > system`, matching every other resource kind.

Subagents are one of three patterns for specialization. Plugins can bundle subagent definitions alongside skills and hooks. Workflows declare `allowedAgents` in their frontmatter to constrain which subagents the orchestrator can reach. In all cases the on-disk format is the same `AGENT.md` file.

For the sync model that governs how subagents reach version homes, see [02-resource-sync.md](02-resource-sync.md).

## Architecture

```
Central storage (project > user > system):
  ~/.agents/subagents/<name>/          User-scoped
  .agents/subagents/<name>/            Project-scoped
  ~/.agents-system/subagents/<name>/   System-shipped

  <name>/
    AGENT.md                           Required: frontmatter + instruction body

                      agents subagents add / agents use
                                  │
                                  ▼
  <version-home>/
    .claude/
      agents/<name>.md               Claude native format (copied + converted)
    .openclaw/
      agents/<name>.yaml             OpenClaw YAML format

                      Parent agent session (Claude example)
                                  │
                                  ▼
  Parent reads .claude/agents/*.md catalog
  Spawns subagent via Task() with subagent's model + instructions
  Subagent executes with its own focused instruction set
```

## Command Reference

| Command | Description |
|---------|-------------|
| `agents subagents list` | Table of all installed subagents with sync status across agent versions |
| `agents subagents view [name]` | Details for one subagent: model, color, file list, sync status |
| `agents subagents add <source>` | Install from GitHub (`gh:user/repo`) or local path, sync to agent versions |
| `agents subagents remove [name]` | Delete from central storage and unsync from all agent versions |

### Options

| Command | Flag | Effect |
|---------|------|--------|
| `add` | `-a, --agents <agents...>` | Target specific agents: `claude`, `openclaw` (defaults to all capable) |
| `add` | `-y, --yes` | Skip all prompts and confirmation |
| `remove` | `-y, --yes` | Skip confirmation prompt |

## AGENT.md Schema

The `AGENT.md` file uses YAML frontmatter followed by the instruction body. The frontmatter maps to `SubagentFrontmatter` in `src/lib/types.ts:416`.

```markdown
---
name: code-reviewer
description: Reads changed files and surfaces bugs, missing tests, and scope creep.
model: claude-opus-4-7
color: cyan
---

You are a focused code reviewer. Your job is to read the diff and the full
context of every changed file, then produce a structured review with:

- Critical: bugs, regressions, security issues (cite file:line)
- Concerns: scope creep, missing tests, architectural drift
- Verdict: Approve / Request changes / Comment

Do not modify any files. Do not commit. Read only.
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Canonical name; must match the directory name |
| `description` | string | yes | One-line shown in `agents subagents list` |
| `model` | string | no | Model to use when the subagent is spawned (e.g. `claude-opus-4-7`) |
| `color` | string | no | Terminal display color for the subagent badge |

Additional `.md` files in the same directory (e.g., `TOOLS.md`, `MEMORY.md`) are collected as supplementary context. All `.md` files in the directory are counted in the `files` field of `InstalledSubagent`.

## Recipes

**1. List installed subagents**

```bash
agents subagents list
```

**2. View details for one subagent**

```bash
agents subagents view code-reviewer
```

**3. Install from GitHub**

```bash
agents subagents add gh:team/subagents --agents claude,openclaw
```

**4. Install from a local directory**

The source must contain `subagents/*/AGENT.md` entries.

```bash
agents subagents add ~/my-subagents --agents claude
agents subagents add ~/my-subagents --yes
```

**5. Remove a subagent**

```bash
agents subagents remove code-reviewer
agents subagents remove code-reviewer --yes
```

## Demo

<video autoplay loop muted playsinline width="100%" src="../assets/videos/subagents.mp4"></video>

## See Also

- [02-resource-sync.md](02-resource-sync.md) — resource resolution and sync to version homes
- [docs/workflows.md](workflows.md) — workflows that declare `allowedAgents` to orchestrate subagents
- [docs/plugins.md](plugins.md) — plugins that bundle subagent definitions alongside skills and hooks
- [docs/hooks.md](hooks.md) — hooks that fire on subagent lifecycle events
