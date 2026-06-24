# Observability

Using agents-cli as a programmatic observability layer for agent fleets.

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
