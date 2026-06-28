# Sessions

Unified discovery, search, and rendering of agent conversation transcripts across
Claude, Codex, Gemini, OpenCode, and OpenClaw.

## Architecture

```
~/.agents/
  sessions/
    sessions.db                 # SQLite + FTS5 index
    sessions.db-wal             # Write-ahead log (WAL mode)

Per-agent on-disk session files (not owned by agents-cli, read-only):
~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl     # Claude
~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl        # Codex
~/.gemini/tmp/<project>/chats/session-*.json              # Gemini
~/.local/share/opencode/project/*/storage/session/...     # OpenCode
~/Library/Application Support/OpenClaw/sessions/*.json    # OpenClaw
```

## Discovery Flow

```
agents sessions [query] [--json] [--since 1h] [--all]
           │
           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  1. Open ~/.agents/.history/sessions/sessions.db (cached connection)       │
│                                                                     │
│  2. Parallel incremental scan per agent:                            │
│     For each on-disk session file:                                  │
│       stat() -> (mtime, size)                                       │
│       If unchanged since last scan -> skip (DB row is fresh)        │
│       Else -> parse file, upsert sessions row + FTS5 content row    │
│                                                                     │
│  3. SQL query with filters (agent, cwd, since, project, limit)      │
│     FTS5 search if [query] given, BM25 ranked                       │
│                                                                     │
│  4. Emit JSON (--json) or render interactively                      │
└─────────────────────────────────────────────────────────────────────┘
```

Cold run re-parses everything. Warm run is mostly DB-only with a stat() per file;
active sessions get refreshed each call because their mtime keeps advancing.

## SessionMeta (list output)

`agents sessions --json` returns an array of `SessionMeta`:

```json
{
  "id": "c07ec355-d841-45fc-b2eb-f500355e15c6",
  "shortId": "c07ec355",
  "agent": "claude",
  "version": "2.1.112",
  "account": "you@example.com",
  "timestamp": "2026-04-22T13:37:14.047Z",
  "project": "agents",
  "cwd": "/Users/you/src/github.com/phnx-labs/agents",
  "gitBranch": "main",
  "topic": "We integrated gpt-image-2 with quality-tiered pricing. Check the image-studio agent",
  "label": null,
  "messageCount": 9,
  "tokenCount": 537397,
  "costUsd": 2.81,
  "durationMs": 742000,
  "isTeamOrigin": false,
  "filePath": "/Users/you/.claude/projects/-Users-.../c07ec355-....jsonl"
}
```

Fields:

| Field | Source | Notes |
|---|---|---|
| `id` | Agent-native UUID | Primary key; stable across reloads |
| `shortId` | First 8 chars of `id` | For human matching in CLI output |
| `agent` | One of 5 formats | See SessionAgentId union |
| `timestamp` | Session start | ISO 8601 |
| `project` | Derived from `cwd` | Basename of the working directory |
| `cwd` | Recorded at spawn | Normalized absolute path |
| `gitBranch` | Recorded at spawn | `null` outside a repo |
| `topic` | First user prompt (truncated) | Best headline for a session |
| `label` | User-set name | Claude's `/rename` command only |
| `tokenCount` | Parsed from usage events | `null` for agents that don't log it |
| `costUsd` | Σ tokens × per-model price, at scan time | `null` when the model is unknown/unpriced; see `agents cost` |
| `durationMs` | `lastTs − firstTs` over timestamped events | `null` for single-event sessions |
| `isTeamOrigin` | Set when spawned by `agents teams` | JSONL `entrypoint: 'sdk-cli'` |

## SessionEvent (detail output)

`agents sessions <id> --json` returns the normalized event array:

```json
[
  { "type": "message", "role": "user", "timestamp": "...", "content": "..." },
  { "type": "tool_use", "timestamp": "...", "tool": "Edit", "args": {...}, "path": "/repo/src/a.ts" },
  { "type": "tool_result", "timestamp": "...", "tool": "Edit", "success": true },
  { "type": "usage", "timestamp": "...", "model": "claude-opus-4-7", "inputTokens": 6, "outputTokens": 364 },
  { "type": "thinking", "timestamp": "...", "content": "..." },
  { "type": "message", "role": "assistant", "timestamp": "...", "content": "..." }
]
```

