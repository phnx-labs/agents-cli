# Sessions

Unified discovery, search, and rendering of agent conversation transcripts across
the session-discoverable harnesses — Claude, Codex, Gemini, Antigravity, OpenCode,
OpenClaw, Rush, Hermes, Grok, Kimi, and Droid (the `SESSION_AGENTS` set in
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
not an append-only JSONL; Gemini still full-parses each changed file.

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
| `agent` | One of 11 formats | See the `SessionAgentId` / `SESSION_AGENTS` union |
| `origin` | `cli` or `routine` | Routine rows are archived from a run directory and can be filtered with `--routine` |
| `routineName` | Routine name | Present when `origin` is `routine` |
| `routineRunId` | Routine run id | Present when `origin` is `routine`; `agents sessions <runId>` resolves it |
| `timestamp` | Session start | ISO 8601 |
| `project` | Derived from `cwd` | Basename of the working directory |
| `cwd` | Recorded at spawn | Normalized absolute path |
| `gitBranch` | Recorded at spawn | `null` outside a repo |
| `topic` | First user prompt (truncated) | Best headline for a session |
| `label` | The session name — one field, several sources | Priority: agent-generated title / Claude `/rename`, else the launch handle seeded by `agents run --name <slug>` (interactive, headless, `--host`, or a teams teammate), else `null` (listing falls back to `topic`). `agents sessions <ref>` resolves against it. |
| `tokenCount` | Parsed from usage events | `null` for agents that don't log it |
| `costUsd` | Σ tokens × per-model price, at scan time | `null` when the model is unknown/unpriced; see `agents cost` |
| `durationMs` | `lastTs − firstTs` over timestamped events | `null` for single-event sessions |
| `isTeamOrigin` | Set when spawned by `agents teams` | JSONL `entrypoint: 'sdk-cli'` |
| `plan` | Last `ExitPlanMode` plan markdown (Claude sessions only) | `null` when the session never entered plan-review |

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
`Dirs:` line of directories touched.

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

# Show routine-run sessions, then open one by routine run id
agents sessions --routine --all
agents sessions 2026-07-21T10-30-00-000Z

# Sort the list by cost or duration (default: recent)
agents sessions --sort cost --limit 10
agents sessions --sort duration --all

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

**`--host` is the default cross-machine recall path.** Online machines are the norm,
so a live pull covers almost all recall with zero storage, zero lag, and no daemon —
always current, nothing to configure beyond SSH. The two mechanisms below are for the
cases a live pull can't reach: a machine that is **offline / asleep / decommissioned**.

- **Export / import (portable bundles)** — user-driven, no daemon. Bundle the sessions
  you want and carry them anywhere, or pull them off a peer in one command. This is the
  primary durable-archive / hand-off tool (below).
- **R2 + CRDT background sync** — an **opt-in beta, off by default**. A backup fabric for
  the "every machine's sessions show up automatically, even offline" case. Prefer
  on-demand `--host` reads and explicit export/import; reach for sync only when you want
  a passive always-on mirror (further below).

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

**Import placement reuses the sync mirror model verbatim.** Each session lands at
`~/.agents/.history/backups/<agent>/<origin-machine>/<subdir>/<relKey>` — the same
scan root cross-machine sync writes to — so imported sessions show up in
`agents sessions` tagged with their origin machine and **never overwrite your own
local sessions** ("local always wins" falls out of the scanner's live-home-first
dedup, no extra logic). Dedup is byte-exact: a bundle file identical to one already on
disk is skipped; a file that differs is a conflict, kept local unless `--overwrite`.
`--from-host` reuses the exact SSH transport as the cross-machine listing
(`resolveExplicitTargets` + `ssh-exec`) — no second transport, no R2, no daemon.
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

## Cross-machine sync (R2 + CRDT)

> **Opt-in beta, off by default — a backup fabric, not the primary recall path.**
> Prefer `--host` (live) and export/import (portable) above. Sync exists for the
> "sessions from an offline machine show up automatically in plain `agents sessions`"
> case; enable it only if you want that passive mirror.

`agents sessions sync` copies transcripts between your machines through a single
Cloudflare R2 bucket, so every machine's `agents sessions` list folds in the others'
sessions without any of them being reachable at query time (the offline-tolerant
counterpart to `--host`). Claude and Codex today; adding an agent is one entry in
`SYNC_AGENTS` (`src/lib/session/sync/agents.ts`).

```bash
agents sessions sync              # one cycle: push local changes, pull + merge peers'
agents sessions sync --verbose    # log each pushed / pulled session
agents sessions sync --status     # is auto-sync opted-in? are credentials configured?
agents sessions sync --setup      # provision the r2.backups bundle (guided)
agents sessions sync --enable     # opt in to background auto-sync (beta); --disable to stop
```

It is an **opt-in beta, off by default**. A bare `agents sessions sync` always forces
one manual cycle; the daemon only syncs on its own (~90s) once you
`agents beta enable session-sync` (aliased by `--enable`).

### How it converges

Each machine is the **single writer** of its own R2 prefix — no two machines ever write
the same object, so remote contention is impossible by construction:

```
sessions/<machine>/manifest.json               # what this machine holds (sessionId -> hash, size, lastTs)
sessions/<machine>/<agent>/<sessionId>.jsonl    # one object per transcript
```

**Push** walks this machine's live transcripts, skips the ones an on-disk ledger shows
unchanged (size + mtime), uploads the rest, then publishes the manifest.
**Pull** lists every *other* machine's prefix, reads their manifests, fetches the
transcripts they hold that this machine doesn't, and writes the result into a mirror
that is already a scan root:

```
~/.agents/.history/backups/<agent>/<machine>/<subdir>/<relKey>
```

The scanner indexes the mirror like any other session dir, and dedups by session id with
the **live home scanned first** — so a session you also have locally always wins; the
mirror only ever fills in sessions that originated elsewhere.

When the *same* session exists on more than one machine (you resumed it on two boxes), the
copies are merged as a **CRDT G-Set union**: a transcript is an append-only log of
immutable events, each event identified by the SHA-256 of its raw line bytes, so union is
associative, commutative, and idempotent — every machine derives byte-identical merged
output regardless of sync order, with zero conflict resolution and zero data loss
(`src/lib/session/sync/crdt.ts`). Identical/subset copies return verbatim (steady state
never rewrites unchanged files); only a true fork (each side holds lines the other lacks)
produces a reordered union, sorted by `(timestamp, hash)` so the result is deterministic
across machines. A machine that was **offline** re-pulls automatically when it returns: a
peer's manifest hash for a grown session no longer matches the puller's recorded
signature, so the session is re-fetched and re-merged.

### Encryption

Transcripts carry secrets, tokens, and absolute paths, so each object **body** is sealed
client-side with **AES-256-GCM** before it leaves the machine (`transcript-crypto.ts`).
The 32-byte key (`R2_SYNC_ENC_KEY`) lives in the same `r2.backups` bundle every synced
machine shares, and never reaches Cloudflare — the bucket only ever stores ciphertext.
The key is deliberately separate from the R2 access key so rotating the R2 token never
orphans already-encrypted transcripts. CRDT identity stays over **plaintext**: the
manifest hash is computed on the cleartext (a fresh random IV makes ciphertext
non-deterministic), and pull decrypts before the union sees any bytes. If the bundle
carries no key, sync still runs but uploads unencrypted and warns loudly once per cycle.

### Credentials

Credentials come from the `r2.backups` secrets bundle (OS keychain on macOS, libsecret /
encrypted file on Linux) — never from env or disk (`config.ts`):

| Key | Purpose |
|---|---|
| `R2_ACCOUNT_ID` | Cloudflare account (also derives the S3 endpoint) |
| `R2_BUCKET_NAME` | Target bucket |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 S3 API token — **Object Read & Write** (a read-only token pushes 403, pulls fine) |
| `R2_SYNC_ENC_KEY` | Shared 32-byte transcript key (hex or base64); auto-generated by `--setup` |

Resolution is memoized once per process, so the ~90s daemon loop never re-prompts a
biometry-gated keychain. `agents sessions sync --setup` provisions the bundle end to end,
generating the encryption key if absent.

## Schema Version

Schema version is currently `13` (`SCHEMA_VERSION` in
[`src/lib/session/db.ts`](../src/lib/session/db.ts)). Migrations run on connection
open; old DBs get upgraded in place. The `meta` table tracks `schema_version`.
Later migrations added, among others, `cost_usd` / `duration_ms` (pricing), the
work-signal columns `pr_url` / `pr_number` / `worktree_slug` / `ticket_id`, the
`plan` markdown, `output_tokens`, and `is_team_origin`. A migration that changes how
a column is derived forces a full rescan so every existing session is re-derived
(as the pricing columns once did).

## Related

- `agents logs [id]` — one viewer over both a run's log **and** its session transcript: resolves a host-dispatch task (`agents run --host`) or a session by id/`--session`, filters by `--host`/`--agent`/`--version`, and `-f` follows a live one (a session tail is `agents sessions tail` under the hood, claude/codex only). See [Hosts](hosts.md).
- `agents sessions <id> --artifacts` — list files created/modified in a session
- `agents teams status` — session state for team-coordinated runs
- `agents cloud logs <id>` — for remote cloud dispatches (different subsystem)
