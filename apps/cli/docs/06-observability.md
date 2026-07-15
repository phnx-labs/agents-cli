# Observability

Using agents-cli as a programmatic observability layer for agent fleets.

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

```bash
agents events                          # recent activity across everything
agents events --module teams           # team lifecycle (create / add / disband)
agents events --module secrets         # every secret accessed or revealed
agents events --command "teams create" # a command path — prefix match
agents events --event teams.disband    # a semantic event: a team torn down
agents events --event secrets.get --since 7d --json
agents events -f                       # live tail of today's log
```

`--module` filters the top-level group; `--command` matches a command path by
prefix (`teams` catches `teams create`); `--event` filters a typed event
(repeatable); `--since` takes `2h`/`7d`/`4w` or an ISO date. `--json` emits the
raw records for external consumers.

**Secret-bundle reads are audited at the read, not just at the command.**
`agents events --module secrets` (or `--event secrets.get`) surfaces every path
that resolves a secret VALUE out of a bundle — `run --secrets`, `secrets
exec`/`export`, the MCP `get_secret` tool, `secrets view --reveal`, the raw
`secrets get <item>`, `secrets push` (which reads the whole bundle to upload
it), and remote `bundle@host` resolves. (Value reads in adjacent subsystems that
don't go through the bundle resolver — e.g. `wallet`, profile auth tokens — are
not part of this `secrets.*` stream.) Each record carries a `source` telling you
HOW it was read — `keychain` (real Touch-ID read), `agent` (served from the unlocked
broker), `reveal`, `raw-item`, `sync-push`, or `remote` (with the `host`) — plus
the `bundle`, `caller`, `keyCount`, and OS-user/host/transport. The resolved
**value is never written to the log** — only names and counts. Note the event
log has a 7-day retention (older daily files are pruned), so export what you need
for long-term records.

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
| `agents sessions --json` | What local CLI and team-spawned agents have run recently? | Claude, Codex, Gemini, OpenCode, OpenClaw on this laptop | Pure-cloud runs with no local file |
| `agents cloud list --json` | What am I running on remote VMs right now? | Rush Cloud, Codex Cloud, Factory | Local sessions |
| `agents teams list --json` | What multi-agent DAGs are active? | All team-coordinated runs | Standalone agents |

`agents sessions --active --json` includes `attachments` for prompt-side
screenshots and files when the source transcript carries a local path. Each entry
contains `path`, `name`, `mediaType`, and `sizeBytes` so consumers such as Factory
can render thumbnails and open the original attachment without re-reading the raw
agent transcript.

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

## Cost & Duration Rollup (`agents cost`)

Every session is priced at scan time: `cost_usd = Σ tokens × per-model price`
and `duration_ms = lastTs − firstTs` are persisted on the session row (schema
v6). The price table is offline and versioned — no API calls, no telemetry —
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
| Droid | email | — | `~/.factory/auth.v2.file` is AES-256-GCM (key on disk at `auth.v2.key`); decrypt locally, read the email from the WorkOS access-token JWT. No network. Plan needs an authed call, so it's omitted. |
| Kimi | `id:<user_id>` + tier | live (`api.kimi.com/coding/v1/usages`) | JWT carries no email — only an opaque `user_id`. Quota + membership tier come from the `/usages` endpoint. |
| Antigravity | `signed in` | — | OAuth grant with no id_token — presence only. File `~/.gemini/antigravity-cli/antigravity-oauth-token`, else macOS keychain / Linux libsecret (`service gemini` + user `antigravity`) |
| others | `not signed in` unless a credential exists | — | `default` case: no detector |

Two deliberate boundaries worth knowing:

- **Droid decrypts a local credential.** We read the user's own credential to
  show their own email — the same thing the `droid` CLI does. If it can't be
  decrypted (a `keyring-v2`/legacy login with no on-disk key), the row falls
  back to `signed in` rather than blanking.
- **Kimi usage never refreshes the token.** `agents view` is a read/inspect
  command, so it must not rotate the user's OAuth credential (rewriting the
  file, invalidating the refresh token, racing a running `kimi`). An expired
  token simply falls back to the cached snapshot; the `kimi` CLI refreshes on
  its own launch.

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
