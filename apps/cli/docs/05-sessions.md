# Sessions

> This is the **reference / how-to**. For the normative contract — what
> `agents sessions` guarantees, as testable MUST/SHOULD requirements with
> Given/When/Then scenarios — see [`specifications.md` §Sessions](specifications.md#sessions).

Unified discovery, search, and rendering of agent conversation transcripts across
the session-discoverable harnesses — Claude, Codex, Gemini, Antigravity, OpenCode,
OpenClaw, Rush, Hermes, Grok, Kimi, Droid, and Cursor (the `SESSION_AGENTS` set in
`src/lib/session/types.ts`).

## Architecture

```
~/.agents/.history/
  sessions/
    sessions.db                 # SQLite + FTS5 index
    sessions.db-wal             # Write-ahead log (WAL mode)

Per-agent on-disk session files (not owned by agents-cli, read-only):
~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl     # Claude
~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl        # Codex
~/.gemini/tmp/<project>/chats/session-*.json              # Gemini
~/.local/share/opencode/project/*/storage/session/...     # OpenCode
~/Library/Application Support/OpenClaw/sessions/*.json    # OpenClaw
~/.cursor/projects/*/agent-transcripts/*/*.jsonl          # Cursor
~/.cursor/chats/<workspace-hash>/<uuid>/meta.json         # Cursor cwd/title/timestamps

Routine archives (owned by agents-cli, durable):
~/.agents/.history/runs/<routine>/<run-id>/sessions/<agent>/...
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
│     For each leaf transcript dir:                                   │
│       stat() the dir -> (mtime, entry_count)                        │
│       If it matches the dir_ledger -> no create/delete/rename;      │
│         skip the per-file stat, serve unchanged files from the DB   │
│         (only "hot" files are re-stat'd — see below)                │
│       Else -> readdir + stat each file:                             │
│         If unchanged since last scan -> skip (DB row is fresh)      │
│         Else -> parse file, upsert sessions row + FTS5 content row  │
│           (Claude/Codex/Kimi: resume from the saved byte offset &   │
│            parse only the appended lines when the file merely grew) │
│                                                                     │
│  3. SQL query with filters (agent, cwd, since, project, limit)      │
│     FTS5 search if [query] given, BM25 ranked                       │
│                                                                     │
│  4. Emit JSON (--json) or render interactively                      │
└─────────────────────────────────────────────────────────────────────┘
```

Cold run re-parses everything. Warm run is mostly DB-only; a directory whose
`(mtime, entry_count)` matches the `dir_ledger` is served entirely from the DB
without stat'ing its files, so the immutable version-home and backup roots — which
dominate a heavy user's tree — cost one dir stat each instead of hundreds of
per-file stats. Active sessions still refresh: a file is "hot" (always re-stat'd,
even in an unchanged dir) when it lives under the agent's live `~/.<agent>` root or
was scanned within the last 10 minutes, so an in-place append is never missed. A
create / delete / rename bumps the dir mtime and forces a full re-walk of that dir.
Set `AGENTS_SESSIONS_NO_DIR_LEDGER=1` to disable the short-circuit and force the old
full per-file walk.

Cursor is installed outside agents-cli's version homes. Once any managed agent
version exists, the default managed scope excludes Cursor transcripts; pass
`--unmanaged` (for example, `agents sessions --agent cursor --unmanaged`) to list
them. `--all` controls age filtering and does not replace `--unmanaged`.

When a **Claude**, **Codex**, or **Kimi** transcript that already has an index row
grows, the scan does not re-read it from the top. The `scan_ledger` stores a
resumable continuation (`parser_state` — a byte offset plus an accumulator snapshot,
plus `content_text`, the accumulated user doc, for Claude/Codex); the next scan
resumes from that offset and folds in only the newly-appended lines. (Kimi's
counters come from a sibling `agents/main/wire.jsonl`, so its continuation tracks
that file's offset + the three additive counter bases.) It falls back to a **full
reparse from byte 0** when the file has no prior continuation (cold start), shrank
at or below the saved offset (truncation / rewrite), or its mtime went backwards
(clock rewind / restore). For **Claude and Codex** it also re-derives the
transcript's first-event identity (the first user/assistant `timestamp` for Claude,
the `session_meta` id for Codex) from a bounded read of the file start and forces a
FULL parse when it no longer matches the prior continuation — an in-place rewrite or
restore that dropped a *different* session at the same path, which size + mtime alone
cannot tell from an append. (**Kimi** needs no such re-check: its session dir is
keyed by session UUID and `wire.jsonl` is append-only, so a given path can never
change identity.) Full and incremental parses run through the same reducer per
scanner, so the indexed row an append produces — token counts, cost, duration,
topic/title, and (Claude/Codex) PR + ticket refs + FTS content — is identical to a
from-scratch full reparse, even when a signal straddles two scans. Both incremental
paths apply only newline-terminated lines and defer a complete-but-unterminated
trailing record to the next pass, so a record written before its `'\n'` is flushed
is never double-counted. Grok is not incremental — it reads a whole `summary.json`,
not an append-only JSONL; Gemini and Cursor still full-parse each changed file.

## Tool-call search

`--include tools` has two related forms:

```bash
# Render every tool event from one exact session
agents sessions a1b2c3d4 --include tools

# Query cached call evidence across sessions on one device
agents sessions --include tools --agent codex --device mac-mini --since 7d

# Repeated clauses must match distinct calls in the same session
agents sessions --include tools \
  --query 'program:git input:merge' \
  --query 'program:gh output:CONFLICT' \
  --fleet --json

# Count static git sites, containing tool calls, and distinct sessions
agents sessions --include tools --query 'program:git' --count --fleet --json

# Populate historical rows once; each device keeps its own SQLite index
agents sessions backfill tools --fleet
```

Terms in one `--query` clause are ANDed against one call. Repeating `--query`
requires a distinct call row for each clause, then returns the session only when
all clauses can be assigned. Supported prefixes are `tool:`, `program:`, `input:`,
`output:`, `status:`, `exit:`, and `error:`. An unprefixed term searches all
evidence fields. `output:` also searches a command's error result because some
harnesses expose returned bytes only as an error channel.

`--count` accepts exactly one `program:<name>` clause and cannot be combined
with `--limit`. It reports three totals over the complete metadata-filtered
scope: ordered static program occurrences, containing tool calls, and distinct
sessions. “Occurrence” is deliberately a static-source metric, not a claim
about runtime executions: a program site inside a loop is stored once, both
branches of static control flow are stored, and a dynamically expanded command
name is omitted. Wrapper chains are retained with roles, so
`sudo env A=1 git status` stores `sudo` and `env` as `wrapper` occurrences and
`git` as `effective`. The redacted, bounded parent `tool_calls.input` stores the
complete submitted command once; occurrence rows do not duplicate it.

A query accepts at most 32 clauses and 4 KiB per clause. Distinct assignment is
polynomial bipartite matching, not permutation backtracking. A listing or broad
query that would materialize more than 50,000 call rows fails with a request to
narrow the metadata filters or add a term. `--limit` accepts 1–1,000 sessions, a result
that would materialize more than 8 MiB of evidence fails, and the encoded JSON
must remain below 15 MiB so it cannot cross the fleet transport's 16 MiB cap.

Tool search has a separate, versioned JSON envelope; it does not change the
stable `SessionMeta[]` list or `{ session, events }` detail shapes:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-03T00:00:00.000Z",
  "query": { "clauses": ["program:git", "program:gh"] },
  "coverage": {
    "indexedFiles": 0,
    "indexedCalls": 0,
    "skippedFiles": 0,
    "limitedFiles": 0,
    "remainingFiles": 0,
    "complete": true
  },
  "sessions": [{ "id": "...", "machine": "mac-mini", "calls": [] }]
}
```

Count JSON is a separate versioned aggregate. `coverage.complete=false` means
the totals are lower bounds, and human output says “at least”:

```json
{
  "schemaVersion": 1,
  "kind": "tool-program-count",
  "query": {
    "program": "git",
    "semantics": "static-program-occurrences-v1"
  },
  "coverage": { "complete": true },
  "totals": { "occurrences": 1842, "toolCalls": 1360, "sessions": 417 },
  "machines": [{ "machine": "mac-mini", "totals": { "occurrences": 820, "toolCalls": 611, "sessions": 190 } }]
}
```

Each device owns its transcript files and its `sessions.db`. `--device` queries
only the named device(s); `--fleet` queries every registered online compute
device concurrently. A distributed tool query covers each target's whole local
index unless metadata flags such as `--agent`, `--project`, or `--since` narrow
it; the coordinator's current working directory is not forwarded as a peer-side
scope. Peers run the same local SQLite query under the recursion
guard and return only the compact envelope over SSH. Raw transcripts, parser
continuations, local transcript paths, and unmatched calls do not cross the
boundary. Peer stdout is capped at 16 MiB and fan-out runs at six devices at a
time. Before fan-out, the coordinator subtracts the exact encoded local result
and a 64 KiB merge reserve from the 15 MiB ceiling. Both raw peer bytes and the
machine-stamped, re-redacted envelopes are charged against that remainder, so
redaction expansion cannot overflow the final JSON. The receive budget stops
retaining or starting more peer responses once exhausted;
`coverage.complete=false` marks the partial fleet result. Malformed or oversized
envelopes are rejected before merging. Fleet tool queries support
`--sort recent`; `--sort cost` and `--sort duration` remain local-only because
peer evidence omits those metrics.

Synced mirror transcripts do not inflate fleet evidence or counts. A direct
local query may search cached rows from several recorded origin machines, but
during fleet fan-out each peer searches only sessions that originated on that
peer. Those origin partitions are disjoint when the coordinator merges evidence
or sums totals; an unreachable origin marks coverage partial instead of
substituting a mirrored duplicate. Evidence preserves the recorded transcript
origin across the SSH hop, so a defensive coordinator merge also collapses the
same origin/session pair if two peers return it.

### Index lifecycle and disk I/O

Schema v29 uses `tool_calls`, the distinct `tool_call_programs` projection,
ordered `tool_program_occurrences`, `tool_call_text` (trigram FTS5), and an
independent `tool_scan_ledger` with aggregate byte accounting. The migration does **not** clear
`scan_ledger` or `dir_ledger`, so enabling the feature does not invalidate the
normal session cache. It clears only `tool_scan_ledger`, so historical occurrence
rows are rebuilt explicitly without forcing ordinary session history to reparse.
The ledger is keyed by session id; its source path is retained for maintenance,
not resolved or checked during a query.

- A changed Claude/Codex transcript derives call rows inside the same resumable
  reducer that already parses the appended bytes. Results that arrive in a later
  append update the original call ordinal/native id. Appended JSONL is streamed
  one record at a time; a record over 1 MiB is skipped without buffering the
  remainder of the transcript.
- Pending call/result correlation state is capped at 256 calls and 1 MiB. An
  evicted unmatched call stays indexed as `unknown` with an explicit diagnostic;
  a later result cannot be attached to a different call.
- Other file-backed harnesses derive call rows from the normalized event array
  produced by the pre-existing todo/recent-directory enrichment parse. Tool
  indexing adds no transcript read to that scan path. Kimi and Grok stamp the
  split `wire.jsonl` / `chat_history.jsonl` source captured before parsing, so
  an append racing the parse forces a retry instead of certifying stale calls.
- Existing history is populated only by `agents sessions backfill tools`. The
  command is resumable and idempotent, processes bounded internal batches of at
  most 25 files or 16 MiB, and can fan out with `--fleet` while each device keeps
  its rows local. A fleet coordinator advances every device by one bounded batch
  per parallel round, so a slow device does not make the other indexes wait to
  begin. One larger Claude/Codex JSONL transcript up to
  64 MiB is admitted alone and streamed with a 1 MiB record cap; larger sources
  persist `index_limit` without being read. Non-streaming harness parsers do
  not materialize a source over 16 MiB and persist an explicit `index_limit`
  row. `coverage.complete=false` names partial results; rerunning the backfill
  resumes from the independent ledger.
- Append persistence stores the aggregate evidence bytes in `tool_scan_ledger`
  and reads only changed ordinals. A user-text-only append advances the file
  stamp without reading historical tool rows.
- Every tool query reads the current SQLite snapshot through
  `queryIndexedSessions`; it does not stat, open, or parse transcripts and never
  calls `ensureToolIndex`. Normal incremental discovery owns new/changed files;
  the explicit backfill owns historical files.
- When a transcript directory changes, call rows and tool-ledger rows for files
  no longer present in that directory are removed without statting every indexed
  session.
- The query evaluates every metadata-filtered session row on each selected
  device; there is no silent history cap. One `json_each` scope join replaces
  per-300-session SQL loops. Trigram FTS and typed indexes prefilter
  call rows before exact distinct-call assignment, and `--limit` bounds only the
  matching sessions returned to the caller. Use `--since`, `--agent`,
  `--project`, or `--device` to narrow the metadata scope when appropriate.

`--markdown` and `--no-redact` are rejected with `--include tools`: the indexed
view has a distinct bounded schema and is always redacted. Inputs are
bounded to 16 KiB, successful output to 1 KiB, and error output to 4 KiB;
the combined evidence payload is capped at 5 MiB per session with an explicit
`index_limit` terminal row when more calls are omitted. Base64-like blocks are
replaced before persistence. Raw strings are clipped to 64 KiB before secret
scanning, orchestration parsing, or Bash parsing, so one adversarial call cannot
force unbounded parser or regular-expression work. Outcomes, exit codes, HTTP status codes, and error
codes are stored only when the harness supplies structured fields. They are
never inferred from output prose.

Codex's `exec` surface carries orchestration JavaScript rather than a raw shell
string. The index first uses `acorn@8.18.0` to statically select literal `cmd`
values passed to `tools.exec_command`; it never evaluates transcript code and
leaves computed commands unclassified. Other shell tools provide their command
field directly. Shell program extraction then uses `unbash@4.0.5` and a typed
AST walk. It recognizes
static programs in pipelines, control flow, functions, subshells, command and
process substitutions, arithmetic expansions, and unquoted heredocs. Dynamic
program names are left unclassified; malformed Bash records parser diagnostics
and emits no derived program rows. The parser is an ISC-licensed, zero-dependency
TypeScript package built for typed AST inspection; its upstream comparison and
reproducible benchmark are documented in the
[`unbash` repository](https://github.com/webpro-nl/unbash#benchmarks).
To inspect a redacted corpus of 50–100 recent
sessions across the fleet:

```bash
bun scripts/sample-session-shell-commands.ts \
  --sessions 100 --since 7d \
  --output .agents/artifacts/shell-command-sample.json
