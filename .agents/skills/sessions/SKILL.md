---
name: sessions
description: "Search, browse, and read agent conversation transcripts across Codex, Codex, Gemini, and OpenCode. Use this skill to find previous sessions, recover context, or inspect what agents have done."
argument-hint: "[search query or session ID]"
allowed-tools: Bash(agents sessions*)
user-invocable: true
---

# Sessions Skill

Search and browse agent conversation transcripts. This skill teaches you how to use the `agents sessions` CLI effectively.

## Basic Usage

```bash
# Interactive picker: browse and search recent sessions
agents sessions

# List sessions from current project
agents sessions | head -20

# Search sessions by text
agents sessions "add auth middleware"

# Filter by project across all directories
agents sessions --project agents-cli --all
```

## Filters

| Filter | Example | Description |
|--------|---------|-------------|
| `--agent` | `--agent Codex` | Filter by agent type |
| `--all` | `--all` | Include sessions from every directory |
| `--project` | `--project myapp` | Filter by project name |
| `--since` | `--since 2h` | Only sessions newer than this |
| `--until` | `--until 2026-01-01` | Only sessions older than this |
| `--limit` | `--limit 10` | Maximum sessions to return |
| `--active` | `--active` | Only currently running sessions |
| `--teams` | `--teams` | Include team-spawned sessions |

## Reading Sessions

```bash
# Render session as markdown
agents sessions --markdown <session-id>

# Output as JSON
agents sessions --json <session-id>

# Include only specific roles
agents sessions --markdown --include user,assistant <session-id>

# Show only first/last N turns
agents sessions --markdown --last 10 <session-id>
```

## Artifacts

```bash
# List all files written or edited during a session
agents sessions --artifacts <session-id>

# Read a specific artifact
agents sessions --artifact <filename> <session-id>
```

## Live Tailing

```bash
# Live-tail a session file (Codex and Codex only)
agents sessions tail <session-id>
# Press Ctrl+C to stop
```

## Tips

- Use `--active` to find sessions running right now across terminals, teams, cloud, and headless agents
- Use `--teams` to see what team-spawned agents are doing
- Use `--since 1h` for recent activity
- Combine filters: `agents sessions --project myapp --since 1d --agent Codex`
