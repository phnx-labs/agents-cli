# Observability

Using agents-cli as a programmatic observability layer for agent fleets.

`agents feed` and `agents mailboxes` share one fleet-comms visual language (masthead + glyphs from `comms-render`) so the two operator surfaces read as one product.

## Command roles at a glance

Five surfaces **read** the fleet's activity; each has one job. Reach for the one
whose *consumer* and *axis* match your question, not whichever you remember first.

| Command | Role (one line) | Source | Consumer |
|---|---|---|---|
| **`events`** | **The one timeline.** Ops (secrets, keychain, daemon, browser, computer, command.*, teams, …) + agent activity + run-dispatch outcomes (`run.dispatched`). Filter with `--include`/`--exclude` families (`ops`, `activity`, `commands`, `runs`, `security`). | dated `events/*.jsonl` + per-session `activity/*.jsonl`, merged by `readUnifiedEvents` | Audit, debugging, monitoring (human + machine) |
| **`audit`** | **Thin alias of `events --include runs`.** Legacy hash-chain file is verify-only for old history. | same events engine | Governance / quick run list |
| **`logs`** | **Thin alias of `events`.** Subcommands `audit`/`stats`/`rotate` re-dispatch. Content lives on `sessions` / `hosts logs`. | same events engine | Muscle-memory |
| **`perf`** | **Latency rollups.** p50/p99 for hooks, CLI commands, and `agent.run` timings. Indexed SQLite — not a full scan of the audit log. Not popularity, not behaviour. | `~/.agents/.cache/perf/perf.db` (disposable) | Humans optimizing boot/run cost + `--json` |
| **`insights`** | **How work looks — one verb, two engines.** Bare = behavioural report (transcript content, account split). `insights mix` / recipes = cheap counters (harness/model/token/secrets). Former top-level `agents trends` is a deprecated alias of the mix tree only. | behaviour: `sessions.db` + `session_insights`; mix: `sessions.db` + `usage.db` | Human + `--json` |
| **`feed`** / **`inbox`** | **Needs-you inbox + status posts.** Open blocks (decisions agents are waiting on) + `feed post` milestones. `inbox` ≡ `feed`. Scope with `--project`. | `.history/feed/*` + active sessions | Humans (operator inbox) + agents (progress) |
| **`timeline`** | **Progress stream only.** Alias of `feed --filter updates` — deliberate posts, not tool noise. | same as feed updates lane | Humans + `--json` |
| **`output`** | **Productivity accounting.** Token burn vs shipped output (PRs, commits) across agents — the "was it worth it" axis. (`agents cost` is the pure $-and-duration sibling.) | `sessions.db` + git/gh | Human + `--json` |
| **`sessions`** / **`roster`** | **Live agent roster + transcripts.** `roster` ≡ `sessions --active`. Browse/read past transcripts under `sessions`. `sessions stats` = skill/slash invocation leaderboard. | live pid/transcript probe + `sessions.db` | Human + `--json` |
| **`snapshot`** | **One-process poll.** Inventory + active sessions (+ optional feed/sync). Not `status` (sync-only). | view + active + optional feed | Machines / the ext |

### Why `insights` owns mix (and `trends` does not)

Two peer top-level names — `insights` and `trends` — both read as "analytics" and
agents (and humans) kept guessing which to use. They answered different questions
with different stores, but the surface taught the wrong model.

| Verb | Question | Engine |
|---|---|---|
| **`agents insights`** (bare) | How did work *look*? tools, friction, rhythm, edits — by account | Transcript content via `parseSession`, cached in `session_insights` |
| **`agents insights mix`** | What are the *counts*? harness/model mix, tools/session, secrets, browser | Cheap SQL on `sessions.db` + `usage.db` recipes |
| **`agents perf`** | How *slow* / sticky is the machinery? | Disposable `perf.db` samples from command.end / hooks / runs |
| **`agents usage`** | Live *quota* headroom right now | Provider rate-limit APIs |
| **`agents sessions stats`** | Which *skills/slash-commands* were explicitly invoked? | `session_resource_usage` index |

**Do not re-split mix into a peer top-level command.** Latency stays on `perf` so
it is never confused with popularity or behaviour. `agents trends` remains only as
a thin deprecated alias that prints one line and runs the mix tree
(`commands/trends.ts` → `lib/analytics/mix-commands.ts`).

### Observe aliases (Phase 3)

Thin second names for the product jobs — **no store merge**:

| Job | Alias | Real command |
|---|---|---|
| What needs me? | `agents inbox` | `agents feed` |
| What did agents post? | `agents timeline` | `agents feed --filter updates` |
| Who is live? | `agents roster` | `agents sessions --active` |

`agents audit` and `agents logs` **are** aliases of `events` (with default family filters). Do not re-introduce a second store or query path.

### Delivery vs record vs control (RUSH-2123)

Outbound names that look interchangeable are three different planes:

| Plane | Command | Job |
|---|---|---|
| **Deliver** | `agents send` / `agents notify` | Put a message in front of a recipient (`--to`, `--text`, `--channel`, `--attach`, `--url`). `notify` ≡ `send --to owner`; the owner destination is selected from `humans.yaml`. |
| **Record** | `agents feed post` | Append a status/milestone (and optional OpenBlock). May **forward** via `feed.broadcast` sinks that call `send`/`notify`. |
| **Observe** | `agents feed --filter updates` / `agents feed --filter all` | **Read** the activity stream — not a send path. |
| **Control** | `agents message` / `agents sessions inject` | Act on a running agent (mailbox answer vs terminal keystroke). Stay separate from `send`. |

```bash
# Deliver (flag-first envelope)
agents send --channel desktop --to local --text "deploy finished" --url https://example.com/pr/1
agents send --to owner --text "need a decision"
agents notify --text "same as send --to owner"

# Record (not deliver by itself) — title (subject) + body required
agents feed post --title "CHANGELOG pushed" "Watching CI and mac-mini E2E"
```

The write-stores: `~/.agents/.history/events/YYYY-MM-DD/events.jsonl`
(operational audit), per-session
`~/.agents/.history/activity/<id>.jsonl` (agent milestones), and the disposable
perf warehouse `~/.agents/.cache/perf/perf.db` (latency samples). Audit + activity
are merged at read time by `event-stream.ts::readUnifiedEvents`. Perf is a
separate SQLite file — **loss is acceptable** (under `.cache/`); it does **not**
foreign-key into `sessions.db`, but uses the same string shapes for
`session_id` / `session_short` / `agent` / `machine` / `actor` / `cwd` so you can
soft-join later.

**Writing from outside the CLI — `agents events emit`.** In-process code calls
`emit()` or `appendActivityEvent()` directly, but the producers that most need to
record events are not agents-cli processes at all (AGI EXT, the VS Code extension
host, a shell guard, any external tool). They pipe JSONL — one JSON object per
line — into `agents events emit --source <name>`:

```bash
printf '%s\n' '{"event":"factory.command","commandId":"agents.newClaude"}' \
  | agents events emit --source factory
agents events --module factory --limit 0 --json      # read it back
```

`--source` is stamped as `module`, which is what makes `--module factory` filter to
one producer. Which store a line lands in is **forced by the stores, not chosen**:
the activity log is one file per session, so a milestone kind routes there and
*requires* a `sessionId`, while everything else (and anything sessionless) goes to
the operational log. A milestone with no `sessionId` is **rejected**, never quietly
written elsewhere. Rejection is per line — one bad line never discards the batch —
and the exit code is 1 if any line was rejected.

Pass `ts` (ISO-8601) per line when the producer batches: without it every event in
a flush is stamped at flush time, which collapses their real ordering and corrupts
`--since` boundaries. `agents events emit` is itself exempt from the
`command.start`/`command.end` audit hooks, so a batched writer does not bury the
stream it is writing into.