The event types are an agent-agnostic union:

| Type | Fields | Present for |
|---|---|---|
| `message` | `role`, `content` | All agents |
| `tool_use` | `tool`, `args`, `path`, `command` | All agents |
| `tool_result` | `tool`, `success`, `output` | All agents |
| `thinking` | `content` | Claude, Codex (reasoning traces) |
| `usage` | `model`, `inputTokens`, `outputTokens`, `cacheReadTokens` | Claude, Codex |
| `attachment` | `mediaType`, `sizeBytes` | Claude (images, files) |
| `init` | - | Session boot event |
| `result` | - | Session completion event |
| `error` | - | Recoverable parse errors |

## Query Flags

```bash
# Current project, last 50 sessions
agents sessions

# All projects, last 20 from the past hour
agents sessions --json --all --since 1h --limit 20

# Filter by agent (and optional version)
agents sessions --agent claude
agents sessions --agent codex@0.116.0

# FTS5 search (BM25 ranked, labels weighted highest)
agents sessions "auth refactor"

# Include team-spawned sessions (hidden by default)
agents sessions --teams

# Sort the list by cost or duration (default: recent)
agents sessions --sort cost --limit 10
agents sessions --sort duration --all

# Replay one session as markdown
agents sessions c07ec355 --markdown

# Full normalized event array for one session
agents sessions c07ec355 --json --last 30

# Role filtering
agents sessions c07ec355 --json --include tools,assistant --last 20
```

## BM25 Column Weights

FTS5 ranks search hits across four columns with these weights:

```
label   5.0   # /rename'd sessions rank highest
topic   2.0   # first-prompt headline
project 1.5   # project name
content 1.0   # everything else
```

## Time Filters

`--since` and `--until` accept:

- Relative: `2h`, `7d`, `4w`, `30m`
- ISO date: `2026-04-22T00:00:00Z`
- Natural: `yesterday`, `today`

## Remote Sessions over SSH

Discovery is local-only — every path is rooted at `os.homedir()`, so a machine
sees only its own transcripts. `--host` runs the query on another machine instead:

```
# Search another machine's sessions live (no sync, always current)
agents sessions "auth bug" --last 3 --host yosemite-s1

# Fan the same query across several machines
agents sessions --all "deploy script" --host box-a --host box-b
```

It works by invoking the **remote's own** `agents sessions` against its already-built
index over SSH and streaming stdout back — `ssh -o BatchMode=yes <host> bash -lc
'agents sessions …'` (`src/lib/session/remote.ts`). Every other flag (`--since`,
`--json`, `--markdown`, query, even `tail` and `--active`) forwards verbatim, since
the far end runs the same binary. `--host` is stripped before forwarding so there is
no recursion; the target must be a host alias or `user@host` (validated against
`SSH_TARGET_RE` to block argv-flag smuggling). SSH access is the only auth — if you
can `ssh <host>`, you own the box; there is no identity layer.

This is the **live** counterpart to `agents sessions sync` (R2 + CRDT union, eventual
~90s): no upfront copy and always current, but the peer must be reachable. Use sync
to make every machine's sessions show up in plain `agents sessions`; use `--host` to
peek at a specific machine on demand.

## Schema Version

Schema version is currently `6`. Migrations run on connection open; old DBs
get upgraded in place. The `meta` table tracks `schema_version`. The `v5 → v6`
migration adds the `cost_usd` and `duration_ms` columns and forces a full
rescan so every existing session is re-priced.

## Related

- `agents sessions <id> --artifacts` — list files created/modified in a session
- `agents teams status` — session state for team-coordinated runs
- `agents cloud logs <id>` — for remote cloud dispatches (different subsystem)
