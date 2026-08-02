# Observability

Using agents-cli as a programmatic observability layer for agent fleets.

`agents feed` and `agents mailboxes` share one fleet-comms visual language (masthead + glyphs from `comms-render`) so the two operator surfaces read as one product.

## Audit Event Log (`agents events`)

Separate from the fleet-state sources below (which answer "what's running *now*"),
the **audit event log** answers "who did what, and from where". Every
`agents <module> <command>` invocation is recorded — team create/disband, agent
run, secrets access, version installs — as a structured JSONL line at
`~/.agents/events.jsonl` (directory `0700`, file `0600`). At 10 MB the active
file rotates losslessly to `events.1.jsonl.gz`; older archives shift to
`events.2.jsonl.gz`, `events.3.jsonl.gz`, and so on.

The recording is a single choke point — a commander `preAction`/`postAction`
hook on the root program ([`src/index.ts`](../src/index.ts)) emits `command.start`
/ `command.end` for *every* subcommand, so coverage is automatic and no per-command
wiring can drift out of date. Richer typed events (`secrets.get`, `version.install`,
`teams.create`, `teams.disband`, …) layer on top where the extra payload earns it —
e.g. team lifecycle events are emitted at the registry source with the team name,
so they fire for every path (`teams create` and the auto-create in `teams add`).

Every record carries **attribution** computed once per process
([`src/lib/events.ts`](../src/lib/events.ts)):

- `osUser` — the OS account that ran it.
- `transport` — `local`, or `ssh` when `$SSH_CONNECTION` is present.
- `sshClientIp` — the remote client IP when over SSH.
- `caller` — `claude-code`, a Factory terminal agent (`claude`, `codex`,
  `gemini`, `cursor`, …), `terminal`, or `script`.
- `session` — the short Factory session id when one is present.

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
  historical sessions to a person, not just the live `--active` view. They are
  **write-once at session creation** — a later content rescan carries no actor and
  is deliberately kept out of the upsert's `ON CONFLICT` update set, so the original
  owner is never clobbered by re-indexing.
- **How the index gets the actor** — the transcript on disk records no actor, so at
  spawn each run also writes a small **durable `sessionId -> actor` sidecar** under
  `~/.agents/.history/by-session/` (unlike the pid-registry, this survives the
  process). The scanner joins it as it indexes, filling the columns above. Teammates
  inherit the orchestrator's frozen actor, so a whole team traces back to the one
  human who started it; their records also carry a `parent_session_id` (the
  orchestrator's session) so the spawn chain is walkable.
- **Beyond sessions — events, routines, and browser tasks carry the actor too.**
  Every emitted **event** records `actor` + `kind` (via the audit origin), so
  `agents events` and its stats group by who did it (a `byActor` breakdown). A
  **routine** stamps its creator's actor at creation and injects it into each fired
  run's env, so an unattended cron traces back to the person who scheduled it (not
  the `UNRESOLVED@<host>` a live resolve would give); its run records carry `actor`
  (the creator) and `triggeredBy` (who kicked off that specific run). A **browser
  task** records the `owner` who launched it, on the live task and in history.

```bash
agents events                          # recent activity across everything
agents events --module teams           # team lifecycle (create / add / disband)
agents events --module secrets         # every secret accessed, revealed, or unlocked
agents events --command "teams create" # a command path — prefix match
agents events --event teams.disband    # a semantic event: a team torn down
agents events --event secrets.get --since 7d --json
agents events -f                       # live tail of today's log
```

`--module` filters the top-level group; `--command` matches a command path by
prefix (`teams` catches `teams create`); `--event` filters a typed event
(repeatable); `--since` takes `2h`/`7d`/`4w` or an ISO date. `--json` emits the
raw records for external consumers.

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

### Audit Viewer (`agents logs audit`)

While `agents events` is a convenience alias, the full audit surface lives under
`agents logs`:

```bash
agents logs audit                          # recent activity (last 100)
agents logs audit --level audit            # security-relevant only
agents logs audit --module teams           # team lifecycle events
agents logs audit --command "secrets get"  # by command path prefix
agents logs audit --caller claude-code      # only commands invoked by Claude Code
agents logs audit --event mcp.add         # by typed event (repeatable)
agents logs audit --since 7d --json       # machine-readable, last 7 days
agents logs audit --follow                # live tail of today's log
```

Events are classified by level:

