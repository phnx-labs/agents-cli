# Workflows

Named multi-agent pipeline bundles that agents-cli resolves and dispatches via `agents run`.

## Overview

A workflow is a directory containing a `WORKFLOW.md` file with YAML frontmatter and an orchestrator system prompt. Optionally, the directory includes `subagents/`, `skills/`, and `plugins/` subdirectories composed at runtime. Workflows are stored in `~/.agents/workflows/` (user) or `.agents/workflows/` (project) and synced to agent version homes. Currently only Claude is workflow-capable (`capableAgents('workflows')` in `src/lib/agents.ts` — today that list is just `claude`).

Run a workflow with `agents run <workflow-name> [prompt]`. The workflow name replaces the agent argument in the normal `agents run` invocation. The frontmatter controls which model is used, which tools are available, which MCP servers are connected, and which secrets are injected. If the workflow writes files or posts comments, pass `--mode edit` or `--mode full` — the default `--mode plan` will deadlock at `ExitPlanMode`.

For the layered resolution model that governs `project > user > system` precedence, see [02-resource-sync.md](02-resource-sync.md).

## Architecture

```
Source locations (project > user > system):
  .agents/workflows/<name>/            Project-scoped (repo-local)
  ~/.agents/workflows/<name>/          User-scoped (global)
  ~/.agents-system/workflows/<name>/   System-shipped defaults

  Each workflow directory:
    WORKFLOW.md          Required: frontmatter + orchestrator system prompt
    subagents/*.md       Optional: agent definitions the orchestrator can spawn
    skills/              Optional: knowledge packs scoped to this workflow
    plugins/             Optional: plugin bundles scoped to this workflow

                                   agents workflows add / agents use
                                             │
                                             ▼
  <version-home>/
    workflows/<name>/                Copy of source directory
      WORKFLOW.md
      subagents/*.md
      skills/
      plugins/

                                   agents run <workflow-name>
                                             │
                                             ▼
  Claude reads WORKFLOW.md system prompt, spawns subagents as needed,
  uses declared tools, connects declared MCP servers, injects secrets.
```

## Command Reference

| Command | Description |
|---------|-------------|
| `agents workflows list [agent]` | Table of installed workflows with sync status across versions |
| `agents workflows view [name]` | Frontmatter details: model, tools, MCP, subagents, secrets |
| `agents workflows add [source]` | Install from GitHub (`gh:user/repo`), local path, or pick from central storage |
| `agents workflows remove [name]` | Remove from version homes (run again to remove from central storage) |

### Options

| Command | Flag | Effect |
|---------|------|--------|
| `list` | `-a, --agent <agent>` | Filter display to one agent (supports `agent@version` syntax) |
| `add` | `-a, --agents <list>` | Target specific agents/versions: `claude`, `claude@2.1.138` |
| `add` | `-y, --yes` | Skip all confirmation prompts |

## WORKFLOW.md Schema

The `WORKFLOW.md` file begins with a YAML frontmatter block followed by the orchestrator system prompt. The frontmatter maps to `WorkflowFrontmatter` in `src/lib/workflows.ts:26`.

```markdown
---
name: Code Review
description: Evidence-grounded review of a PR, branch, or pending changes.
model: claude-opus-4-7
tools:
  - Read
  - Grep
  - Glob
  - Bash
  - WebFetch
mcpServers:
  - github
  - linear
skills:
  - code-review-conventions
allowedAgents:
  - security-reviewer
  - test-writer
secrets:
  - github.com
  - linear.app
---

You are Code Reviewer for this repo. Your job: produce an evidence-grounded
review of pending changes...
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name shown in `agents workflows view` |
| `description` | string | One-line description shown in `agents workflows list` |
| `model` | string | Model identifier used by the orchestrator agent |
| `tools` | `string[]` | Available-tool restriction — enforced at run time (Claude) via `--tools`. Declaring `tools: [Read, Grep]` makes only those tools available; `Write`, `Bash`, and `Edit` are unavailable for the whole run |
| `mcpServers` | `string[]` | MCP server names to connect at run time — enforced (Claude) via an ephemeral `--mcp-config` **plus** `--strict-mcp-config`, so only the named servers load. Names not in the registry are skipped with a warning. **Fail-closed:** declaring `mcpServers` with no installed match scopes the run to NO MCP servers — never the user's full ambient set |
| `skills` | `string[]` | Skills to load into context |
| `allowedAgents` | `string[]` | Subagent names the orchestrator can dispatch to (from `subagents/` dir) — enforced (Claude) by copying only the listed subagent definition files into the run, so unlisted subagents have no definition to dispatch. **Fail-closed:** omitting the field copies all subagents; `allowedAgents: []` (explicit empty) copies NONE |
| `secrets` | `string[]` | Secrets bundle names injected from macOS Keychain at run time; pass `--no-auto-secrets` to skip |

### Scoping & security

`tools`, `mcpServers`, and `allowedAgents` are not just documentation — they scope the actual run on Claude. `tools: [Read, Grep]` produces `--tools Read Grep`, which restricts the *available* built-in tool set — `Write`, `Bash`, and `Edit` are not present in the session — so a review workflow declared read-only really is read-only. (`--allowedTools` is also emitted for the same set so the permitted tools don't prompt in headless runs.) `mcpServers` translates to an ephemeral `--mcp-config` JSON built from the MCP registry, emitted together with `--strict-mcp-config`, so *only* the named servers are connected. These boundaries are **fail-closed**: declaring `mcpServers` whose names resolve to *zero* installed servers still writes a locked-down empty config (`{ "mcpServers": {} }`) and emits `--strict-mcp-config`, so the run gets **no MCP servers** — never the user's full ambient set. `allowedAgents` is enforced by copying only the listed subagent definition files into the run directory: a subagent whose `.md` definition isn't present cannot be dispatched. An explicit `allowedAgents: []` copies **no** subagents (allow none); omitting the field entirely copies all of them. (Note: subagents copied by a prior run of a different, unrestricted workflow can remain in the shared agents dir; for a hard guarantee, scope per version home.)

On an agent that lacks the tool-allowlist capability (`allowlist` in `src/lib/agents.ts`), a workflow that declares any of these fields runs *unscoped* and emits a `declared but unenforceable on <agent>` warning rather than silently dropping the boundary.

## Recipes

**1. List available workflows**

```bash
agents workflows list
agents workflows list claude
agents workflows list claude@2.1.138
```

**2. View a workflow's details before running**

```bash
agents workflows view code-review
```

**3. Install from GitHub**

```bash
agents workflows add gh:user/workflows
agents workflows add gh:user/workflows --agents claude@2.1.138
```

**4. Install a local workflow directory**

```bash
agents workflows add ./code-review
# The directory must contain WORKFLOW.md
```

**5. Run a workflow**

```bash
# Read-only (default — plan mode):
agents run code-review "review PR #42"

# With file writes or API calls (edit mode):
agents run code-review --mode full "review PR #42 and post the review comment"
```

**6. Remove a workflow**

```bash
# First call: removes from version homes; central source preserved.
agents workflows remove code-review

# Second call (or call with name directly): removes from central storage.
agents workflows remove code-review
```

## Demo

<video autoplay loop muted playsinline width="100%" src="../assets/videos/workflows.mp4"></video>

## See Also

- [02-resource-sync.md](02-resource-sync.md) — layered resolution: project workflows override user workflows override system
- [docs/subagents.md](subagents.md) — subagent definitions that workflows orchestrate
- [docs/plugins.md](plugins.md) — plugin bundles that workflows can include
- [docs/hooks.md](hooks.md) — hooks that fire on workflow lifecycle events
