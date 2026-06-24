---
name: teams
description: "Organize AI coding agents into teams that collaborate on a shared task. Create teams, add teammates, start them, monitor progress, and collect results. Use this skill when you need parallel agent execution. For single-agent dispatch, use `agents run` instead."
argument-hint: "[create|add|start|status|disband]"
allowed-tools: Bash(agents teams*), Bash(agents run*)
user-invocable: true
---

# Teams Skill

Organize AI coding agents into teams for parallel collaboration. This skill teaches you how to use the `agents teams` CLI.

## Single Agent vs Teams

- **Single agent**: Use `agents run <agent> "prompt" --mode edit` for one-off tasks
- **Multiple agents**: Use `agents teams` when you need parallel execution

## Quick Start

```bash
# Create a team
agents teams create my-feature

# Add teammates
agents teams add my-feature claude "Implement the auth middleware" --name auth
agents teams add my-feature codex "Build the login UI" --name frontend

# Start the team
agents teams start my-feature --watch
```

## Commands

| Command | Description | Example |
|---------|-------------|---------|
| `create` | Start a new team | `agents teams create my-team` |
| `add` | Add a teammate | `agents teams add my-team claude "Task" --name role` |
| `start` | Launch pending teammates | `agents teams start my-team --watch` |
| `status` | Check who's working | `agents teams status my-team` |
| `logs` | Read teammate output | `agents teams logs my-team frontend` |
| `remove` | Remove a teammate | `agents teams remove my-team frontend` |
| `disband` | Stop all and remove | `agents teams disband my-team` |
| `doctor` | Check installed agents | `agents teams doctor` |

## DAG Dependencies

Use `--after` to create dependencies:

```bash
# Backend first
agents teams add my-feature claude "Build API" --name backend

# Frontend waits for backend
agents teams add my-feature codex "Build UI" --name frontend --after backend

# QA waits for both
agents teams add my-feature claude "Run tests" --name qa --after backend,frontend

# Start drains the DAG automatically
agents teams start my-feature --watch
```

## Modes

| Mode | Use When |
|------|----------|
| `plan` (default) | Read-only work: research, audit, analysis |
| `edit` | Code changes: implementation, refactoring |

Always use `--mode plan` for security audits, research, and analysis.

## Monitoring

```bash
# Check status
agents teams status my-feature

# Delta poll (efficient)
agents teams status my-feature --since 2026-04-24T09:00:00-07:00

# Read one teammate's log
agents teams logs my-feature frontend
```

## Best Practices

- **Mix agents** if available — different agents have different blind spots
- **Use `--mode plan`** for read-only work (audits, research)
- **Give full context** — each teammate needs the big picture plus their specific task
- **Demand evidence** — end prompts with: `Return file:line quotes for every claim`
- **Run in parallel** — most tasks don't depend on each other
- **Name teammates** with `--name` for easy reference

## Budget Guardrails

Teammates **inherit the project's budget caps** from `agents.yaml` (see
[docs/06-observability.md](../../docs/06-observability.md#budget-guardrails-agents-budget)).
Before each teammate launches, its estimated cost is projected onto current
spend; under `on_exceed: block`, a teammate that would breach a cap is
**refused** (the spawn fails with `[budget] BLOCKED teammate …`). Caps are
**cross-vendor**: a Claude teammate and a Codex teammate draw down the *same*
`per_project` / `per_day` pool — one budget governs the whole team.

Teammate budgeting is **pre-flight only** in v1 — a teammate is estimated and
blocked *before* it spawns, but there is **no live mid-run hard-cap kill** for
teammates (that applies to local headless `agents run` today; teams is a planned
follow-up).

```yaml
# project agents.yaml
budget:
  per_project: 100.00   # shared by every teammate, regardless of agent
  on_exceed: block
```

Check spend-to-cap any time with `agents budget`.

## Short Aliases

```
teams c  = create    teams a  = add       teams s  = status
teams rm = remove    teams d  = disband   teams ls = list
```