| Level | Meaning | Examples |
|---|---|---|
| `audit` | Security-relevant | `secrets.get`, `secrets.reveal`, `teams.create`, `teams.disband`, `cloud.dispatch` |
| `warn` | Warnings | `warn` events |
| `info` | Informational | `info`, `command.start`, `command.end`, `mcp.add` |
| `debug` | Diagnostic | `debug` events |

Every record includes the environment-derived `caller` identity, so the audit
trail answers which agent or human surface invoked the command rather than which
TypeScript source file happened to emit it. Filter with `--caller`.

#### Aggregate Statistics

```bash
agents logs stats                  # breakdown by level, event, module, user
agents logs stats --since 30d      # last 30 days
agents logs stats --json           # machine-readable
```

#### Log Rotation

Files exceeding 10 MB rotate to numbered gzip archives without overwriting an
earlier archive. Archives older than 7 days can be pruned explicitly with:

```bash
agents logs rotate                 # prune archives older than 7 days
agents logs rotate --days 7        # prune files older than 7 days
```

The `query()` API reads the active JSONL and every numbered gzip archive
transparently.

External tools (dashboards, voice assistants, CI runners, monitoring) can read
fleet state via three canonical `--json` sources. No direct DB access, no re-parsing
of agent-specific formats, no auth to manage.

## Agents HQ Floor (`agents hq floor`)

`agents hq floor --json` is the management bridge for the Agents HQ office view.
It joins the same live sources used elsewhere (`sessions --active`, `teams list`,
team status, and feed blocks) into one floor-shaped payload:

- `rooms` — team rooms first, then machine rooms for standalone agents.
- `agents` — live occupants with mood (`working`, `waiting`, `blocked`,
  `celebrating`, `idle`), machine/team placement, preview text, and action cards.
- `ambientEvents` — animation triggers for needs-input, blocked, PR, active-team,
  and idle-room scenes.
- `actions` — runnable `agents` argv arrays for floor-level actions such as
  creating a team room.

Per-agent and per-room actions are command-backed instead of inventing a second
write API. Agents HQ can render them as buttons and execute the returned argv:

```bash
agents hq floor --json | jq '.agents[0].actions'
```

Typical action commands are `agents message <mailbox> ... --surface hq`,
`agents feed --kill <mailbox>`, `agents teams stop <team> <teammate>`,
`agents sessions <id> --markdown`, and `agents teams add <team> ...`.

## Fleet health & cross-device divergence (`agents doctor`)

Three diagnostics with distinct scopes (RUSH-2027):

- `agents fleet status` — coarse **device** health: online/offline, which agent
  CLIs are installed, sign-in, agents-cli **version skew**. Not fine-grained
  resource divergence.
- `agents inspect <agent>[@version]` — deep **single-harness** diff between one
  version home and its resolved sources (staleness, orphans).
- `agents doctor` — the **umbrella**: local diagnostics (CLI presence, sign-in,
  per-version sync, orphans) **and**, with `--devices`, cross-device divergence.

### Triaged health block (local modes)

Both the bare `agents doctor` overview and the target report
`agents doctor <agent>[@version]` lead with a **triaged health block** — the
verdict, ranked by severity, so the reader sees what is unhealthy, why it matters,
and the exact fix without decoding status text. A clean install collapses to one
green line:

```
Claude@2.1.220
  ✓ healthy — 34 resources reconciled · hooks wired · sources current
```

Otherwise a severity-counted header is followed by one row per finding — icon ·
severity · subject — impact, then the exact fix — and a heal footer when anything
is `--fix`-able:

```
Claude@2.1.220
  ✗ unhealthy — 3 issues (1 critical · 2 warnings)

  ✗ critical  ask-user-question-guard — on disk but not wired into settings.json; the hook never fires
              → agents sync claude@2.1.220 --yes
  ⚠ warning   ~/.agents — 16 commits behind origin/main; you're running stale config
              → agents repo pull user
  ⚠ warning   11-activity-log — differs from source
              → agents doctor claude@2.1.220 --fix

  heal what's auto-fixable:  agents doctor claude@2.1.220 --fix
```

Every finding carries an agent-agnostic **severity** (glyphs `✓` `✗` `⚠` and a
subtle info dot, colored via `chalk`):

- **critical** (`✗`, silent breakage) — an unwired hook, a missing/unparseable
  `settings.json`, a MISSING resource.
- **warning** (`⚠`, stale / drift) — a source layer behind origin, a DIVERGENT
  resource, a stale / never-synced version.