For the inspection/health cluster, `agents doctor` is the canonical detector of
which resources are configured, synced, or drifted; `agents doctor --check` is its
scriptable CI gate (exit non-zero on drift). See
[§Fleet health & cross-device divergence](#fleet-health--cross-device-divergence-agents-doctor).

## Performance warehouse (`agents perf`)

Latency samples for optimization — **not** the audit log. Implementation:
`apps/cli/src/lib/perf/db.ts`, CLI: `apps/cli/src/commands/perf.ts`.

```
agents perf                              # summary: commands + hooks + runs
agents perf hooks                        # same as agents hooks profile (SQLite-first)
agents perf commands --days 30           # slowest CLI entrypoints
agents perf run --json                   # agent.run / perf.timing labels
agents perf hooks --project agents-cli   # scope to one repo's samples
agents perf friction                     # sessions stuck retrying the same guard block
```

| Producer | Kind | How it lands |
|---|---|---|
| CLI `postAction` | `command.end` | Direct `recordSample` (skips the `perf` command itself) |
| `createTimer` / `time` / `timeAsync` / `withTiming` | `perf.timing` | Best-effort from `events.ts`; also covers routine fires (`agent.run`) |
| Every hook | `hook.fire` | Generated shim → NDJSON spool → drained into SQLite on open. `cache:`, `matches:`, or a bare `matcher:` are each enough to opt a hook into a shim — git-guard/rm-guard/git-require-clean-tree (matcher-only) are instrumented like any other hook |

Every row carries `p50Ms`/`p95Ms`/`p99Ms`, and — when the underlying samples
have them — `errorRate`/`timeoutRate` (fractions 0-1, from a nonzero exit code
or a `status:'timeout'` sample). `--project <key>` scopes any subcommand to one
repository: it resolves each sample's recorded `cwd` to a project key
(`lib/project-key.ts` — a worktree cwd folds to the repo it branched from) and
filters to samples matching the given key.

`agents perf friction` reads a different sink: the `friction` event kind
(`emitFriction` in `events.ts`, fed by `agents _internal friction` — the
hidden command guard hooks self-report a block through before they exit 2,
since they run before any `agents` process exists to emit in-process). It
groups by (session, surface, failureId) and flags a session that hits the
*same* guard block 3+ times — an agent retrying the identical denied action
instead of adapting.

**Disable:** `AGENTS_DISABLE_PERF=1`. **Redirect (tests):** `AGENTS_PERF_DB`,
`AGENTS_PERF_SPOOL`, `AGENTS_PERF_DIR` (also covers the hook shim's own
timing/perf writes), plus `AGENTS_HOOK_SHIMS_DIR` / `AGENTS_HOOK_CACHE_DIR` /
`AGENTS_LOGS_DIR` for the shim-generation side. Retention: samples older than
30 days are pruned opportunistically on open. Wipe anytime:
`rm -rf ~/.agents/.cache/perf`.

## Counter mix (`agents insights mix`)

Resource and session **frequency** under the `insights` verb — **not** model quota
(`agents usage`) and **not** latency (`agents perf`). Implementation:
`apps/cli/src/lib/analytics/` (recipes + `mix-commands.ts`); CLI entry is
`apps/cli/src/commands/insights.ts` (registers the mix tree). The retired top-level
spelling `agents trends` is a thin deprecated alias in `commands/trends.ts` only.

```
agents insights mix                     # auto recipe board (skips empty sections)
agents insights mix --days 30           # window
agents insights harness-mix --json      # one baked recipe
agents insights query --kind secret     # raw warehouse rows
agents insights recipes                 # list recipe ids

# Deprecated alias (prints one line, same mix tree)
agents trends
agents trends harness-mix --json
```

| Store | Path | Holds |
|---|---|---|
| Session index | `sessions.db` | Harness/model mix, token ratios, per-session tool-call counts (`tool_scan_ledger.call_count`, written by the tool indexer) |
| Usage warehouse | `~/.agents/.history/analytics/usage.db` | Value-free `kind`/`name`/`event` rows (secret, agent, browser, …) |

Secrets usage previously lived only in `~/.agents/secrets/secrets.db`; the warehouse
migrates those rows once (`kind=secret`) and the secrets UI keeps reading through a
thin adapter. New emitters: secret access paths, `agents run`, browser launch/close.

**Disable:** `AGENTS_NO_USAGE_TRACK=1`. **Redirect (tests):** `AGENTS_USAGE_DB`,
`AGENTS_SESSIONS_DB`. Retention: usage events older than 90 days are pruned on open.

## Audit Event Log (`agents events`)

Separate from the fleet-state sources below (which answer "what's running *now*"),
the **audit event log** answers "who did what, and from where". Every
`agents <module> <command>` invocation is recorded — team create/disband, agent
run, secrets access, version installs — as a structured JSONL line at
`~/.agents/.history/events/YYYY-MM-DD/events.jsonl` (directories `0700`, files
`0600`). Each local calendar day has its own directory. At 10 MiB that day's
active file rotates losslessly to `events.1.jsonl.gz`; older segments shift to
`events.2.jsonl.gz`, `events.3.jsonl.gz`, and so on. Automatic cleanup keeps at
most seven days and 50 MiB per machine. `agents events rotate --days <n> --max-mb <n>` applies both limits immediately.

`agents events` is the canonical reader. `agents logs` and `agents audit` are thin aliases (same handler, default family filters).

The recording is a single choke point — a commander `preAction`/`postAction`
hook on the root program ([`src/index.ts`](../src/index.ts)) emits `command.start`
/ `command.end` for *every* subcommand, so coverage is automatic and no per-command
wiring can drift out of date. `command.end` also feeds the disposable perf
warehouse (`agents perf`) with the resolved sessionId/agent, not just
duration — the same provenance floor `emit()` stamps on the audit record.
Richer typed events (`secrets.get`, `version.install`,
`teams.create`, `teams.disband`, …) layer on top where the extra payload earns it —
e.g. team lifecycle events are emitted at the registry source with the team name,
so they fire for every path (`teams create` and the auto-create in `teams add`).
`browser.navigate`/`browser.screenshot` (every `agents browser` navigate/
screenshot) and `computer.action` (every `agents computer` verb — click, type,
key, drag, scroll, launch, screenshot, …) are two more: `query()`/`readUnifiedEvents()`
accept a `sessionId` filter so a consumer can ask "did session X touch the
browser/computer" as a scoped read instead of grepping the whole log — this is
what the sessions index's `usedBrowser`/`usedComputer` columns are built on
(see [sessions.md](sessions.md)).

Every record carries **attribution** computed once per process
([`src/lib/events.ts`](../src/lib/events.ts)):

- `osUser` — the OS account that ran it.
- `transport` — `local`, or `ssh` when `$SSH_CONNECTION` is present.
- `sshClientIp` — the remote client IP when over SSH.
- `caller` — `claude-code`, an ext terminal agent (`claude`, `codex`,
  `gemini`, `cursor`, …), `terminal`, or `script`.
- `session` — the short ext session id when one is present.

So "was this agent started on the host by a remote user?" is answerable for any
event, not just runs. The write is a synchronous single-line append (durable
before the action proceeds); `AGENTS_DISABLE_EVENT_LOG=1` turns it off.

`agents sessions --active` carries the same SSH origin on each live session's
`provenance` (including tmux-hosted panes, whose launch env is read from the pane
process) and resolves the client IP against the device registry into
`provenance.origin` (`{ device, user? }`). The row then reads `ssh←<device>`
(e.g. `ssh←zion`) instead of a bare `ssh`, so "which box launched this session"
is answerable without scraping `ps`/`who`/`tailscale`. An IP that matches no
registered device stays bare `ssh` — the raw `provenance.ssh.clientIp` is still
present.

### Actor provenance — which *human* is behind a run

`osUser` answers "which OS account", but on a shared fleet that is one account for
everyone. The **actor** layer ([`src/lib/actor.ts`](../src/lib/actor.ts)) answers
"which *person*". `resolveActor()` runs once per process:

- **Over SSH** it `tailscale whois`es the client IP to the connecting tailnet
  identity — a real name and login email.
- **Locally** (no `$SSH_CONNECTION`) it stays honest: `UNRESOLVED@<host>`, claiming
  no personal identity rather than guessing the box owner.
- **Inherited** — a child spawn trusts the `AGENTS_ACTOR*` env its parent stamped
  instead of re-resolving, so the whole spawn tree shares one actor.
- **Dispatched over SSH (outbound)** — when the CLI runs an agent on another host
  (`agents run --host`, `agents ssh <host>`, or a remote teammate), the resolved actor is
  forwarded into the remote invocation's env, so the remote box inherits it instead of
  re-resolving. Without this the actor is dropped at the SSH hop and the remote
  `tailscale whois`es the *originating* box's IP — mis-crediting the shared fleet account
  rather than the human who launched the run.

The resolved actor rides the agent's process env (`AGENTS_ACTOR`,
`AGENTS_ACTOR_KIND`, and `AGENTS_ACTOR_NAME`/`_EMAIL`/`_GITHUB` when known). For a
resolved **human**, that env also carries `GIT_AUTHOR_*` / `GIT_COMMITTER_*`, so the
agent's own `git commit` is credited to the person, not the shared account. An
unresolved actor injects no git identity — local runs keep their ambient git config.

The optional `actors:` map in `agents.yaml` enriches or overrides a resolved
identity, keyed by a short slug:

```yaml
actors:
  bisma:
    login: bisma@example.com   # tailnet login to match (defaults to the key)
    name: Bisma Ansari
    email: bisma@company.com    # pin a preferred git email
    github: bisma
```

#### Surfacing the owner

The resolved actor is stamped at spawn and read back so you can see *who* launched
each run, not just *what* is running:

- **`agents sessions --active`** shows an **owner** column — the actor's short id
  (an email's local-part, or `-` when the run is unresolved-local). It is stamped
  into the per-pid registry (`writePidSessionEntry`) at launch and onto each
  teammate record, so a co-located fleet no longer collapses to one anonymous
  account. `--active --json` carries the raw `owner` field for a consumer to join on.
- **The session index** (`sessions.db`) carries `actor` and `initiated_by`
  (`human`/`agent`) columns, so the durable `agents sessions` listing attributes
  historical sessions to a person, not just the live `--active` view. The upsert
  fills them with `COALESCE(existing, incoming)`: a stored owner is never clobbered
  (a content rescan carries no actor, so the stored value wins), yet a row that was
  indexed **before** its actor sidecar existed — an older scanner, or any scan that
  raced ahead of the spawn-time sidecar write — still gets **backfilled** once the
  join finally provides one. (Plain exclusion locked those rows to `NULL` forever.)
- **How the index gets the actor** — the transcript on disk records no actor, so at
  spawn each run also writes a small **durable `sessionId -> actor` sidecar** under
  `~/.agents/.history/by-session/` (unlike the pid-registry, this survives the
  process). The scanner joins it as it indexes, filling the columns above; the same
  sidecar is the fallback for the live `--active` **owner** when the per-pid entry
  (rewritten by the SessionStart hook without an actor) has none. Teammates
  inherit the orchestrator's frozen actor, so a whole team traces back to the one
  human who started it; their records also carry a `parent_session_id` (the
  orchestrator's session) so the spawn chain is walkable.
- **Beyond sessions — events, routines, and browser tasks carry the actor too.**
  Every emitted **event** records `actor` + `kind` (via the audit origin), so
  `agents events` and its stats group by who did it (a `byActor` breakdown). A
  **routine** stamps its creator's actor id at creation and seeds it into each fired
  run's env (`AGENTS_ACTOR`), so an unattended cron's session and events attribute to
  the person who scheduled it (not the `UNRESOLVED@<host>` a live resolve would give)
  rather than the local box; its run records carry `actor` (the creator) and
  `triggeredBy` (who kicked off that specific run). Only the actor *id* rides along —
  the creator's git name/email are not stored, so git-author credit is out of scope
  for scheduled runs. A **browser task** records the `owner` who launched it, on the
  live task and in history.

```bash
agents events                          # recent activity across everything
agents events --module teams           # team lifecycle (create / add / disband)
agents events --module secrets         # every secret accessed, revealed, or unlocked
agents events --module secrets --bundle share   # every read of the share bundle (which agent/session)
agents events --bundle share --session <id>     # trace one session's reads of a bundle
agents events --command "teams create" # a command path — prefix match
agents events --event teams.disband    # a semantic event: a team torn down
agents events --event secrets.get --since 7d --json
agents events --event pr.opened --since 30d --limit 0 --json   # every match, uncapped
agents events -f                       # live tail of today's log
agents events --module factory         # what the VS Code extension recorded
agents events emit --source factory --json < batch.jsonl        # write from outside
```

`--module` filters the top-level group; `--command` matches a command path by
prefix (`teams` catches `teams create`); `--event` filters a typed event
(repeatable); `--agent` filters by tagged agent; `--session <id>` filters by the
provenance session id (every event carries it), and `--bundle <name>` filters by
the bundle in an event's payload — so `--module secrets --bundle share --session
<id>` traces exactly which agent/session read a secrets bundle (the answer to
"which agent triggered that Touch ID sheet"). `--since` takes `2h`/`7d`/`4w` or an
ISO date. `--json` emits the
raw records for external consumers.

**`--limit` caps the read at 50 records by default — pass `--limit 0` before you
aggregate.** The cap keeps an interactive `agents events` readable, but it is
applied *after* filtering and *before* you see the records, so a group-by over a
capped `--json` read ranks the newest 50 rather than the real set. That
filter-before-cap contract covers both halves of the unified stream: operational
events (and their `bundle` / module filters) and agent-semantic activity events
(`--event` / event-type filters are pushed into the activity reader so a rare
match is not buried under routine `file.edited` churn — RUSH-2093). On a 30-day
stream here that is 50 records out of 29,649. When a read is capped, the command
says so — on stderr for `--json` (so a `| jq` pipeline still gets clean JSON), on
stdout for the human view:

```
Showing the newest 50 — more events matched. Pass --limit 0 for all.
```

A non-numeric, negative, or empty `--limit` is rejected with exit 2 rather than
silently falling back to 50. Empty counts: `--limit "$LIMIT"` with an unset
variable is a scripting mistake, not a request for the whole stream.

**Every secret access AND unlock is audited at the read, not just at the command.**
`agents events --module secrets` surfaces two typed events:

- **`secrets.get`** — a secret VALUE was resolved out of a bundle. Every path
  emits it: `run --secrets`, `secrets exec`/`export`, the MCP `get_secret` tool,
  `secrets view --reveal`, the raw `secrets get <item>`, `secrets push` (which
  reads the whole bundle to upload it), and remote `bundle@host` resolves. (Value
  reads in adjacent subsystems that don't go through the bundle resolver — e.g.
  `wallet`, profile auth tokens — are not part of this `secrets.*` stream.)
- **`secrets.unlocked`** — `agents secrets unlock <bundle>` granted the bundle into
  the secrets broker (and the durable session), so it then reads prompt-free for
  the grant TTL. This records the longer-lived grant a per-read `secrets.get` does
  not, carrying `ttlMs` and the `agent` scope (`*` = a global grant).

Both are audit-level and **not** milestones, so they land in `agents events` and
the persisted audit log without cluttering the curated `agents activity` /
`agents feed`. Every record carries a `source` telling you HOW it was read or
granted — `keychain` (real Touch-ID read), `agent` (served from the unlocked
broker), `session` (durable snapshot after a restart), `reveal`, `raw-item`,
`sync-push`, `remote` (with the `host`), `broker`/`broker+durable` (an unlock
grant) — plus the `bundle`, `agent` (the resolving harness scope), `caller`,
`keyCount`, key NAMES, and OS-user/host/session/transport. The resolved **value is
never written to the log** — only names and counts. Note the event log has a
7-day retention (older daily files are pruned), so export what you need for
long-term records.

### Event timeline filters and aliases

```bash
agents events                              # full stream
agents events --exclude commands           # drop command.start/end noise
agents events --include ops                # operational only
agents events --include runs               # dispatched-run outcomes
agents events --include security           # audit-level (secrets, daemon, …)
agents events --module secrets --bundle share
agents events -f                           # live tail
agents events stats [--since 7d]
agents events rotate [--days 7] [--max-mb 50]

# Thin aliases (same engine)
agents audit                               # ≡ events --include runs
agents logs                                # ≡ events
agents logs audit                          # ≡ events --include ops
agents logs stats                          # ≡ events stats
agents logs rotate                         # ≡ events rotate
```

Session transcripts and host-task stdout are **not** the events product:

```bash
agents sessions <id>
agents hosts logs <task-id>
```

```

The `query()` API reads every dated active JSONL file and numbered gzip segment
transparently.

External tools (dashboards, voice assistants, CI runners, monitoring) can read
fleet state via canonical `--json` sources. Prefer **`agents snapshot --json`** when
you need inventory + active sessions in one process; keep `agents status --json` for
sync drift only. No direct DB access, no re-parsing of agent-specific formats, no auth
to manage.

## Fleet health & cross-device divergence (`agents doctor`)

Three diagnostics with distinct scopes (RUSH-2027):

- `agents fleet status` — coarse **device** health: online/offline, which agent
  CLIs are installed, sign-in, agents-cli **version skew**, and **how many agents
  are running** on each box. Not fine-grained resource divergence. Device stats and
  agent counts are **publish-own / read-union** (RUSH-2061): each daemon probes
  only itself (no ssh) and publishes its own row — resource stats + live-agent
  workload — to a local mirror (`~/.agents/.cache/.fleet-status.json`,
  [`src/lib/fleet-status.ts`](../src/lib/fleet-status.ts)); the command unions
  peers' rows on demand, cache-first, ssh-reading a stale/missing peer via
  `agents fleet status --local --json` through a bounded, kill-on-timeout fan-out.

- `agents snapshot` — **one-process consumer poll** for install inventory + active sessions
  (optional feed / sync). Replaces the N× `view --json` + `sessions --active --json` fork
  storm. Default sessions scope is this machine; `--all-hosts` matches full active fan-out.
  JSON contract: `FleetSnapshot` version 1 (`inventory`, `sessions`, `agents`, optional
  `feed` / `sync`). Does **not** replace `agents status` (UnifiedSyncStatus / drift).

  The daemon no longer force-probes every device every 3 minutes (the old N² ssh
  fan-out and orphaned-probe pile-up, RUSH-2114).
- `agents inspect <agent>[@version]` — deep **single-harness** diff between one
  version home and its resolved sources (staleness, orphans).
- `agents doctor` — the **umbrella**: local diagnostics (CLI presence, sign-in,
  per-version sync, orphans) **and**, with `--devices`, cross-device divergence.

`agents doctor` is the human report; `agents doctor --check` is the machine gate —
same drift engine (`computeDrift`), different output. `--check` exits non-zero when
any installed version is stale or never-synced (orphans are informational, never a
failure), zero when clean; add `--json` for a scriptable payload, `--quiet` for just
the verdict line, and `--devices` to gate the whole fleet:

```bash
agents doctor --check            # exit 1 on drift, 0 if clean
agents doctor --check --quiet    # just the one-line verdict
agents doctor --check --json     # machine-readable, for CI
agents doctor --check --devices  # gate every registered device
```

> The former standalone `agents check` (the CI gate) and `agents resources` (the
> merged cross-layer resource table) are gone: `check` is now `doctor --check`, and
> the merged table is now [`agents view --merged`](concepts.md). One command per
> responsibility, no overlap.

### Prioritized findings (bare `agents doctor`, RUSH-2069)

The bare `agents doctor` (no target) is a **prioritized, comprehensive-by-default**
readout — there is no `--verbose`. It is a two-part hybrid:

1. **`✗ CRITICAL — needs you now (N)`** — every critical finding across the whole
   fleet, worst-first. Each line reads
   `device · harness@version · account · message → remediation`, so a healthy
   machine can never bury a critical.
2. **`─── by computer ───`** — one block per device (worst device first): that
   machine's WARNINGS, plus a compact **accounts/versions line** listing every
   installed version and its account, provable ✓ / ✗. A device that has criticals
   carries a `✗ N critical (above)` marker (the criticals themselves stay at the
   top).

A single-machine `agents doctor` (no `--devices`) collapses to the CRITICAL
section, then one `▸ <machine>` block:

```
agents doctor · zion                                        1.20.81

✗ CRITICAL — needs you now  (2)
  codex @0.1            logged out — no account signed in                    → agents run codex@0.1 -- login
  grok @0.2.82          32 hooks missing (incl. 'git-guard', 'rm-guard')      → agents doctor grok@0.2.82 --fix

▸ zion · this machine  ✗ 2 critical (above)
    ⚠ claude (5 versions)  plugin 'code' — mirror missing → agents doctor claude --fix
    ⚠ ~/.agents (user)     6 behind origin/main → stales 7 versions → agents repo pull user
    ⚠ orphans              397 orphaned resources on 12 versions (cleanup only) → agents prune cleanup --all
    claude 2.1.170 ✓me@x.com (Max) 2.1.999 ✓team (Team) · codex ✗ · grok ✓ · kimi ✓
```

**Severity rubric** (agent-agnostic):

- **CRITICAL** (`✗`) — `logged-out` (provable), `missing-hook`,
  `missing-plugin`, `unwired-hook`, `hook-runtime-broken`, `cli-missing`, `ssh-key-enrollment`, `owner-sink-unreachable`. These
  block the harness now, or (owner-sink-unreachable) mean this box cannot escalate
  a blocked agent to the owner.
- **WARNING** (`⚠`) — `logout-unprovable`, `missing-resource`, `content-drift`,
  `never-synced`, `stale`, `repo-behind`, `repo-drift`, `version-skew`,
  `fleet-resource-gap`, `hook-runtime-visibility-unavailable`, `orphan`, `duplicate-hook`, `duplicate-hook-drift`,
  `host-cli-missing`, `host-cli-invalid`, `rc-secret-export`, `env-secret-export`, `exec-policy`,
  `stale-cli`, `binary-shadow`. Most are resolvable by a routine sync or cleanup;
  `hook-runtime-visibility-unavailable` requires upgrading agents-cli on the
  reporting device.

RUSH-2162 moved `never-synced` and `duplicate-hook-drift` from critical to
warning: both are stale-sync states one `agents sync` resolves, not "needs you
now". `FINDING_SEVERITY` in `src/lib/devices/doctor-findings.ts` is the source of
truth for this list, and a test asserts this rubric agrees with it.

`owner-sink-unreachable` (RUSH-2262) is critical because a factory that cannot
escalate a blocked agent to the owner is not healthy, and that failure is
otherwise silent until a block is filed. `agents doctor` probes the same
owner-delivery lane `agents notify` / `agents feed post --level important` uses,
from the same context it runs in: the rush-backed owner channel (iMessage) can
only deliver when `rush` is both on PATH and holds a usable, keychain-bound
session HERE. So a headless Linux box (no rush) or a non-GUI SSH session on a mac
(login keychain locked) reports the critical — the case a GUI session hides. The
probe reads `rush whoami`, never `~/.rush/user.yaml` (the token is a keychain
item, not that file), and `agents notify --dry-run` is NOT this check: it
short-circuits before the `which rush` preflight, so it reports success on a box
with no rush at all. The finding is per-box, surfaced wherever `agents doctor`
runs (each box self-reports it in its own `--json`); `--devices` shows it for the
box you invoke it on, not recomputed for remotes.

**One root cause is one line.** The readout is de-duplicated before it is
rendered, so a real machine shows ~16 rows rather than ~57:

| Repetition | What you see instead |
|---|---|
| One row per missing resource | `32 hooks missing (incl. 'a', 'b')` — a lone one is still named in full |
| The same problem on 5 installed claudes | `claude (5 versions) …`, fixed by the agent-wide `agents doctor claude --fix` |
| One orphan row per version | one `orphans` line per machine — `agents prune cleanup --all` clears them all |
| One row per hook duplicated across version homes | one row per (agent, severity) — `agents sync <agent>@all --yes` reconciles them all |
| `sources changed since last sync` on a version that already listed its drift | nothing — the specific row already said it |
| One row per absent resource on a never-synced version | one warning → `agents sync <agent>@<version> --yes` |

An **isolated** version never folds into a collapsed row: the agent-wide `--fix`
sweep deliberately skips isolated copies, so it keeps its own
`agents doctor <agent>@<version> --fix` line.

**Per-version sign-in.** Sign-in is probed per **installed version**, not
account-global: each version's own home is read, and a logged-out state is only
claimed as CRITICAL when it is **provable** — the credential is absent from BOTH the
version home AND the active/global HOME (`credentialPresence` in
`src/lib/agents.ts`). A version that merely shares the global login is signed in,
not out. Agents with no inspectable identity (`!supportsAccountInspection`) never
yield a logged-out finding; the ones with a known credential path in
`CREDENTIAL_FILE_SEGMENTS` do. The membership of those two sets lives in
`src/lib/agents.ts` and changes as harnesses gain inspectable credentials, so it is
deliberately not enumerated here. The login
remediation is version-targeted, and it has to run INSIDE that version's home — a
bare `codex login` afterwards resolves through the shim to the project/default
version, so it would log into the wrong one. For the per-version-isolated set it is
therefore `agents run <agent>@<version> -- <login subcommand>` (`-- login` for
codex/grok, `-- auth login` for opencode), `agents run claude@<version>, then
/login` for claude (its login lives in the TUI), and a bare
`agents run <agent>@<version>` where the device flow starts on launch.
gemini/antigravity/droid/cursor have no per-version isolation, so the fix says the
login is shared rather than faking a per-version repair. A logout row is never
collapsed across versions — there is no `@all` for a login.

`--json` carries a `findings` array (severity/kind/device/agent/version/account/
message/remediation) plus a per-version `fleet.signIn` map; the existing
`clis`/`sync`/`orphans`/`health`/`fleet`/`signIn`/`repos` fields are unchanged, so
menubar and `ssh.ts`'s `RemoteDoctorJson` consumers keep working. Source:
`src/lib/devices/doctor-findings.ts` (findings model, builders, `remediationFor`,
`renderFindings`), `src/lib/devices/fleet-inventory.ts`
(`collectLocalFleetInventory` / `collectLocalFleetSignIn`),
`src/lib/agents.ts` (`credentialPresence`), `src/commands/doctor.ts`.

### Triaged health block (target report)

The target report `agents doctor <agent>[@version]` still leads with a **triaged
health block** — the verdict, ranked by severity, so the reader sees what is
unhealthy, why it matters, and the exact fix. A clean install collapses to one
green line:

```
Claude@2.1.220
  ✓ healthy — 34 resources reconciled · hooks wired · sources current
```

Otherwise a severity-counted header is followed by one row per finding (icon ·
severity · subject — impact, then the exact fix) and a heal footer when anything is
`--fix`-able. `--json` carries a `verdict` field with
`severity`/`category`/`subject`/`impact`/`fix` per issue. Source:
`src/commands/doctor.ts` (`computeVerdict`, `healthBlockLines`).

### `agents doctor --devices`

The fleet view renders the same RUSH-2069 hybrid across every registered device: a
top CRITICAL section spanning all boxes, then a `─── by computer ───` block per
device (worst-first) with its warnings, a `✗ N critical (above)` marker, and its
accounts/versions line. Findings come from:

- **Local** — the per-version resource reports + sync/orphan/repo-behind + sign-in.
- **Remote** — each box's self-reported inventory (per-version sign-in) folded to
  logged-out findings, plus **cross-device divergence**: an agent version present
  elsewhere but absent here (version-skew), a diverged `.agents`/`.system` config
  repo (repo-drift), or a resource present elsewhere but missing here. A remote on
  an **older CLI** that can't report per-version sign-in emits an
  "older agents-cli — can't report per-version sign-in → upgrade" warning so the
  readout stays honest; an unreachable box surfaces as a warning, never a silent
  drop.

It is **read-only**: it never installs or syncs.

```bash
agents doctor --devices          # the hybrid critical-at-top + per-computer view
agents doctor --devices --json   # { devices: [...], fleet: { divergences: [...] } }
```

Each device's top-level `agents doctor --json` emits a `fleet` inventory field
(installed resources per kind, installed versions per agent, repo state, and
per-version sign-in), so the comparison needs no extra probe. `agents fleet status`
reuses the same comparator to add a per-device divergence line to its rollup.
Source: `src/lib/devices/fleet-divergence.ts` (pure comparator),
`src/lib/devices/fleet-inventory.ts` (`collectLocalFleetInventory`),
`src/lib/devices/doctor-findings.ts` (`fleetDivergenceToFindings`,
`signInToFindings`, `renderFindings`), `src/commands/doctor.ts`
(`runDevicesDoctor`).

## Three Sources, One Fleet

```
                        Agent Fleet
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
    Local sessions      Cloud dispatches    Team DAGs
    (on this laptop)    (remote VMs)        (coordinated runs)
         │                   │                   │
         ▼                   ▼                   ▼
  agents sessions      agents cloud list   agents teams list
      --json                --json              --json
         │                   │                   │
         └───────────────────┴───────────────────┘
                             │
                             ▼
                   External consumer joins
                   by sessionId / cwd / task_name
```

Each source answers a different question:

| Source | Question | Coverage | Misses |
|---|---|---|---|
| `agents sessions --json` | What local CLI and team-spawned agents have run recently? | The `SESSION_AGENTS` harnesses on this laptop (Claude, Codex, Gemini, Antigravity, OpenCode, OpenClaw, Rush, Hermes, Grok, Kimi, Droid, Cursor) | Pure-cloud runs with no local file |
| `agents cloud list --json` | What am I running on remote VMs right now? | Rush Cloud, Codex Cloud, Factory | Local sessions |
| `agents teams list --json` | What multi-agent DAGs are active? | All team-coordinated runs | Standalone agents |

`agents sessions --active --json` includes `attachments` for prompt-side
screenshots and files when the source transcript carries a local path. Each entry
contains `path`, `name`, `mediaType`, and `sizeBytes` so consumers such as the ext
can render thumbnails and open the original attachment without re-reading the raw
agent transcript.

Every row also carries flat top-level `ticketId`, `project`, and `prLink` keys —
always present, `null` when unknown — so a watcher can join active sessions on
ticket and project or open the linked pull request without reaching into nested
objects. `project` is the basename of the session's cwd, the same derivation the
historical `--json` listing uses, so the active and recent views join identically.

Some sessions appear in multiple sources:

- **Local CLI**: `sessions` only
- **`agents teams add`**: `sessions` (with `isTeamOrigin: true`) + `teams`
- **`agents cloud run`**: `cloud` only
- **`agents teams add --cloud`**: `teams` + `cloud`

## Join Keys

```
sessions.id        ↔  cloud.id           (when a team spawns a cloud teammate)
sessions.cwd       ↔  teams.workspace_dir (when a team runs local)
teams.task_name    ↔  sessions.teamOrigin.handle
```

Use these to build a unified view. Two common patterns:

### "What's running on this project?"
```bash
CWD=$(pwd)
agents sessions --json --all --since 2h | \
  jq "[.[] | select(.cwd == \"$CWD\")]"
```

### "What's running anywhere?"
```bash
# Three calls in parallel, merged by consumer
agents sessions --json --all --since 2h &
agents cloud list --json &
agents teams list --json &
wait
```

## Patterns for External Consumers

### Polling (dashboards)

```ts
setInterval(async () => {
  const [local, cloud, teams] = await Promise.all([
    exec('agents sessions --json --all --since 10m --limit 50'),
    exec('agents cloud list --json'),
    exec('agents teams list --json'),
  ]);
  updateDashboard({ local, cloud, teams });
}, 5_000);
```

### On-demand (voice, chat, LLM tools)

```ts
// Called each time the user asks a question
async function briefing() {
  return Promise.all([
    exec('agents sessions --json --all --since 2h --limit 30'),
    exec('agents cloud list --json'),
    exec('agents teams list --json'),
  ]);
}
```

### Alerting (CI, monitoring)

```bash
# Alert if any cloud task has been stuck > 30 minutes
agents cloud list --json | jq '.[] | select(.status == "running")' | \
  your-alerting-tool
```

### Deep trace (debugging one session)

```bash
# Get the full normalized event array for one session
agents sessions <id> --json --last 50 --include tools,assistant

# Or as markdown for human reading
agents sessions <id> --markdown
```

## Fleet comms (`agents mailboxes`)

The three sources above tell you what agents are running; `agents mailboxes`
shows what they are **saying to each other**. Every `agents message` /
`agents teams message` / feed answer rides the mailbox spool
(`~/.agents/.history/mailbox/<id>/{inbox,processing,consumed}`) — one box per
logical agent. `agents mailboxes` (alias `agents mailbox`) is the read-only
window onto it, including already-`consumed` (delivered) mail, so agent-to-agent
chatter is visible after the fact.

```bash
agents mailboxes                 # masthead + 24h sparkline + boxes + recent cross-box log
agents mailboxes <id>            # one box in full, across all three buckets
agents mailboxes --watch         # live tail of cross-box traffic until Ctrl-C
agents mailboxes --between a b   # one relationship as a thread, either direction
agents mailboxes --graph         # who-talks-to-whom adjacency, busiest first
agents mailboxes gc              # one-shot liveness sweep of pending messages
```

The overview opens with a `fleet comms` masthead (`N live · M boxes`, total
messages, messages still awaiting delivery, last activity) and a 24-hour
hourly-volume sparkline, then one row per box (live dot, pending/total counts,
last activity, resolved live-session label), then the recency-ordered message
log.

### Delivery TTL and automatic reap

Messages carry a delivery TTL. If a message is not consumed before the TTL, it
is archived as `dropped: expired` rather than pending forever. The default TTL
is **24 hours** (chosen because agents can be long-running). You can override it
per message with `--ttl`:

```bash
agents message <target> "keep going" --ttl 2h
agents message <target> "never expire" --ttl 0
```

The default also honors the `AGENTS_MAILBOX_TTL` environment variable
(e.g. `AGENTS_MAILBOX_TTL=12h`).

A background sweep runs on every watchdog tick (`agents watchdog` daemon
routine), using the same live-session set as `agents sessions --active` to
classify boxes. Dead boxes have their pending mail archived as `dropped: dead`,
and stale consumed entries are pruned after 24 hours. You can run the sweep
manually:

```bash
agents mailboxes gc          # human summary
agents mailboxes gc --json   # machine-readable GcResult
```

### Bounce receipts

When a message is dropped (dead box or TTL expiry) and it was tied to a feed
block, a failure receipt is written to the block: `status: dropped` for a dead
box, `status: expired` for TTL expiry. This surfaces the bounce in the feed
store instead of leaving the sender with silence. Receipts are monotonic: a
`queued` receipt can be overwritten by `consumed`/`continued` or a failure
receipt, but a failure receipt does not regress. Dead blocks that receive bounce
receipts are kept for 24 hours so the failure is visible, then removed by the
next sweep.

## Agent feed (`agents feed`)

`agents feed` lists decisions agents need from the operator. The default order is
cost-of-delay rank, not chronology: idle minutes × downstream blast radius ×
hourly burn × ask irreducibility. Suppressed stalls and FYIs get zero
irreducibility, so a fresh cheap ask does not outrank an old critical-path block.

`--filter <view>` selects what the surface shows:

```bash
agents feed                              # needs (default): open blocks — decisions agents wait on
agents feed --filter updates             # only deliberate progress posts (see Status posts below)
agents feed --filter all                 # blocks first, then the updates view appended
agents feed --project agents-cli         # scope blocks + updates to one repo/project
agents feed --filter updates --project agents-cli  # project's progress posts only
```

`--filter updates` skips the block pipeline (no stall suppression, no dispatch
policy) but keeps the same SSH fan-out the block view uses — an agent posts on
whichever box ran it, so the fleet's posts merge into one recency-ordered list.
`-H/--host` (alias `--device`) scopes it to named machines; `--local` (or
`AGENTS_FEED_LOCAL=1`) keeps it to this box. Its `--json` emits the raw
`status.posted` events.

`--project <name>` scopes every part of the feed — open blocks, the updates view,
and the trailing activity lane — to one repo/project. It matches the worktree-aware
project key (`lib/project-key.ts`), so a worktree under `<repo>/.agents/worktrees/`
folds back into `<repo>`. Filtering is done locally after the fleet fan-out, so
older peers that do not recognize the flag still contribute their full payload and
the requesting box narrows it. The masthead reads `<project> needs you` / `<project>
updates` when a project is set.

The `limit` on this view counts **posts**, not raw events: the event filter is
pushed into `readRecentActivity` (`events` / `tier` options) rather than applied
to an already-sliced window. Slicing first meant a busy box's routine
`file.edited` churn filled the whole slice and the view rendered "0 posts" while
real posts sat in the log.

### What publishes a block

Blocks are written by the `feed-publish` hook (`~/.agents/hooks/10-feed-publish.py`,
installed by `ensureFeedPublishHook`), registered for every hooks-capable agent:

- **AskUserQuestion** (`PreToolUse`) — the structured multiple-choice ask.
- **Waiting notifications** (`Notification`: `permission_prompt` / `idle_prompt` /
  `elicitation_dialog`) — Claude's permission/idle prompts.
- **Codex approval prompts** (`PermissionRequest`) — Codex emits `PermissionRequest`
  (not Claude's `Notification`) when it blocks on an approval. The hook publishes an
  **approval-class** block with `costOfDelay: high` and `safeDefault: deny`, so a
  blocked headless/remote Codex agent surfaces on the feed and `agents feed --dispatch`
  pages the phone as urgent (RUSH-2039). The Codex approval card is cleared once the
  approved tool runs (`PostToolUse`) or the session ends.

The block is cleared on answer (`PostToolUse` for AskUserQuestion, or `UserPromptSubmit`
in the TUI) and on session lifecycle (`Stop` / `SessionEnd`). A **Codex** approval card
additionally clears as soon as the next tool runs — this is a matcher-less `PostToolUse`
clear hook registered **for Codex only** (`feed-clear-permission`). Claude registers no
matcher-less `PostToolUse` clear, so its `permission_prompt` / `idle_prompt` /
`elicitation_dialog` notification cards persist until `Stop` / `SessionEnd` (and its only
`PostToolUse` feed hook, `feed-clear-answered`, stays matcher-scoped to `AskUserQuestion`).

The same poll also synthesizes control cards for sessions that are burning
abnormally without asking (`runaway`) or asking repeatedly (`needy`). Control
cards are one row per session, with local controls:

```bash
agents feed --pause <id>   # SIGSTOP a local process; cloud tasks are cancelled
agents feed --kill <id>    # SIGTERM a local process; cloud tasks are cancelled
```

### Status posts (`agents feed post`) — agent progress, not “needs you”

Agents can deliberately announce progress without opening a feed block. Every
post has a **title** (short subject, ~4–5 words — the phone first line) and a
**body** (what happened / the ask). Session/agent/host/runtime/pid identity is
stamped automatically from the process env, launch-matched activity, and the
per-pid launch registry (`lib/session/pid-registry.ts`), and rides the outbound
`{message}` footer.

Em/en dashes in title or body are scrubbed to ASCII ` - ` on the way out (phone
and plain-text clients render them poorly).

```bash
# Inside an agi-cli run (AGENT_SESSION_ID / AGENTS_MAILBOX_DIR already set):
agents feed post --title "CHANGELOG pushed" "Watching CI and mac-mini E2E"
agents feed post --title "Cover ready" "render at ./out/cover.png" --attach ./out/cover.png
agents feed post --title "Ready for review" "PR opened, waiting on prix-cloud" --json

# Escape hatch when not in a managed run:
agents feed post --title "Manual note" "context for the next agent" --session <session-id>
```

Each post appends a `status.posted` **milestone** to
`~/.agents/.history/activity/<sessionId>.jsonl` — the same activity stream the
feed’s recent-activity lane reads. It does
**not** create a feed block. Domain facts (tickets, PRs) are not CLI flags;
join them from the session index / live session enrichment at read time.

#### `--blocked` — the same post, but the agent is stuck

A plain post is history the moment it lands. `--blocked` says the agent
**cannot proceed** and needs a human, so the ask has to stay open rather than
scroll away:

```bash
agents feed post --title "Force-push denied" "git-guard blocked PR #1749" --blocked
agents feed post --title "Publish or wait?" "npm now or after review" --blocked --option publish --option wait
agents feed post --title "Delete preview env?" "stale preview still running" --blocked --default "leave it"
```

It is a flag on the existing verb rather than a separate command: the feed is
**one shared stream** where most posts are benign and some need a human, and one
verb is one thing for an agent to learn.

A blocked post writes to **both** stores:

- `status.blocked` on the activity stream — *what happened*.
- an **`OpenBlock`** in `~/.agents/.history/feed/` — *what is still open*, which
  is what makes it answerable (`recordAnswer`, `agents message`) and clearable
  (`recordContinued`). Without the ledger entry the ask would be indistinguishable
  from any other update.

**Blocked is a state, not a volume.** It always broadcasts at `important`, so an
agent never picks a level as well — passing `--level` alongside `--blocked` is a
usage error, not a silent override. The broadcast carries the ask plus the literal
`agents focus <id>` command that unblocks it, so the message contains the one
action the operator has to take.

`--option <label>` (repeatable) records an answerable choice; `--default <answer>`
makes the block an **approval** (a safe default policy may apply on no answer)
instead of a **decision** (only a human can choose) — the distinction
`feed-policy.ts` already keys off.

**It fails loud.** A block that reaches no sink exits non-zero: a silently
undelivered "needs you" is precisely the failure this exists to remove. One sink
failing among several is only a warning, since the channels are redundant.

- **`--attach <path-or-url…>` (repeatable).** Attach an artifact to the post. A
  **local file** is copied under
  `~/.agents/.history/attachments/<sessionId>/<updateId>/` so the reference survives
  a worktree delete; a **URL** is kept as-is. Each is classified to an
  image/audio/video/file/link kind by extension for its render glyph.
- **Project chip.** The post is stamped with its project (basename of cwd,
  worktree-aware) on the event itself, so the chip shows even without a live-session
  join.
- **Rich render.** A `status.posted` event renders multi-line — `agent · session ·
  host · project` chips, the message, an attachment row with per-kind glyphs, and a
  `↳ ag focus/sessions` hint — in the `feed post` echo, the feed activity lane,
  `agents feed --filter updates`. Other milestones keep the compact one-line form.

Identity resolution order: `--session` → `AGENT_SESSION_ID` /
`AGENTS_SESSION_ID` / mailbox basename → `AGENT_LAUNCH_ID` match in the pid
registry or activity index → parent-pid walk through `by-pid/<pid>.json`.

#### `--notify` — also raise a local desktop banner

```bash
agents feed post --title "Build green" "all checks passed" --notify
```

`--notify` raises a local desktop banner on **this** machine when the post is
made — the same `notifyDesktop` banner `agents run --notify` fires, and the same
one an `agents send --channel desktop` sink delivers. It is a per-post opt-in
that **adds** the banner on top of whatever `feed.broadcast`/owner delivery
already runs; it never replaces a configured sink, and it is routed through the
`desktop` channel provider like any other `channel:` sink, so it shows up in the
`reportBroadcast` outcomes and the `--json` payload rather than a side channel.

Two properties follow from what it is:

- **It fires at any level.** The banner carries no `minLevel`, so a routine
  `milestone` post can raise the local banner while an `important`-gated phone
  sink stays quiet — a heads-up on the box you are at, without buzzing the phone.
- **It is local.** The banner reaches whoever is at the machine the post was
  authored on, so a post from a headless box notifies that box (a no-op with a
  stated reason where no notifier exists), never the operator's Mac. Reaching a
  phone stays the job of an `important`-level owner/broadcast sink below.

Equivalent to declaring a `channel: desktop` sink in `feed.broadcast` (below),
but per-invocation and config-free — the same relationship `run --notify` has to
a standing desktop sink. The banner is added under a reserved `notify` sink name
(or the first free `notify-2`/… if you already declared one), so `--notify` never
overwrites a configured sink.

#### Broadcasting a post outward (`feed.broadcast`)

A post is durable in the activity log, but an operator away from every terminal
never sees it and the tracker that owns the work hears nothing. Declare sinks in
`agents.yaml` and each post is mirrored to them:

```yaml
feed:
  broadcast:
    ticket:
      command: [linear, update, "{ticket}", --comment, "{text}"]
    message:
      command: [rush, message, send, --text, "{message}", --from-agent, "{agent}"]
      minLevel: important
```

Sinks are **argv templates**, not built-in integrations — this CLI ships
Apache-2.0 and must not depend on one person's tracker or messaging stack. The
first element is spawned directly (no shell), so post text can never become shell
syntax. Point the same mechanism at `jira`, `gh issue comment`, or a webhook
script.

Two rules decide whether a sink runs, both read off the post itself:

- **Level.** `agents feed post … --level important` marks a post worth
  interrupting someone over; a sink with `minLevel: important` only sees those, so
  a routine "CI green" never buzzes a phone. The default level is `milestone`.
- **Placeholders.** A template referencing `{ticket}` is skipped when no ticket is
  known — the template declares what it needs, and a sink can never fire with a
  hole in its argv (`linear update  --comment …` commenting on nothing).

Available placeholders: `{title}` (short subject), `{text}` (body verbatim),
`{ticket}`, `{project}`, `{agent}`, `{host}`, `{session}`, `{level}`, `{links}`
(attached URLs, space separated), and `{message}` — a composed multi-line body
for messaging sinks:

```
Title in a few words

Body of what happened or the ask.

Sent from <agent>/<session-chunk> on <host>
[agents focus <id>  — blocked posts only]
[first attached URL]
```

Prefer `{message}` for a phone/Slack/iMessage sink. Title first for a scan,
blank line, then body, then a footer like "Sent from my iPhone" so a fleet of
agents is attributable without crowding the ask (`agent/session` on `host`).
`{text}` is still the bare body when a sink wants only that.

**Blocked posts add four more:** `{focus}` (the literal `agents focus <id>` command
that unblocks the session), `{class}` (`approval` | `decision`), `{cost}` (the
cost-of-delay tag), and `{block}` (the block id). For a blocked post `{message}`
already appends the `{focus}` line, so a messaging sink needs no extra template
work to carry the one action the reader must take. Note the placeholder grammar is
lowercase-only (`/\{([a-z]+)\}/`), which is why the id is `{block}` and not
`{blockId}` — a camelCase token would never substitute, and a template with an
unsubstituted token is **skipped**, not sent with a hole in it.

The **ticket is joined from the session index**, not passed as a flag — it is a
domain fact about the session (the rule above), and an agent that has to remember
a `--ticket` argument is an agent that will forget it. Attach the PR or a shared
plan with `--attach <url>` (an HTML plan published via `agents artifacts share` gives you a
public one) and it rides along as `{links}` / `{message}`.

Delivery is best-effort and reported: each sink that ran prints `→ <name>`, a
failure prints a warning and a non-zero exit is never propagated. Losing a mirror
must not cost the operator the post — it is already written.

##### `channel:` sinks — in-process delivery, no argv (RUSH-2123)

A sink can declare `channel:` instead of `command:`. It delivers through the
same channel-provider registry `agents send` / `agents notify` use
(`deliverEnvelope()`) — no spawn, no argv template, just the composed
`{message}` body:

```yaml
feed:
  broadcast:
    owner:
      channel: owner          # normal owner channel selected from humans.yaml
      minLevel: important
    ops-slack:
      channel: slack           # any registered channel / notify.transports name
      to: "#ops"
```

`channel: owner` is the address alias — same one `agents send --to owner` and
`agents notify` use — and needs no `to`. Any other channel name needs an
explicit `to`, or the sink is skipped (same "never fire with a hole in it"
contract a `command:` sink already follows for a missing placeholder). Gated by
`minLevel` exactly like a `command:` sink; the two shapes are interchangeable
per sink.

##### The implicit owner fallback

An operator who configures an addressable owner channel in `humans.yaml` but never writes a
`feed.broadcast` block used to get a `--blocked` post that looked recorded and
reached nobody — `feed.broadcast` and owner delivery were two disconnected
config blocks. Now, when `feed.broadcast` is unset or empty **and** the post is
`important` (which `--blocked` always is), the post falls back to
the normal owner channel automatically, as if `feed.broadcast: { owner: { channel: owner
} }` had been declared. A routine `milestone` post still stays record-only even
with the fallback available — the fallback follows the same `minLevel` contract
every sink already does — and writing an actual `feed.broadcast` block always
wins outright over the fallback.

### Activity lane (inside `agents feed`)

The milestone timeline previously surfaced by the standalone `agents activity`
command is now part of `agents feed`. The same append-only activity stream is
read, but it is rendered as a compact lane under the block view or in full via
`--filter updates` / `--filter all`:

```bash
agents feed --filter all     # open blocks, then the milestone/updates lane
agents feed --filter updates # progress posts + milestones, recency-first
```

The lane still shows plans, PRs, worktrees, sub-agents, and deliberate
`agents feed post` progress — just through `agents feed`, not a separate command.

### Live tail (`--watch`, `-f`) — the money shot

```bash
agents mailboxes --watch                 # stream new cross-box messages as they land
agents mailboxes --watch --since 1h      # backfill the last hour, then keep tailing
agents mailboxes --watch --from claude   # only one sender
agents mailboxes --watch --json          # NDJSON, one message per line
```

Each line is `HH:MM:SS  <from> ─→ <toLabel>   <text>`. When a message is
addressed to the box of the agent running the watch (spawn wiring sets
`AGENTS_MAILBOX_DIR`), the target renders as `▲ you` in amber — an orchestrator
agent sees its replies light up in the stream. Ctrl-C aborts the poller
cleanly. Without `--since` the watcher does not replay history; it baselines
the spool and streams only what arrives after that.

### Filters (`--from`, `--to`, `--since`)

All three apply to the overview recency log, the `--watch` stream, and
`--graph`:

| Flag | Matches |
|---|---|
| `--from <agent>` | Sender label contains `<agent>` (case-insensitive) |
| `--to <agent>` | Recipient box id or resolved label contains `<agent>` |
| `--since <dur>` | `30s` / `5m` / `2h` / `7d` / `4w` or an ISO date |

### Thread (`--between <a> <b>`)

Reads one relationship: every message between the two boxes in either
direction, chronological, under a `a ⇄ b   N messages · span` header. Boxes
resolve by full id, id prefix, or label substring. Thread reconstruction keys
on the sender stamp (`from`), matched against the counterpart's box id (full
or prefix) or its resolved label.

### Routes (`--graph`)

Aggregates the whole spool into `from └─▶ to ···· count` adjacency rows,
busiest first — the shape of the fleet's chatter at a glance.

### JSON mirroring

`--json` works on every view: overview dumps per-box
`{id, label, live, pending, total, messages}` (filters recount when present),
`<id>` dumps one box, `--between` dumps `{a, b, count, messages}`, `--graph`
dumps the edge list, and `--watch` streams NDJSON.

## Behavioural report (`agents insights`, bare)

`agents cost` answers what you spent and `agents output` answers what shipped.
Bare `agents insights` answers **how you work**, and is the only surface that splits any of
it by the account that did the work. Counter recipes share the same verb as
`agents insights mix` (see [Counter mix](#counter-mix-agents-insights-mix) above) —
do not invent a second top-level analytics command.

That account split is the reason the behavioural path exists. `getConfiguredRunStrategy`
defaults to `balanced` (`lib/rotate.ts`), so sessions are sprayed across every signed-in
Claude account. A report that reads one account's directory — which is what Claude Code's
own `/insights` does — describes a fraction of the work and attributes all of it to one org.

```bash
agents insights                                # last 30d, by account
agents insights --by project --since 90d       # which repo is eating the time
agents insights --account "Turing Labs" --all  # one account, every session ever
agents insights --json                         # stable contract for dashboards
agents insights --narrative                    # add a written read on the numbers
```

### What the behavioural report reports

| Section | Contents |
|---|---|
| By account | sessions, cost, duration per account (or per `--by` dimension) |
| Top tools / Languages / Models | histograms by name, from transcript content |
| Friction | interruptions, tool errors, gap until next user message (p50/p90), **agent silent stalls** (assistant last spoke, then ≥5m idle until you resumed — buckets 5-15m / 15-60m / 1h+), resume nudges ("continue" after a stall) |
| What you changed | lines touched, files created/modified/deleted, git commits and pushes |
| When you work | 24-slot local-time histogram of your messages |
| Parallel sessions | overlapping pairs, and how many straddled two accounts |

### Agent silent stalls (model goes quiet until you ping)

A common failure mode: the assistant ends a turn while work remains, sits idle, and
only resumes when you type "continue" / "keep going" later. Insights detects that from
**timestamps**, not vibes:

1. Take the last assistant event timestamp (message or tool_use).
2. Take the next non-synthetic user message timestamp.
3. If the gap is **≥ 5 minutes**, count a **silent stall** (bucketed by duration).
4. If that user message is a resume nudge (`continue`, `keep going`, `resume`, …),
   also count **resume after silent stall**.

Gaps under 5 minutes stay normal turn-taking (and feed the p50/p90 "gap until next
msg" line). Gaps over an hour are excluded from p50/p90 (you may have left the desk)
but still count as `silent stall: 1h+` when the assistant was the last speaker.

Actions and `--narrative` are instructed to call these out so the report drives
anti-idle rules (stop gates, background watches, queue drain) rather than treating
the human as the only resume signal.

### Two engines under one verb (not two top-level commands)

| Path | Reads | Answers |
|---|---|---|
| Bare `agents insights` | Transcript *content* via `parseSession` | Behaviour: which tools, languages, friction, when you worked — **per account** |
| `agents insights mix` | *Counters* (`tool_scan_ledger`, `usage.db`) | Distributions: tools per session, harness mix, token ratios, hottest secrets |

They overlap in spirit on tool and model mix; they do not share a store. Keeping both
under `insights` is deliberate so agents do not re-create a peer `trends`/`analytics`
surface. Latency remains `agents perf`.

### Caching

Parsing every transcript is expensive, so each session's facets are cached in
`session_insights`, keyed on the session's `(file_mtime_ms, file_size)` — the same
staleness contract `scan_ledger` uses, compared in SQL against the session row so the
cache cannot disagree with the index. The first run parses everything once; later runs
re-read only changed files. `--refresh` discards the cache.

The table is created with `CREATE TABLE IF NOT EXISTS` and is deliberately **not** tied
to `SCHEMA_VERSION`; `INSIGHTS_EXTRACTOR_VERSION` invalidates it when the extraction
logic changes, so a new metric never reports stale numbers beside fresh ones.

### Scope and limits

- **Account attribution is Claude-only** (see [sessions.md](sessions.md)). Other
  harnesses group under `unattributed:<agent>`.
- **Sessions under 2 messages or 1 minute are excluded**, matching `/insights` so the
  two reports count comparable populations. The excluded count is always printed.
- **No branch collapsing.** `/insights` merges conversation branches; agents-cli is
  file-per-session throughout, so session counts read slightly higher here.
- **`--narrative` is the only path that sends your data to a model.** It pipes the
  *aggregate* (never raw transcripts, unlike `/insights`) through a headless
  `claude -p`, and writes to stderr so `--json` stays parseable. Two other things do
  reach the network and are not that: `-H/--host` runs the command on a peer over SSH,
  and the index refresh resolves Linear project names when a Linear key is configured.
- **"Lines touched" is not a diffstat.** It sums the before/after line counts of each
  edit, so an `Edit` whose `old_string` includes unchanged context counts those lines on
  both sides. Measured against a real commit the written figure ran ~19% high and the
  replaced figure ~475% high versus `git --numstat`. Use `agents output` for real
  shipped-code numbers; this one is about editing behaviour.
- **Facet coverage is per harness.** Line counts come from structured edit arguments, so
  they work for Claude and droid but not codex, which patches through shell `exec`.
  Unmeasurable is rendered as "not measurable", never as `0`.
- **Commits and pushes are substring-matched from shell command text**, so they
  disagree with `agents output`, which counts real commits by deduped SHA from
  `git log`. Labelled "seen in shell commands" for that reason. Coverage also varies by
  harness: the codex parser exposes a command string for `exec_command` but not plain
  `exec`, its dominant tool, so on a measured run only 92 of its 5,197 calls were
  searchable. A low count there means low visibility, not low activity.
- **Reply-time percentiles exclude gaps over an hour** (someone left and came back). The
  excluded count is printed. There is deliberately no lower bound: `/insights` drops
  sub-2-second replies, which censors ~28% of the sample and inflates the median by
  ~63%.

## Cost & Duration Rollup (`agents cost`)

Every session is priced at scan time: `cost_usd = Σ tokens × per-model price`
and `duration_ms = lastTs − firstTs` are persisted on the session row (schema
v13). The price table is offline and versioned — no API calls, no telemetry —
covering current Claude, OpenAI, and Gemini models. Unknown/unpriced models
contribute `$0`, never `NaN`.

`agents cost` rolls those figures up across the local, cross-agent index:

```bash
# Daily $ histogram + top-10 sessions by cost + per-agent breakdown
agents cost

# Last 30 days, grouped by project instead of agent
agents cost --since 30d --by project

# Machine-readable daily rollup for a dashboard
agents cost --by day --json
```

Output sections:

- **Daily** — a zero-dependency unicode-block sparkline of $/day plus the
  priciest days.
- **Top sessions by cost** — the 10 most expensive sessions with short id,
  agent, topic, project, and wall-clock duration.
- **By agent / project / day** — grouped totals (`--by`), summed cost,
  session count, and total duration.

`agents cost` is distinct from [`agents usage`](#), which reports live
rate-limit / quota status per agent — different question, different command.

For per-session figures, `agents sessions --json` now carries `costUsd` and
`durationMs`, and `agents sessions --sort cost|duration` orders the list by
spend or wall-clock time (NULLs last).

```bash
# The 10 most expensive sessions, anywhere
agents sessions --all --sort cost --limit 10 --json | \
  jq '.[] | {shortId, agent, costUsd, durationMs, topic}'
```

## Productivity Rollup (`agents output`)

`agents cost` answers *what you spent*; `agents output` joins that burn to *what
shipped* (real generated output tokens, plus PRs and commits) — the "was it worth
it" axis. It leads with `output_tokens` (real generation), not the cache-inflated
`token_count`.

### Burn split — input / cache-read / cache-write

Where the harness records a per-message cache split (**Claude, Codex, Gemini,
Droid**), each session persists the split — uncached `input_tokens`,
`cache_read_tokens`, and `cache_write_tokens` (schema v37) — and the rollup sums
them. The text report adds a `burn split:` line and `--json` carries the three
counts on `burn` and on every `breakdown` row. Harnesses that expose no cache
split (e.g. OpenCode, Kimi) leave the split absent and show total + output only.

### `--pricing no-cache` — model the burn without prompt caching

Each session also persists a second cost, `cost_usd_nocache`, computed at scan
time by repricing its cache-read and cache-write tokens at the model's full
**input** rate (output and uncached input are unchanged). This is the "what would
this have cost with caching off?" scenario.

```bash
# Actual (cache-discounted) burn, with a caching-savings comparison line
agents output

# Lead the burn with the no-cache figure (breakdown column becomes burn(nc))
agents output --pricing no-cache

# Both costs + the split, machine-readable (JSON is scenario-agnostic —
# it always carries burn.costUsd AND burn.costUsdNoCache plus the split)
agents output --json | jq '.burn | {costUsd, costUsdNoCache, inputTokens, cacheReadTokens, cacheWriteTokens}'
```

`--pricing` only chooses which cost the **text** report leads with; the `--json`
payload always carries both `costUsd` and `costUsdNoCache` so a dashboard can pick.
`costUsdNoCache ≥ costUsd` in typical sessions, where cheap cache **reads** dominate
the burn. It can invert in a cache-**write**-heavy session: Claude prices a cache
write at 1.25× the input rate, so repricing those writes *down* to the input rate can
make the no-cache figure lower. The text report shows the saving (`caching: actual $X
vs no-cache $Y (saved $Z, N%)`) only when the no-cache figure is actually higher.

## Accounts & Usage in `agents view`

`agents view` shows, per installed agent, **who's signed in** and (where the
provider exposes it) **live quota**. Two separate passes feed the row, joined by
a stable per-account key:

- **Account identity** — `getAccountInfo` ([`src/lib/agents.ts`](../src/lib/agents.ts))
  is **local-only, no network**. It reads each agent's on-disk credential and
  surfaces an email when one is readable, else a stable account id, else a bare
  `signed in`.
- **Usage bars** — a separate network pass ([`src/lib/usage.ts`](../src/lib/usage.ts))
  fetches live quota and renders `S:`/`W:`/`M:` bars + plan, according to each
  provider's reported window duration. It's **stale-while-revalidate**
  (on-disk cache under `~/.agents/.cache/`, keyed per account: 2-min fresh, 24-h
  block) so `agents view` stays off the network on the hot path.
- **Routing reads the same cache, CACHE-ONLY — never on the hot path's network
  (RUSH-2061).** Displaying a slightly old bar costs nothing; *choosing an account*
  from one must not cost a network round trip on `agents run` cold-start.
  `collectRunCandidates` reads the cache with `readOnly`
  ([`src/lib/rotate.ts`](../src/lib/rotate.ts), [`src/lib/usage.ts`](../src/lib/usage.ts))
  and never blocks on a live fetch. A snapshot older than **5 minutes**
  (`USAGE_DECISION_MAX_AGE_MS`) is still not trusted for the pick — but the guard
  is `isUsageVerified`, which routes around an unconfirmable number and reports
  `usage unverified` in the launch banner, NOT a blocking refresh. Keeping the
  cache warm is the **daemon's** job (`runUsageRefresh`,
  [`src/lib/usage-refresh.ts`](../src/lib/usage-refresh.ts)): each host refreshes
  only its own signed-in accounts on an adaptive cadence from the session-window
  burn rate (90s racing toward the 5h cap, up to 15min idle), capped at ~6 calls
  per account per hour and skipped under a 429 backoff. Balanced weighting also
  **deprioritizes an account projected to cap soon** — `deriveUsageHeadroom`
  projects minutes-to-limit and `capacityWeight` scales the headroom weight down
  as that projection shortens, so a launch avoids an account racing toward its cap,
  not just one already 100%-maxed. The cache is strictly per machine and never
  synced.
- **A 429 is backed off, not retried through.** The endpoint's `Retry-After` is
  recorded per provider (`usage-backoff.ts`, on disk under
  `~/.agents/.cache/usage-backoff/` because the daemon and every one-shot CLI run
  are separate processes — one empty file per penalty, named
  `<agent>.<deadline>`, so concurrent writers cannot displace each other's
  deadline and a read simply takes the furthest one), and both
  the usage fetch and the auth-health probe skip the network until it passes.
  Backoff is the second layer; the first is that the daemon's 3-minute
  auth-health warm now probes once per (network-probing agent, account) rather
  than once per installed version home (`groupFleetAuthInstalls`, RUSH-2111), so
  several homes signed into one account no longer fire concurrent same-account
  requests that raced the rate limit in the first place — measured on
  `yosemite-s1` before the fix, `retry-after: 2678` on all five accounts at once,
  with the credentials reading healthy.
- **A read that fails on the credential names the reason.** No readable
  credential, a locally-expired one, a rejected request, and a request that threw
  are distinct errors (`usageNoCredentialError` / `usageExpiredCredentialError` /
  `usageRejectedError` / `usageUnreachableError`,
  [`src/lib/usage.ts`](../src/lib/usage.ts)), not a silent
  null. All four networked providers — Claude, Kimi, Droid, Cursor — share them,
  because they share one cache fallback: a silent null in any of them presents a
  stale reading as confirmed. Because a usage read never refreshes a token,
  an expired credential does not heal until that agent actually runs; a 429 reads
  differently from a 401, since re-authing fixes one and not the other. `agents view`
  renders a cached reading that a failed live read could not confirm as the number
  plus `unverified`, and `--refresh` lists every account it could not reach rather
  than printing a table that looks fully refreshed. Measured on `yosemite-s1`,
  where every account's stored token had expired and two `--refresh` runs wrote
  nothing to the cache while reporting nothing wrong.

What each agent can surface is bounded by what its local credential actually
contains — this is a data-availability limit, not a policy choice:

| Agent | Account column | Usage bars | How it's derived |
|---|---|---|---|
| Claude | email + plan | live (`api.anthropic.com`) | email/plan/quota from the local OAuth credential + usage API |
| Codex | email + plan | last-seen (session logs) | email/plan from the auth JWT; quota parsed from the newest session's rate-limit event |
| Gemini | email | — | email read from the local auth file |
| Grok | email + tier | last-seen (`~/.grok/logs/unified.jsonl`) | email from the local auth file; weekly window (`W`) + subscription tier parsed from the newest `billing: fetched credits config` log line, since Grok's network usage endpoints 404 |
| Droid | email | live (`api.factory.ai`) | `~/.factory/auth.v2.file` is AES-256-GCM (key on disk at `auth.v2.key`); decrypt locally, read the email from the WorkOS access-token JWT. That same token authorizes `GET /api/billing/limits` for the three rolling rate-limit windows (5-hour → `S`, weekly → `W`, monthly, detailed-view only). |
| Kimi | `id:<user_id>` + tier | live (`api.kimi.com/coding/v1/usages`) | JWT carries no email — only an opaque `user_id`. Quota + membership tier come from the `/usages` endpoint. |
| Cursor | email | live (`cursor.com/api/dashboard/get-current-period-usage`, `cursor.com/api/usage-summary`, `cursor.com/api/usage`) | email/authId from `~/.cursor/cli-config.json`; access token from `~/.config/cursor/auth.json`; the cookie subject prefers the access token's own JWT `sub`, falling back to the config file's `authId`. Every request is authed with a `WorkosCursorSessionToken=<sub>::<token>` cookie. Three sources, tried in order: the dashboard's `get-current-period-usage` (primary) maps `planUsage.{auto,api,total}PercentUsed` to three bars — Auto + Composer (`A`), API (`API`), Total (`T`) — reset from `billingCycleEnd`; `usage-summary` (fallback, for accounts the primary endpoint returns no usable `planUsage` for) nests the same three percentages under `individualUsage.plan`; the legacy `/api/usage` request-cap endpoint (last resort) renders a monthly request bar (`M`) for free/legacy request-capped plans. An account on none of these (fully unlimited, no percent fields) renders without a bar rather than a misleading empty gauge. |
| Antigravity | `signed in` | live (`cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`) | OAuth grant with no id_token — presence only. File `~/.gemini/antigravity-cli/antigravity-oauth-token`, else macOS keychain / Linux libsecret (`service gemini` + user `antigravity`). The stored Google OAuth token authorizes the Code Assist quota endpoint `agy` itself uses; it returns one bucket per model (`gemini-3.1-pro`, `gemini-2.5-flash`, …) with its own reset time, and each bucket renders as its own bar (compact model tag: `3.1P`, `2.5F`, …). |
| others | `not signed in` unless a credential exists | — | `default` case: no detector |

Two deliberate boundaries worth knowing:

- **Droid decrypts a local credential.** We read the user's own credential to
  show their own email — the same thing the `droid` CLI does. If it can't be
  decrypted (a `keyring-v2`/legacy login with no on-disk key), the row falls
  back to `signed in` rather than blanking.
- **Kimi and Droid usage never refresh the token.** `agents view` is a
  read/inspect command, so it must not rotate the user's OAuth credential
  (rewriting the file, invalidating the single-use refresh token, racing a
  running `kimi` / `droid`). An expired token simply falls back to the cached
  snapshot; each agent's own CLI refreshes on its next launch (Droid's token
  lives 24h). Droid surfaces the `standard` (primary) rate-limit pool, not the
  free `core` fallback pool.
- **Antigravity usage MAY refresh, in-memory only.** Google's OAuth refresh
  tokens are stable and non-rotating — a refresh mints a new access token and
  leaves the refresh token (and every other live access token) valid, so a
  read-path refresh can't invalidate a running `agy` the way a Claude/WorkOS
  rotation would. The refreshed access token is used for the quota call and
  then dropped: the keychain item is never written (agy rewrites it on its own
  launches). Without this the bars would never render — Google access tokens
  live ~1 hour.

The same fields are exposed programmatically via `agents view --json`
(`email`, `accountId`, `plan`, `usageStatus`, `windows`).

## Budget Guardrails (`agents budget`)

`agents cost` is the observability half — it tells you what you already spent.
**Budget guardrails are the enforcement half**: they estimate a run's cost
*before* it starts and can block it, and — for local headless `agents run` —
attribute live spend and **hard-kill the running agent the moment a cap is
crossed.** Observability can't reach back in time and stop the call that blew
the budget; this can.

**Scope (v1).** The pre-flight estimate/block applies to `agents run`, `agents
teams`, and `agents cloud`. The **live mid-run hard-cap kill currently applies
to local `agents run` headless runs only**; teams and cloud dispatch are gated
**pre-flight** (estimate + block before spawn) — live mid-run kill for
teams/cloud is a planned follow-up.

The guardrail is **cross-vendor by construction** — one cap spans every agent
the CLI dispatches (Claude + Codex + Gemini + …), which no single-vendor
control can do.

### Configure caps in `agents.yaml`

Add a `budget:` block. It resolves **project > user** (same precedence as
`run:`): a project's `agents.yaml` overrides your user-global caps field by
field. Every cap is in USD.

```yaml
budget:
  currency: USD
  per_run: 5.00              # cap on a single run's estimated/actual cost
  per_day: 50.00             # cap on total spend today (ALL agents)
  per_project: 100.00        # cap on cumulative spend for this project
  per_agent:                 # per-agent daily caps
    claude: 30.00
    codex: 20.00
  on_exceed: block           # block (refuse / kill) | warn (proceed, report)
  require_confirm_over: 1.00 # prompt before a run estimated at or above this
```

A cap is enforced only when set; an empty `budget:` block leaves the feature
dormant (zero overhead). `on_exceed` defaults to `block` (fail-closed).

### Pre-flight estimate (blocks before spawn)

Every `agents run` prints an estimate and, under `on_exceed: block`, refuses to
launch when a cap would be breached — exiting **non-zero (code 2)** so CI,
headless runs, teams, and cloud dispatch all inherit the decision.

```bash
$ agents run claude "big refactor across the repo" --model claude-opus-4
[budget] est. $2.48 for this claude run (claude-opus-4, prompt size)
[budget] BLOCKED: estimated $2.48 exceeds per_run cap $0.01
Raise the cap in agents.yaml budget: or set on_exceed: warn to proceed.
$ echo $?
2
```

The token basis comes from recent ledger averages for the same agent, falling
back to a prompt-size heuristic when there's no history.

`-y` / `--yes` skips the interactive `require_confirm_over` prompt for scripts,
but **never skips a hard block** — a cap breach blocks regardless of `--yes`.

### Live spend + hard-cap kill-switch (local `agents run` only)

For local **non-interactive** (`-p` / `--print` / headless) `agents run`
invocations, spend is parsed off the agent's stdout stream as it happens and
accumulated against the caps — this is attached whether or not output is being
piped (the child's stdout is captured and tee'd back so you still see it). The
moment a cap is crossed the child is terminated (`SIGTERM`, then `SIGKILL` after
5s — the same mechanism as `--timeout`) and the run resolves with a **distinct
exit code (7)** so a budget kill is distinguishable from a normal failure or a
timeout. Final spend is written to the shared ledger.

Interactive REPL sessions are **not** live-killed (the human owns the TTY); they
rely on the pre-flight gate. **`agents teams` teammates and `agents cloud`
dispatch are also not live-killed in v1** — they are gated pre-flight only. Live
mid-run kill for teams/cloud is a planned follow-up.

### Spend ledger

Every run that produces token usage appends to an append-only JSONL ledger at
`~/.agents/.history/spend/ledger.jsonl`. Each line attributes one usage
observation to `{ runId, agent, project, day, model, tokens, costUsd, source }`.
This is the shared artifact `agents cost` can read for $ rollups.

### View and set caps

```bash
agents budget                      # caps + spend-to-cap bars (today + project)
agents budget --json               # machine-readable snapshot
agents budget set per_run 5        # write a user-global cap
agents budget set per_agent.claude 30
agents budget set on_exceed warn   # switch to warn-only (do not block)
```

`agents budget` reports the **effective merged** config for the current
directory. `set` writes the user-global layer; project caps are hand-edited in
the repo's `agents.yaml`.

## Environment Variables That Matter

External tools observing live sessions should know about these env vars, set
automatically on agent terminal spawns:

```
AGENT_SESSION_ID     # Session UUID - matches sessions.id in the DB
AGENT_TERMINAL_ID    # Internal tracking ID (CC-<ms>-<n>)
AGENT_WORKSPACE_DIR  # cwd for the agent
```

Reading these from a VS Code / tmux / process tree lets you answer "which
running process owns this session?" without re-parsing state.

## When Not To Use This

- **Sub-100ms read budgets.** Each `agents` invocation is a Node.js process
  spawn. Read the DB directly with `better-sqlite3` at
  `~/.agents/.history/sessions/sessions.db` — but you give up schema migration safety.
- **Push-based notifications.** The JSON sources are pull-only. For real-time
  events, tail the session JSONL files directly or use agent-native SDKs.
- **Writing state.** Observability is read-only. To spawn agents, use
  `agents run`, `agents teams add`, or `agents cloud run`.

## Related

- [Sessions](./sessions.md) — the `sessions` subsystem in depth
- Cloud dispatch (`agents cloud --help`)
- Team DAGs (`agents teams --help`)