```

The sampler reads the current device directly, fans only peers out over SSH,
round-robins deterministically across machines so every available requested
device is represented, and retains redacted shell-call origins, program names,
outcomes, and parser diagnostics. Each candidate query asks for at most twice
the requested sample size to bound ordinary bulk growth. If one candidate class contains an
individually oversized session, the sampler retains the successful classes,
keeps the last successful partial pass if a later pass exceeds the envelope,
reports `failedQueries`, and marks coverage partial. Its JSON artifact is capped
at 16 MiB; if the requested corpus does
not fit, `coverage.complete` is false and `truncation.reason` is
`sample_byte_limit` instead of silently dropping evidence.

## SessionMeta (list output)

`agents sessions --json` returns an array of `SessionMeta`:

```json
{
  "id": "c07ec355-d841-45fc-b2eb-f500355e15c6",
  "shortId": "c07ec355",
  "agent": "claude",
  "origin": "cli",
  "routineName": null,
  "routineRunId": null,
  "version": "2.1.112",
  "account": "you@example.com",
  "timestamp": "2026-04-22T13:37:14.047Z",
  "lastActivity": "2026-04-22T13:49:36.121Z",
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
| `agent` | One of 12 formats | See the `SessionAgentId` / `SESSION_AGENTS` union |
| `origin` | `cli` or `routine` | Routine rows are archived from a run directory and can be filtered with `--routine` |
| `routineName` | Routine name | Present when `origin` is `routine` |
| `routineRunId` | Routine run id | Present when `origin` is `routine`; `agents sessions <runId>` resolves it |
| `timestamp` | Session start | ISO 8601 — the creation time, never overwritten by later activity |
| `lastActivity` | Last message timestamp, else file mtime, else `timestamp` | The recency signal the listing sorts by; see [Two time fields per row](#two-time-fields-per-row) |
| `project` | Derived from `cwd` | Basename of the working directory |
| `cwd` | Recorded at spawn | Normalized absolute path |
| `gitBranch` | Recorded at spawn | `null` outside a repo |
| `topic` | First user prompt (truncated) | Best headline for a session |
| `label` | The session name — one field, several sources | Priority: agent-generated title / Claude `/rename`, else the launch handle seeded by `agents run --name <slug>` (interactive, headless, `--host`, or a teams teammate), else `null` (listing falls back to `topic`). `agents sessions <ref>` resolves against it. |
| `tokenCount` | Parsed from usage events | `null` for agents that don't log it |
| `model` | Parsed from transcript metadata or assistant events | `null` for harnesses that don't record it; shortened in the static flat list |
| `costUsd` | Σ tokens × per-model price, at scan time | `null` when the model is unknown/unpriced; see `agents cost` |
| `durationMs` | `lastTs − firstTs` over timestamped events | `null` for single-event sessions |
| `isTeamOrigin` | Set when spawned by `agents teams` | JSONL `entrypoint: 'sdk-cli'` |
| `spawnedTeam` | The team this session CREATED, read off its `agents teams create/add` command at scan time | `null` for the ~everything that never ran one; the inverse of `isTeamOrigin` |
| `teamOrigin` | For a teammate: its `{team, handle, mode, parentSessionId}`, read from the teammate's `meta.json` | `null` for a non-teammate; `team`/`parentSessionId` absent on records predating their capture, or once the 7-day teams cleanup removes the dir |
| `plan` | Last `ExitPlanMode` plan markdown (Claude sessions only) | `null` when the session never entered plan-review |
| `usedBrowser` / `usedComputer` | A sessionId-scoped read of `~/.agents/events.jsonl` for `browser.navigate`/`browser.screenshot` / `computer.action` (never a transcript re-scan) | `undefined` on a legacy row this scanner hasn't computed the field for yet — distinct from a real, computed `false` |

### Two time fields per row

The trailing time cell of a listing row carries **both** ends of the session —
when it was created and when it was last active:

```
03f1c81a  claude  2.1.219  agents-cli  Optimize agent workflow performance   3d → 1 hour ago
019fc035  codex   0.146.0  muqsit      Debug hook adders in codex run           31 min ago
```

Last activity is the field the listing sorts by, so it stays on the right, in
the long form (`1 hour ago`); creation is the compact age to its left (`3d`).
Reading them together also gives the span — a row that says `3d → 1 hour ago` is
a session that has been alive for three days and was touched an hour ago, which
one label alone cannot express.

Two cases collapse to a single field:

- **The session ran for under a minute.** Both halves would name the same
  moment, so only last activity renders (`sessionAgeParts`,
  `src/lib/session/relative-time.ts`).
- **The terminal is too narrow.** The creation age is dropped before the topic
  is squeezed below its 16-column floor — the same fits-or-drops rule the model
  column uses. A row never wraps to buy a second time field.

The interactive picker's detail pane spells the same facts out as
`created X ago · last active Y ago · lasted Z`, and reads them from the indexed
`SessionMeta` when there is no local transcript to parse — so a **remote** or
not-yet-indexed session reports its timing too, instead of showing none.

## SessionEvent (detail output)

`agents sessions <id> --json` returns a `{ session, events }` wrapper — the
`SessionMeta` for the session (durable signals like `plan`, `prUrl`, `ticketId`
live here) alongside the normalized event array. Pre-1.20.51 emitted a bare
event array; consumers that JSON.parse the output should read `output.events`.
The `session` object here additionally carries `todos` — the live checklist
progress (`{ items: [{ content, status, activeForm? }], done, total, activeForm? }`)
computed by the state engine from the most recent `TodoWrite` (Claude) or
`update_plan` (Codex) in the **unfiltered** transcript, so it is stable regardless
of any `--include` filter. Absent when the session wrote no checklist. (It is
detail-output only — the listing `--json` above does not compute it per row.)

List and preview surfaces still show that progress when it is available on the
row (live `--active` from the state engine, or `SessionMeta.todos` / transcript
parse in the picker): compact `✓done/total · current step` in the picker
preview (`Todos:` line), the flat listing's `doing` cell, and `--active` /
cross-machine rows (interactive, headless, teams, and sub-agent sessions share
the same path). The picker preview also shows the originating user prompt and a
width-capped `Dirs:` line of directories touched.

Both renders of a session — the picker quick preview and the full summary —
share one extraction module (`src/lib/session/highlights.ts`) for the "what did
this session use and produce" lines, so they never disagree:

- `Skills:` / `Skills (N)` — skills invoked (the `Skill` tool, plugin skills
  included), repeat counts folded (`teams ×2`).
- `Hooks:` / `Hooks (N)` — hooks that fired, from Claude's `hook_success` /
  `hook_error` attachment records (other harnesses don't record firings, so the
  section simply doesn't render for them).
- `Links:` / `Links (N)` — URLs harvested from the conversation, classified
  (Linear/Jira/GitHub/GitLab), deduped by label, clickable (OSC 8).
- `Artifacts:` / `Artifacts (N)` — documents the session CREATED: anything under
  `.agents/artifacts|plans|reports/`, plus other `*.md`/`*.html` creations.
- `Repos:` (picker only) — repos worked in, from a bounded `.git` walk-up over
  the touched paths (relative paths resolve against the session cwd only).
- `Errors:` (picker) — the same failure tally the full summary shows.

The full summary's `Plan` section renders the checklist with status markers
(`[x]` / `[>]` / `[ ]`) alongside any ExitPlanMode plan text. Changes/Dirs
labels collapse `.agents/worktrees/<slug>` prefixes to `⧉ <slug>/…` and drop
shell junk (`2>&1`, unexpanded `$VAR` paths), `node_modules`, and agents-cli
internal archives at the source (`digest.ts:isNoisePath`).

```json
{
  "session": {
    "id": "c07ec355-...",
    "agent": "claude",
    "plan": "# Plan\n\n1. ...",
    "todos": { "items": [{ "content": "Step one", "status": "completed" }], "done": 1, "total": 2, "activeForm": "Doing step two" },
    "prUrl": "https://github.com/.../pull/38",
    "..."
  },
  "events": [
    { "type": "message", "role": "user", "timestamp": "...", "content": "..." },
    { "type": "tool_use", "timestamp": "...", "tool": "Edit", "args": {}, "path": "/repo/src/a.ts" },
    { "type": "tool_result", "timestamp": "...", "tool": "Edit", "success": true },
    { "type": "usage", "timestamp": "...", "model": "claude-opus-4-7", "inputTokens": 6, "outputTokens": 364 },
    { "type": "thinking", "timestamp": "...", "content": "..." },
    { "type": "message", "role": "assistant", "timestamp": "...", "content": "..." }
  ]
}
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

# One team's whole lineage: the session that spawned it, plus (with --teams) its
# teammates. Spans every directory and all time — a team's teammates run in their
# own worktrees and its history outlives the default window — so it needs no --all.
# In the browser, `t` cycles the same filter over the teams in view.
agents sessions --in-team redesign --teams

# Show routine-run sessions, then open one by routine run id
agents sessions --routine --all
agents sessions 2026-07-21T10-30-00-000Z

# Sort the list by cost or duration (default: recent)
agents sessions --sort cost --limit 10
agents sessions --sort duration --all

# Only sessions that invoked a skill, or that used anything owned by a plugin —
# a subquery join against session_resource_usage (see below). --skill matches a
# bare name or a namespaced plugin skill's short name (design finds rush:design).
agents sessions --skill design --all
agents sessions --plugin rush --all

# Replay one session as markdown
agents sessions c07ec355 --markdown

# Full normalized event array for one session
agents sessions c07ec355 --json --last 30

# Role filtering
agents sessions c07ec355 --json --include tools,assistant --last 20

# Follow a live Claude/Codex session with compact lines by default
agents sessions tail c07ec355

# Opt in to raw JSONL when piping the live stream
agents sessions tail c07ec355 --json | jq 'select(.type == "user")'
```

`agents sessions tail` and `agents logs -f <id>` render compact live lines by
default, even when stdout is piped. They show messages, tool calls, elided tool
results, and errors; thinking, usage, init, and result metadata are hidden. Use
`agents sessions tail --json` for the raw JSONL stream, or `agents logs -f --full`
for the raw transcript follow.

## Live sessions (`--active`) and the interactive browser

`agents sessions --active` answers "what is running right now, everywhere". It sweeps
the local machine (`getActiveSessions`) and, unless `--local`, every registered online
device over SSH, through one shared gather — `gatherActiveSessions` in
`src/commands/sessions.ts`. `--host`/`--device` **scopes** that sweep to the named
machines rather than adding to it.

On a TTY it opens the interactive browser seeded to running-only; `--json`,
`--waiting`, and `--no-interactive` print the static grouped view instead. Both read
the same gather, so they always agree on what is live.

**Team lineage.** A teams teammate row carries the id of the **orchestrator** that
spawned it — the session that ran `agents teams add`, captured from
`AGENTS_SESSION_ID` at spawn and stored as the teammate's `parentSessionId`
(`src/lib/teams/agents.ts`). `listTeamsActive` surfaces it as `orchestratorSessionId`
(the teammate's own transcript stays `sessionId`), and `getActiveSessions` resolves an
`orchestratorLabel` from the orchestrator's own row when it is present in the set.

Each row also carries the team's **target** — a one-line summary of the mission the
teammate was spawned with (`summarizeMission` over the stored `prompt`), exposed as
`assignedTask` and shown even before the teammate has produced a transcript. The row
reads `<team> · <teammate> · by <orchestrator> · <live turn | mission>`, so one
orchestrator running several teams stays legible (distinct `teamName`s) and each team
says what it is *for*, not just its slug. `--active --json` carries
`orchestratorSessionId`, `orchestratorLabel`, and `assignedTask` for programmatic use.

Two properties of the running view are worth stating, because a session missing from
it is indistinguishable from a session that isn't running:

- **Running is a source of rows, not a filter over the transcript index.** A live
  session the local index doesn't carry — one on a peer, one older than the browser's
  window, one whose agent hasn't written a transcript yet — is listed as its own row
  (`mergeLiveIntoPool`, `src/commands/sessions-browser.ts`). Rows keyed by session id
  merge with their indexed row; a session with no id yet is keyed by cloud task id or
  `machine:pid`, so two of them never collapse into one.
- **A tmux agent pane is one row per session, resolved from its own name.** Each
  shared-socket pane is named `ag-<agent>-<shortid>`, where `<shortid>` is the first 8
  chars of the session UUID. `resolvePaneIdentity` (`src/lib/session/active.ts`) reads
  the id back from that name — resolved to the full UUID via the `short_id` index in a
  single batched query per scan (`findSessionsByShortIds`) — so a detached pane whose
  durable identity records (session-meta JSON, pid registry, SessionStart-hook index)
  have aged out is still attributed to its own session and stays `focus`-able. When no
  id resolves, the pane keeps its own row keyed on the tmux pane id and never borrows a
  co-located sibling's transcript — so N agents in one directory are N rows, not one row
  wearing a stranger's id.
- **The host column names the program the session runs in** — `codium`, `ghostty`,
  `tmux`, and `tmux→ghostty` when a tmux session is currently being watched through
  another app. A tmux row with no attached client stays a bare `tmux`, which is what
  running detached looks like. It comes from the live scan (`ActiveSession.host` /
  `viewingIn`), so it appears only in the running view — transcript metadata has no
  host.

A row with no session id addresses no transcript: picking it reports where the process
is instead of failing to open a file that does not exist.

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
# Browse another machine's sessions in the interactive picker (previews + resume)
agents sessions --host yosemite-s1        # or --device yosemite-s1

# Search another machine's sessions live (no sync, always current)
agents sessions "auth bug" --last 3 --host yosemite-s1

# Fan the same query across several machines
agents sessions --all "deploy script" --host box-a --host box-b
```

A **bare** `--host`/`--device <box>` listing on a TTY folds that box into the same
interactive fleet browser as the local view — preview-rich and selectable — rather
than the legacy per-host raw stream. The stream is still used for a `--host` *query*
(`agents sessions "term" --host <box>`), a render/filter flag, `--json`, or a
non-interactive caller (piped/`--no-interactive`).

It works by invoking the **remote's own** `agents sessions` against its already-built
index over SSH — `ssh -o BatchMode=yes <host> bash -lc 'agents sessions …'`
(`src/lib/session/remote.ts`). `--host` is stripped before forwarding so there is no
recursion; the target must be a host alias or `user@host` (validated against
`SSH_TARGET_RE` to block argv-flag smuggling). SSH access is the only auth — if you
can `ssh <host>`, you own the box; there is no identity layer.

On the **streaming** path every other flag (`--since`, `--json`, `--markdown`, query,
even `tail` and `--active`) forwards verbatim, since the far end runs the same binary,
and the peer's stdout comes back under a per-host banner. The **browser** path asks
each peer a fixed `sessions --all --json --limit 500` (plus `--since`/`--teams`) and
merges the rows locally, so `--limit`, `--unmanaged`, and `--no-live` do not reach the
peer there. Because a host scope means "look only over there", the browser also drops
the default this-repo filter (no peer cwd is under yours) and refuses `--local`, which
would skip the very fan-out the scope needs. A peer that fails to answer is named in
the browser header — the full-screen picker repaints over the fan-out's stderr note,
so an asleep box would otherwise be indistinguishable from an empty result.

**`--host` is the default cross-machine recall path.** Online machines are the norm,
so a live pull covers almost all recall with zero storage, zero lag, and no daemon —
always current, nothing to configure beyond SSH. Export/import (below) is the
mechanism for the case a live pull can't reach: a machine that is
**offline / asleep / decommissioned**.

- **Export / import (portable bundles)** — user-driven, no daemon. Bundle the sessions
  you want and carry them anywhere, or pull them off a peer in one command. This is the
  durable-archive / hand-off tool (below).

### Resolving a session id across the fleet

For automation that needs session metadata without parsing or rendering transcript
events, use the explicit resolver:

```
agents sessions --resolve d3470b57 --json
agents sessions --resolve "recap resolver" --json
```

It reads the indexed `SessionMeta` rows on each machine and emits a one-element JSON
array containing only `id`, `shortId`, `agent`, `origin`, timestamps, `project`, `version`,
`label`, `topic`, and `machine` when exactly one logical session matches. Transcript
paths/content (`filePath`, `plan`), account, cwd, cost, and token fields stay on the
owning machine. A missing/empty selector or ambiguous ID prefix/keyword query exits 1.
Fleet peers receive a versioned, metadata-only `--resolve-safe-v1` request, so a peer
carrying an older unsafe resolver rejects the request before serializing a row. If any
selected peer is unreachable, returns malformed JSON, cannot list devices, times out, or rejects the protocol because it runs
an older CLI, the command emits no JSON, names the peer(s), and exits 2; it never makes
a unique/no-match decision from partial fleet state.
`--local` keeps the metadata lookup on this machine.
`--agent <agent[@version]>` and `--project <name>` narrow the lookup on every peer;
`--all` is implicit because historical resolution must not inherit the SSH login
directory or recent-session window.

`--host` names *which* box to look on. When you already have a full session id but
**not** the box, `agents sessions <uuid>` finds it for you. A unique short prefix works
the same way: `agents sessions d3470b57` fans the **id lookup** out to the online fleet
(the same `gatherRemoteList` SSH sweep the listing uses), resolves the prefix to its full
id, and renders the session's summary from a machine that holds it. Rendering is
delegated to that peer via `runOnPeer`, since its transcript and agent binary live there.

```
# You have the id from a log or a teammate; you don't know the machine
agents sessions d3470b57-2af6-4c11-b1de-3fab94f43603
# → renders the summary from whichever online box owns it (e.g. yosemite-s0)
```

- **Exact id only — never a content search.** A UUID appears verbatim in *other*
  sessions' transcripts (a watchdog `/continue <uuid>` reference echoes the parent id
  into later sessions), so a fuzzy match would surface unrelated sessions as "matches."
  There is no FTS/content fallback for an id-shaped query: it is found by id or reported
  not found, locally and on every peer.
- **Ambiguous prefixes** fail with every matching full id and its machine labels; pass a
  longer prefix to select one.
- **Synced copies are one logical session.** The same full id reported by several machines
  does not make a prefix ambiguous; the CLI renders one of those equivalent copies.
- **Keywords keep the existing search semantics.** Each peer unions indexed metadata
  matches (label, topic, project, account, path, agent, and version) with that peer's
  transcript-content FTS hits. The parent preserves those peer-owned matches and applies
  the uniqueness check across the fleet.
- **`--local`** restricts the lookup to this machine — no cross-machine sweep — for
  scripts that want deterministic local behavior.
- A peer already answering a parent's sweep (`AGENTS_SESSIONS_LOCAL=1`) never re-fans-out,
  so a fleet resolve can't recurse.
- The parent uses the versioned hidden `--resolve-safe-v1` peer protocol. An older peer,
  malformed peer JSON, or an unreadable device registry makes the sweep incomplete;
  the command emits no JSON and exits 2 instead of deciding from partial results.
- **Which peers get dialed** is `isDialableDevice`
  ([`src/lib/devices/registry.ts`](../src/lib/devices/registry.ts)) — a **union** of the
  two liveness signals, where either one saying "go" is enough:
  - No `tailscale` block at all is **unknown-not-offline**, so the peer is dialed. A
    device registered with `address.via: "manual"` never gets a Tailscale peer entry, so
    its `online` is permanently `undefined`; the old strict `online === true` test
    skipped it forever and made every session on that box unresolvable from elsewhere.
    This matches `ssh.ts` `renderDeviceTable` and Factory's `isDeviceOnline`, so the
    picker and the sweep agree on who exists.
  - A **positive** live SSH probe (`DeviceProfile.reachability`, RUSH-1965) additionally
    rescues a device whose snapshot says offline.
  - A **failed** probe never removes a peer. The probe runs on a short SSH budget and
    returns false negatives on a congested tailnet — it has been observed marking the
    local machine unreachable — so excluding on it would hide sessions on healthy boxes.
    Dialing a box that is actually asleep costs one `ConnectTimeout`.

  Note the interaction with the exit-2 rule above: a peer that is dialed but does not
  answer still counts as unreachable, and `--resolve` then refuses to decide rather than
  return a possibly-non-unique match. A fleet with a permanently-sleeping registered
  device will therefore keep reporting a partial resolve until that device is removed
  from the registry or wakes up.

## Forking (branch a conversation)

`agents fork <session>` branches an existing conversation into a NEW, independent
session. Where `resume` continues the *same* thread (same id, same file — it
appends), `fork` copies the transcript under a fresh id, so continuing the fork
diverges instead of mutating the original. It is the "git branch" of
conversations — useful for exploring an alternative approach from a point you
already reached, or fanning a promising session into two directions.

```bash
# Fork by (partial) id, then continue the copy — the original is untouched
agents fork 4f3a9c21
agents resume <new-id>

# Name the fork
agents fork 4f3a9c21 --name "try redis instead"
```

Mechanics (`lib/session/fork.ts`): a Claude session id *is* its `<id>.jsonl`
filename, so a fork copies the transcript to a new-uuid file in the same
directory, rewrites the embedded per-line `sessionId`, registers the new row via
`upsertSession`, and labels it (`fork of <original>` by default, via the same
run-name sidecar as `agents run --name`). The fork resolves immediately by
`agents sessions` / `agents resume` and is version-pinned like any other session.

Scope: v1 supports **Claude** (single-file transcript, native `--resume`). Codex
(single-file) is a natural next step; multi-file agents (grok, kimi) and DB-only
agents (opencode) need per-agent handling and are refused up front with a clear
message.

## Background & foreground (detach / attach)

`agents sessions detach <id>` sends a live agent session to the background;
`agents sessions attach <id>` brings it back. They live under `sessions` alongside
`focus`/`resume` — the session-lifecycle axis — and route through the same
version-pinned `agents run --resume` path everything else uses, so they are
agent-agnostic (native resume for Claude/Codex, `/continue` replay for the rest),
not a per-agent special case. (In the Factory extension: **Agents: Detach**
`Cmd/Ctrl+K B`, **Agents: Attach** `Cmd/Ctrl+K A`.)

- **detach**: stop the interactive process (kill the tmux session when tmux-hosted,
  else SIGTERM the pid) and **wait for it to actually exit** before spawning a
  detached, version-pinned `agents run <agent> --resume <id> --headless "<nudge>"`,
  so the two never race over the same transcript. The nudge tells the now-unwatched
  agent it is headless and to drive its task to completion rather than stall on a
  confirmation nobody can answer. The continuation runs until the task is done, then
  exits; its output is written to `~/.agents/.cache/logs/detach-<shortid>.log`
  (printed on detach) so a background run that crashes leaves a trail.
  - **Remote sessions** (matched via the cross-host sweep) are detached **on their
    own host over SSH** — `agents sessions detach <id> --local` runs there — since a
    pid and tmux socket only mean something on the machine the session runs on. Use
    `--local` to skip the sweep and only consider this machine.
  - **Cloud and team sessions are refused**: cloud runs have their own lifecycle, and
    a `teams` session must be stopped through `agents teams` so the team supervisor's
    PID-reuse-safe stop path and bookkeeping stay in sync — `detach` won't SIGTERM a
    teammate out from under it.
- **attach**: stop the headless continuation (if any), then `resumeSessionInPlace`
  the session interactively in the current terminal — the same session, full history,
  including whatever the background run did.

The record `detach` writes (`~/.agents/.system/detached/<id>.json`, one file per
session; see `lib/session/detached.ts`) is the source of truth for **presence**, which
`getActiveSessions` folds onto every row and `agents sessions --active --json` emits:

| presence | meaning |
| --- | --- |
| `attached` | live interactive TUI you're watching |
| `background` | detached: the headless continuation is running (its pid is alive) |
| `parked` | the headless continuation has exited; the transcript is durable, `attach` resumes it |

Presence is **derived, never asserted**: a record only says "this session was detached";
whether it is `background` or `parked` is decided live from the recorded pid plus its
start-time fingerprint (which defeats PID reuse). Ad-hoc headless runs and cloud/team
rows carry no presence — they are not on this axis.

## Lost hosts: `crashed` and `orphaned`

Every other liveness signal answers "is the agent process alive". None of them answer
"is anyone still driving it", and those come apart in the two ways a user notices — so
`getActiveSessions` folds a **host link** onto every row (`foldHostLink`, from the pure
classifier in `lib/session/host-link.ts`) and promotes it into the status column:

| status | glyph | what happened |
| --- | --- | --- |
| `crashed` | `✗` | The host window (VS Code, the terminal, an SSH connection) went down hard and the agent died with it. Its slice of `live-terminals.json` is still there naming a dead pid, because the window never got to run its teardown. |
| `orphaned` | `◍` | The agent is still alive with **no client attached** — tmux reports zero attached clients, or the IDE window that owned it stopped republishing. It is idle, or sitting on a question nobody will answer. |

The two signals behind them:

- **`#{session_attached}`** — the count of clients attached to a tmux-hosted session,
  folded on by `foldTmuxClients` (one `list-panes` per socket, only when some row is
  tmux-hosted). It keys off `provenance.mux`, which `enrichProvenance` stamps on any row
  whose process env names a pane — deliberately **not** off `listTmuxAgentSessions`,
  which only emits a row when it can resolve the pane's agent *identity* and emits
  nothing at all on a machine where neither the launch registry nor a session meta
  resolves. Hanging the count off that source would leave the orphan signal silently
  dead on exactly those machines. An *absent* count (a tmux too old to report the field)
  means "cannot tell", never zero.

  Note the separator: tmux **sanitizes non-printable characters out of format output**
  (3.6a rewrites a literal tab — and any non-ASCII sentinel — to `_`), so every `-F`
  query here uses `TMUX_FIELD_SEP`. `listTmuxAgentSessions` split on `\t` and therefore
  returned zero rows on any such tmux — fixed alongside this. The separator is `:`
  specifically because tmux replaces `:` and `.` in a *session name* with `_`, so it
  provably cannot occur in the one free-text field that is not last;
  `pane_current_path` (which may contain `:`) is queried last and its tail rejoined.
- **The IDE window heartbeat** — the `at` stamp on each window's slice of
  `live-terminals.json`. The Factory extension force-republishes every 4 minutes, so a
  slice older than `HOST_HEARTBEAT_STALE_MS` (10 minutes, the same window the extension
  uses to GC a dead peer) means that window is gone.

Precedence is deliberate, so the words keep their meaning:

- `abandoned` (days-stale) wins outright and claims no host link.
- `crashed` **replaces** `closed` — both mean the process is gone, but `closed` reads as
  a normal exit.
- `orphaned` replaces only `idle` / `input_required`. A session still **working** with
  nobody watching is an ordinary headless run; flagging every one would bury the signal.
- A session detached on purpose (`presence` `background`/`parked`) is never flagged — no
  client is the point of detaching.

A `crashed` row is deliberately transient: once its transcript goes days-stale it
degrades to `abandoned`, so the listing carries an alert, not a permanent tombstone.
And a dead session never trips the `--waiting` gate, however its last turn ended:
`activity` is not rewritten on death, so a session that crashed mid-question would
otherwise read as "needs your input" forever when what it needs is a relaunch
(`isAwaitingUser`). `closed`/`crashed` are excluded outright — both are
unconditionally dead. `abandoned` is not: it fires on transcript staleness *before*
the liveness check, so it also covers a live-but-forgotten session that asked a
question and sat untouched over a long weekend, which is still answerable and is
exactly what the gate is for. That one is excluded only when its `pidAlive` is
positively false; unknown liveness stays excluded rather than inventing a human who
can answer. The session preview shares this one predicate, so the human-facing
"needs you" line and the scriptable gate can never disagree about a row.

**Known residual — an ambient tmux session.** `provenance.mux` is stamped from the
process env, so an agent launched inside a tmux session the *developer* owns (rather
than one the CLI spawned for it) reads that session's client count. Detach that tmux for
unrelated reasons and its idle/waiting agents read `orphaned` until you reattach. The
blast radius is bounded — a `running` session is never relabelled, `--waiting` still
fires through `activity`, and the preview keeps the specific "waiting on you" sentence
rather than replacing it with the generic orphan line — but the label is optimistic
about whose tmux it is. Distinguishing a CLI-spawned pane from an ambient one is
possible (`listPidSessionEntries()` knows which panes it launched) and is the fix if
this proves noisy in practice.

Both are visible everywhere a status already was — the `--active` grouped view, the
default printed listing, `--active --json` (plus a `hostLink` field), and the session
preview, which spells the state out in a sentence rather than a glyph. The interactive
browser gained a status column of its own for the running view (`PickerColumns.showStatus`,
gated exactly like `showHost`): it previously showed which terminal a session ran in but
never what it was doing, so a session that had lost its host was indistinguishable from a
healthy one in the row list.

## Favorites (starred sessions)

`*` in the interactive browser stars the highlighted session; `f` filters the list to
the starred ones. Outside a TTY, `agents sessions favorite <id>` (`--remove`, `--list`,
`--json`) does the same, and `agents sessions --favorites` is the flag twin of `f` — so
the `y` copy-cmd round-trips a starred view into a command.

Stars live in `~/.agents/.history/favorites.json` keyed by session id, **not** in
`sessions.db`. The index is a rebuildable cache — a reindex re-derives every row from
the transcripts on disk — and a favorite is not derivable from a transcript, so a column
there would be silently lost on the next rebuild. `.history` is never pruned, so a star
survives that rebuild.

Favorites are **per-machine**. Session sync carries `.history/backups/`
(`lib/session/sync/agents.ts`), not this file, so a session starred on one box is not
starred on another — even though the session id itself is fleet-wide. Carrying them
would mean adding the file to the sync manifest.

That store is per-machine but the FILTER is not scoped to one: `--favorites` applies to
every row in the merged fleet view, so a peer's session you starred from here still
shows. This is why the live `--active` path filters after the remote fan-out rather than
forwarding the flag to each peer — a peer has its own (different) star list.

## Export / Import (portable bundles)

`agents sessions export` bundles selected sessions into a portable, self-describing
archive; `agents sessions import` restores one. This is the user-driven successor to
background sync for the durable-archive / hand-off case: no daemon, no cloud bucket —
you choose what to carry and when.

```bash
# Bundle the last week to a file (secrets redacted by default)
agents sessions export --since 7d -o week.bundle

# Bundle specific sessions (by id or query), encrypted
agents sessions export 4f8a2b1c "auth bug" --encrypt -o pick.bundle

# Restore — preview first, then import
agents sessions import week.bundle --dry-run
agents sessions import week.bundle

# Pull straight off another machine in one command (over SSH, no R2)
agents sessions import --from-host yosemite-s1 --since 7d

# …which is just sugar for the raw pipe
agents ssh yosemite-s1 'agents sessions export --since 7d --stdout' | agents sessions import -
```

A bundle is **self-describing NDJSON**: a header line (origin machine, encrypted /
redacted flags, session + file counts) followed by one line per transcript file
(agent, origin machine, session id, storage-relative key, SHA-256 hash, optional
label, body). NDJSON — not tar — so it pipes cleanly over SSH with no external
archiver, stays greppable with `head`, and carries a per-file AES-256-GCM envelope
when `--encrypt` is on. Selection reuses the same flags as `agents sessions`
(`--since`, `-n/--limit`, `--all`, `-a/--agent`, `--no-redact`); dir-shaped sessions
(Kimi) carry all their constituent files.

**Encryption key.** `--encrypt` prefers the shared `R2_SYNC_ENC_KEY` from the
`r2.backups` secrets bundle (so any machine holding that bundle can decrypt), or
mints and prints an ephemeral key once — never stored — when the bundle isn't
configured. `agents sessions import` decrypts with the same bundle key, or an
explicit `--decrypt <key>` for an ephemeral one. Credentials come from that
keychain bundle only, never env or disk (`src/lib/session/sync/config.ts`).

**Import placement reuses the same per-agent mirror layout as a live remote
listing.** Each session lands at
`~/.agents/.history/backups/<agent>/<origin-machine>/<subdir>/<relKey>`
(`src/lib/session/sync/agents.ts`), so imported sessions show up in
`agents sessions` tagged with their origin machine and **never overwrite your own
local sessions** ("local always wins" falls out of the scanner's live-home-first
dedup, no extra logic). Dedup is byte-exact: a bundle file identical to one already on
disk is skipped; a file that differs is a conflict, kept local unless `--overwrite`.
`--from-host` reuses the exact SSH transport as the cross-machine listing
(`resolveExplicitTargets` + `ssh-exec`) — no second transport, no daemon.
Source: `src/lib/session/bundle.ts`, `src/lib/session/remote-bundle.ts`,
`src/commands/sessions-export.ts`, `src/commands/sessions-import.ts`.

## Migration (relocate a live session)

`agents sessions migrate` (alias `relocate`) **moves a RUNNING session onto another
machine** — a fleet worker, a registered device, or a warm/fresh ephemeral crabbox
box — then stops the source so the interactive machine reclaims its compute. Where
export/import carry a *transcript* between machines, migrate carries the *live agent*:
it ships the transcript, resumes the agent on the target, confirms its prompt is live,
and only then kills the source.

```bash
# Move the session in THIS tmux pane onto the least-busy fleet worker
agents sessions migrate --auto

# Move a specific session onto a named host / device / warm box slug
agents sessions migrate a1b2c3d4 --host yosemite-s1

# Provision a fresh ephemeral box and move onto it
agents sessions migrate --lease

# Copy (don't stop the source), and let the running agent wrap up its own dirty tree
agents sessions migrate --host box-a --keep --agent-wrapup
```

The flow reuses existing primitives rather than reinventing transport or resume:

1. **Resolve the source.** With no `[session-id]`, migrate matches the current tmux
   pane (`$TMUX_PANE`) against a live session's `provenance.mux.pane` via
   `getActiveSessions()`. Pass an explicit id when you're not inside the session's pane.
2. **Resolve the target.** `--auto` picks the best machine with the pure scorer
   (`src/lib/session/migrate-targets.ts`): eligible = reachable, dispatchable, not this
   machine and not the source; ranked by platform-match-with-source, then a warm fleet
   worker over a fresh box, then live headroom (idle > light > busy > loaded, from the
   `agents devices` stats cache). `--host <name>` names one; `--lease` provisions a
   fresh box (`crabboxWarmup`).
3. **Verify + bootstrap.** `readyProbe()` checks the target can run the session's
   agent+version; a missing agents-cli is bootstrapped (`bootstrapAgentsCli`).
4. **Wrap up the working tree.** Dirty → commit to a branch, push, open a **draft
   (WIP) PR** (mechanical by default). `--agent-wrapup` instead injects a wrap-up turn
   into the running agent (same tmux reply rail as `sessions inject`). Clean-but-ahead → push.
5. **Ship the transcript** to the target's live agent dir: the transcript file is copied
   to the same path on the target (identical under the shared fleet `$HOME`), streamed
   over the same `sshExec` transport, so the agent finds it where it reads sessions.
   (`sessions import` lands bundles in the browsable history mirror — right for reading a
   transcript elsewhere, wrong for continuing it.)
6. **Resume on the target** in a detached tmux session (`tmux new-session -d`, which
   starts the server a fresh worker/box lacks — the generic `new-window` backend needs a
   live server), then confirm the pane is *live* (not merely created) before proceeding.
   For an ephemeral box, migrate git-clones the repo and checks out the (WIP) branch first
   so the cwd resolves.
7. **Stop the source** (`killSession`) — but only after the target session is confirmed
   live. `--keep` skips this (copy, not move).

**`--mode rehydrate | resume`** (default `rehydrate`). Rehydrate ships the transcript and
starts the agent on the target with a prompt telling it to read the session
(`agents sessions <id>` — its own judgment on `--last`/`--include` so large tool output
can't blow context) and continue; robust across every harness. `--mode resume` attempts a
native `<agent> --resume` — faithful, but best-effort: the target agent must have the
session registered, so migrate falls back to rehydrate when it can't. **Harness parity:**
`buildResumeCommand` returns null for the non-resumable agents (gemini, antigravity,
openclaw, rush, hermes, grok, kimi, droid); a resume request for those transparently
becomes rehydrate with a printed notice — never a silent skip.

**Invariant:** the source is never killed before the transcript is on the target and its
session is confirmed live.

**Tracking handoffs.** Every migrate appends to an append-only ledger at
`~/.agents/.history/migrations.jsonl` (synced with the rest of `.history`, so source and
target converge). `agents sessions migrations` prints it — the border tracker showing each
session's `from → to`, mode, move-vs-copy, and status; a session that hops A→B→C leaves
three lines, its lineage. Source: `src/commands/sessions-migrate.ts`,
`src/lib/session/migrate-targets.ts`, `src/lib/session/migrations.ts`.

## Skill/plugin/slash-command usage (`session_resource_usage`)

A separate table, `session_resource_usage(session_id, kind, name, plugin,
source, repo_root, snapshot_sha, count)`, records every skill and
slash-command a session invoked. `kind` is `'skill'` (from that harness's
skill-invocation tool call — Claude and Kimi both name it `Skill`; see
`SKILL_TOOL_NAME_BY_AGENT` in [`src/lib/session/highlights.ts`](../src/lib/session/highlights.ts))
or `'command'` (a slash command — either the user typing one, captured from
Claude's `<command-name>` wrapper, or the model invoking one via the
`SlashCommand` tool; see `SessionEvent.slashCommand`). `name` is the bare
name without a leading slash, `plugin:name` for a plugin-owned skill/command
(e.g. `rush:design`).

`plugin`/`source`/`repo_root`/`snapshot_sha` are resolved at write time
against the *currently installed* resource — `resolveResource()` for a flat
(non-namespaced) resource, or the discovered plugin list for a namespaced
one (a plugin's own `skills/`/`commands/` dirs aren't visible to
`resolveResource()`'s flat scan). A skill/command renamed or uninstalled
since the session ran leaves these NULL rather than a stale guess; the row
(name + count) is written regardless. `repo_root`/`snapshot_sha` are the
same provenance fields `ResolvedResource`/`DiscoveredPlugin` carry —
"which DotAgents repo, which git commit" (see
[`src/lib/resources.ts`](../src/lib/resources.ts)/[`src/lib/plugins.ts`](../src/lib/plugins.ts)).

`agents sessions --skill <name>` / `--plugin <name>` query this table (see
[Query Flags](#query-flags)); `--skill` matches a bare name or a namespaced
plugin skill's short name.

**Known gap:** claude/codex sessions found through the routine local batch
scan (`upsertSessionsBatch`) get their tallies from an incremental
accumulator threaded through the resumable-parse continuation
(`ClaudeParseState.skillEvents`/`slashCommandEvents`) rather than a
transcript re-scan, to avoid undoing that optimization's whole point. Every
other harness, and any claude/codex session upserted outside the batch path
(cross-machine fan-in, forks), derives the tallies directly from the parsed
transcript.

## Schema Version

Schema version is tracked by the `SCHEMA_VERSION` constant in
[`src/lib/session/db.ts`](../src/lib/session/db.ts) (the constant is the source
of truth — don't hardcode the number here). Migrations run on connection
open; old DBs get upgraded in place. The `meta` table tracks `schema_version`.
Later migrations added, among others, `cost_usd` / `duration_ms` (pricing), the
work-signal columns `pr_url` / `pr_number` / `worktree_slug` / `ticket_id`, the
`plan` markdown, `output_tokens`, `is_team_origin`, `spawned_team`, the
`used_browser`/`used_computer` columns (NULL for a legacy row this scanner
hasn't computed the field for yet, never a `false` default), and the
`session_resource_usage` table. A migration that changes how
a column is derived forces a full rescan so every existing session is re-derived
(as the pricing columns once did).

## Benchmarks

Two harnesses cover the session-query paths; both live in [`bench/`](../bench):

| Harness | Covers | Gating? |
|---|---|---|
| [`bench/sessions-perf.ts`](../bench/sessions-perf.ts) | The local discover/search pipeline: cold/warm `discoverSessions`, a single picker keystroke, 10 successive keystrokes (typing), `searchContentIndex` alone. | No — informational, `continue-on-error` in `bench.yml`. |
| [`bench/sessions-active-perf.ts`](../bench/sessions-active-perf.ts) | The **distributed** paths: `--active --local` (the RUSH-2118 regression) and `--host <peer>` (the cross-fleet fan-out). | **Yes** for this one step — see below. |

### `--active --local` and `--host` (`sessions-active-perf.ts`)

Two parts, run in one script:

- **A. `--active --local` guard.** Builds N synthetic remote-host teammates
  (the shape `agents teams add --device` produces) mixing still-RUNNING and
  already-terminal statuses, then times `AgentManager(..., localOnly=true).listAll()`
  — the exact call `agents sessions --active --local` makes. A stub `ssh`
  shadowing the real binary on PATH turns any dial attempt into a recorded
  violation: RUSH-2118 was exactly this — a `--local` query firing a real ssh
  round-trip per remote-host teammate, on every poll, whether or not the
  teammate had already finished (measured at 180 ssh calls / ~4.3s on a
  30-teammate fixture before the fix). A **positive control** run
  (`localOnly: false` against one still-RUNNING teammate, which legitimately
  should dial) asserts the shim actually observes a real call first — without
  it, a shim that silently stopped intercepting would make the guard pass for
  the wrong reason.
- **B. `--host <peer>` distributed fan-out.** No live fleet is reachable in
  CI, and GitHub-hosted runners don't run sshd, so the SSH boundary is mocked
  by shimming `ssh` on PATH: it sleeps a configurable per-call latency then
  returns a canned `--active --json` payload. The bench asserts the fan-out
  against N synthetic peers stays close to **one** round trip, not N — a
  regression here means `Promise.all` silently became sequential.

Both assert a threshold and exit 1 on violation:

```bash
bun bench/sessions-active-perf.ts
# BENCH_LOCAL_THRESHOLD_MS   (default 500)  — Part A latency ceiling
# BENCH_REMOTE_TEAMMATES     (default 30)   — synthetic teammate count
# BENCH_FAN_OUT_PEERS        (default 8)    — synthetic peer count
# BENCH_PEER_LATENCY_MS      (default 60)   — per-peer shimmed ssh latency
# BENCH_PARALLELISM_FACTOR   (default 3)    — Part B threshold = latency × factor
```

Wired into `.github/workflows/bench.yml` as the one **gating** step in that
workflow (every other bench step is `continue-on-error`) — a lightweight
threshold assertion, not a full perf suite, so the correctness test
(`agents.remote-poll.test.ts`, gates every PR) and this latency guard cover
the regression from two angles.

Measured baseline (this repo, 2026-08-04, `bun v24.3.0`):

```
A. --active --local (30 synthetic remote-host teammates): best 2.6ms, 0 ssh calls
   (positive control observed 6 call(s)) — PASS
B. --host fan-out (8 synthetic peers, 60ms/call): best 68.2ms
   (parallelism threshold 180ms) — PASS
```

For comparison, [`scripts/bench-ssh.mjs`](../scripts/bench-ssh.mjs) measures
the real-network-latency side of the shared SSH transport against a live
fleet host (see [Optimizations §OPT-02](99-optimizations.md#opt-02-ssh-transport--one-multiplexed-engine));
`sessions-active-perf.ts` is its CI-safe counterpart for the sessions
fan-out specifically.

## Related

- `agents logs [id]` — one viewer over both a run's log **and** its session transcript: resolves a host-dispatch task (`agents run --host`) or a session by id/`--session`, filters by `--host`/`--agent`/`--version`, and `-f` follows a live one (a session tail is `agents sessions tail` under the hood, claude/codex only). See [Hosts](hosts.md).
- `agents sessions <id> --artifacts` — list files created/modified in a session
- `agents teams status` — session state for team-coordinated runs
- `agents cloud logs <id>` — for remote cloud dispatches (different subsystem)