- **info** (`·`, orphan) — an EXTRA resource → `agents prune cleanup`. Capped with
  a `+N more orphans` rollup so the block stays scannable.

The bare overview opens with a `Health` banner aggregated across every installed
version; the target report renders the block below its per-resource detail rows
(kept — the health block layers on top as the verdict). `--json` carries the same
triage: a `verdict` field in target mode and a `health` field in the overview,
each with `severity`/`category`/`subject`/`impact`/`fix` per issue. Source:
`src/commands/doctor.ts` (`computeVerdict`, `computeOverviewHealth`,
`healthBlockLines`).

### `agents doctor --devices`

Compares every registered device's installed harness inventory against the local
machine (the baseline) and flags anything present on one box but missing on
another:

- **Resource presence** — commands, skills, hooks, rules, mcp, permissions,
  subagents, plugins, promptcuts, workflows. A plugin like `swarm` installed on
  `zion` but absent on `yosemite-s0` reads as
  `yosemite-s0 is missing plugin 'swarm' (present on zion)` — instead of only
  surfacing at runtime as `Unknown command: /swarm:run`.
- **Agent version parity** — a version installed on one box but not another
  (`yosemite-s0 is missing claude@2.1.220`).
- **`.agents` / `.system` repo drift** — a device whose config-repo HEAD, branch,
  or dirty state diverges from the local baseline.

It is **read-only**: it never installs or syncs. The remediation hint points at
`agents apply` / `agents repo pull` on the lagging box.

```bash
agents doctor --devices          # human table + a Cross-device divergence section
agents doctor --devices --json   # { devices: [...], fleet: { divergences: [...] } }
```

Each device's top-level `agents doctor --json` emits a `fleet` inventory field
(installed resources per kind, installed versions per agent, repo state), so the
comparison needs no extra probe. `agents fleet status` reuses the same comparator
to add a per-device divergence line to its rollup. Source:
`src/lib/devices/fleet-divergence.ts` (pure comparator),
`src/lib/devices/fleet-inventory.ts` (`collectLocalFleetInventory`),
`src/commands/doctor.ts` (`runDevicesDoctor`).

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
| `agents sessions --json` | What local CLI and team-spawned agents have run recently? | The `SESSION_AGENTS` harnesses on this laptop (Claude, Codex, Gemini, Antigravity, OpenCode, OpenClaw, Rush, Hermes, Grok, Kimi, Droid) | Pure-cloud runs with no local file |
| `agents cloud list --json` | What am I running on remote VMs right now? | Rush Cloud, Codex Cloud, Factory | Local sessions |
| `agents teams list --json` | What multi-agent DAGs are active? | All team-coordinated runs | Standalone agents |

`agents sessions --active --json` includes `attachments` for prompt-side
screenshots and files when the source transcript carries a local path. Each entry
contains `path`, `name`, `mediaType`, and `sizeBytes` so consumers such as Factory
can render thumbnails and open the original attachment without re-reading the raw
agent transcript.

Every row also carries flat top-level `ticketId` and `project` keys — always
present, `null` when unknown — so a watcher can join active sessions on ticket and
project without reaching into the nested `ticket` object. `project` is the
basename of the session's cwd, the same derivation the historical `--json`
listing uses, so the active and recent views join identically.

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
```

The overview opens with a `fleet comms` masthead (`N live · M boxes`, total
messages, messages still awaiting delivery, last activity) and a 24-hour
hourly-volume sparkline, then one row per box (live dot, pending/total counts,
last activity, resolved live-session label), then the recency-ordered message
log.

## Agent feed (`agents feed`)

`agents feed` lists decisions agents need from the operator. The default order is
cost-of-delay rank, not chronology: idle minutes × downstream blast radius ×
hourly burn × ask irreducibility. Suppressed stalls and FYIs get zero
irreducibility, so a fresh cheap ask does not outrank an old critical-path block.

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

Agents can deliberately announce progress without opening a feed block. The
command is free-text and domain-agnostic; session/agent/host/runtime/pid
identity is stamped automatically from the process env and the per-pid launch
registry (`lib/session/pid-registry.ts`).

```bash
# Inside an agents-cli run (AGENT_SESSION_ID / AGENTS_MAILBOX_DIR already set):
agents feed post "CHANGELOG pushed; watching CI and mac-mini E2E"
agents feed post "ready for review" --json

# Escape hatch when not in a managed run:
agents feed post "note" --session <session-id>
```

Each post appends a `status.posted` **milestone** to
`~/.agents/.history/activity/<sessionId>.jsonl` — the same activity stream
`agents activity` and the feed’s recent-activity lane already read. It does
**not** create a feed block. Domain facts (tickets, PRs) are not CLI flags;
join them from the session index / live session enrichment at read time.

Identity resolution order: `--session` → `AGENT_SESSION_ID` /
`AGENTS_SESSION_ID` / mailbox basename → `AGENT_LAUNCH_ID` match in the pid
registry → parent-pid walk through `by-pid/<pid>.json`.

### Activity lane (`agents activity`) — progress at a glance, fleet-wide

`agents activity` reads the same append-only activity stream (never re-parsing
transcripts) and, by opt-in, across the whole fleet:

```bash
agents activity                                    # this machine, newest first (default)
agents activity --devices-all --group-by project   # per project: what each agent did, where, for which ticket
agents activity --host yosemite-s1                 # one box over SSH (--device is an alias)
agents activity --devices-all --filter RUSH-2100   # one ticket, fleet-wide
agents activity --milestones                       # only plans / PRs / worktrees / sub-agents
```

- **Fleet fan-out.** `--devices-all` (alias `--hosts-all`) runs the same
  `activity --json` on every reachable device and merges each peer's stream
  host-tagged (feed-style, via `gatherRemoteAgentsJson`); `-H/--host` / `--device`
  scope to specific boxes; `--local` forces local-only. Local-only is the default.
- **Grouping + filter.** `--group-by project|device|agent` buckets the stream;
  `--filter <text>` narrows by project / device / agent / event / ticket. The flat
  newest-first list stays the default.
- **Enrichment (the join, not transcript parsing).** Each item is joined to live
  sessions for the **project** (repo/worktree slug from cwd), the **execution host**
  (`provenance.host` — the box it actually runs on), and the **Linear ticket**
  (`ActiveSession.ticket`). `--json` is a mergeable per-host payload carrying these
  enriched fields.

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

## Accounts & Usage in `agents view`

`agents view` shows, per installed agent, **who's signed in** and (where the
provider exposes it) **live quota**. Two separate passes feed the row, joined by
a stable per-account key:

- **Account identity** — `getAccountInfo` ([`src/lib/agents.ts`](../src/lib/agents.ts))
  is **local-only, no network**. It reads each agent's on-disk credential and
  surfaces an email when one is readable, else a stable account id, else a bare
  `signed in`.
- **Usage bars** — a separate network pass ([`src/lib/usage.ts`](../src/lib/usage.ts))
  fetches live quota and renders `S:`/`W:` bars + plan. It's **stale-while-revalidate**
  (on-disk cache under `~/.agents/.cache/`, keyed per account: 2-min fresh, 24-h
  block) so `agents view` / `agents run` stay off the network on the hot path.

What each agent can surface is bounded by what its local credential actually
contains — this is a data-availability limit, not a policy choice:

| Agent | Account column | Usage bars | How it's derived |
|---|---|---|---|
| Claude | email + plan | live (`api.anthropic.com`) | email/plan/quota from the local OAuth credential + usage API |
| Codex | email + plan | last-seen (session logs) | email/plan from the auth JWT; quota parsed from the newest session's rate-limit event |
| Gemini, Grok | email | — | email read from the local auth file |
| Droid | email | live (`api.factory.ai`) | `~/.factory/auth.v2.file` is AES-256-GCM (key on disk at `auth.v2.key`); decrypt locally, read the email from the WorkOS access-token JWT. That same token authorizes `GET /api/billing/limits` for the three rolling rate-limit windows (5-hour → `S`, weekly → `W`, monthly, detailed-view only). |
| Kimi | `id:<user_id>` + tier | live (`api.kimi.com/coding/v1/usages`) | JWT carries no email — only an opaque `user_id`. Quota + membership tier come from the `/usages` endpoint. |
| Antigravity | `signed in` | — | OAuth grant with no id_token — presence only. File `~/.gemini/antigravity-cli/antigravity-oauth-token`, else macOS keychain / Linux libsecret (`service gemini` + user `antigravity`) |
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

- [Sessions](./05-sessions.md) — the `sessions` subsystem in depth
- Cloud dispatch (`agents cloud --help`)
- Team DAGs (`agents teams --help`)
