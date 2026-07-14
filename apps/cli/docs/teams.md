# Teams

Coordinate multiple AI agents working in parallel on a shared task, with DAG-based dependency scheduling and live status tracking.

## Overview

`agents teams` groups agent processes into a named team. Each teammate runs
in the background — Claude, Codex, Gemini, Cursor, OpenCode, Grok, or
Antigravity — against the same working directory or a dedicated git worktree.
Teammates can declare `--after` dependencies, forming a directed acyclic graph
(DAG) that the supervisor drains wave by wave. The state machine lives on disk
so the supervisor can be restarted mid-flight without losing work, and
teammates added by other processes (including agents themselves) are picked up
on the next wave.

## Architecture

```
CLI invocations                  Supervisor                   Agent processes
(agents teams add ...)           (teams start --watch)        (claude, codex, ...)

user
  │
  ├─ create team ─────────────▶  registry                     ~/.agents/.history/
  │   (registry.ts)                teams/<name>.yaml            teams/agents/
  │                                                               <uuid>/
  ├─ add teammate ─────────────▶  meta.json (PENDING)           │  meta.json
  │   (api.ts: handleSpawn)         status, prompt, after        │  stdout.log
  │                                                               │  pid
  ├─ add teammate --after bob ─▶  meta.json (PENDING)            │
  │                                                              ...
  └─ teams start --watch ──────▶  runSupervisor() loop
                                   │
                                   ├── rescanFromDisk()
                                   ├── startReady(team)
                                   │    ── resolve deps
                                   │    ── spawn ready agents
                                   ├── listByTask(team)
                                   │    ── count pending/running/done/failed
                                   ├── onWave(summary)
                                   │    ── print or emit JSON
                                   ├── wait intervalMs
                                   └── repeat until drained
```

Teammate state transitions (from `src/lib/teams/agents.ts:109-115`):

```
PENDING ──deps resolved──▶ spawned ──▶ RUNNING ──exit 0──▶ COMPLETED
                                                └─exit ≠0──▶ FAILED
                                                └─stop cmd──▶ STOPPED
```

## Command Reference

| Command | Alias | Description |
|---|---|---|
| `agents teams list [query]` | `ls` | List teams, most recent first |
| `agents teams create <team>` | `c`, `new` | Create a new team |
| `agents teams add <team> <agent> <task>` | `a` | Add a teammate |
| `agents teams status [team]` | `s`, `st`, `check` | Check team progress |
| `agents teams active` | — | All teammates running right now, across all teams |
| `agents teams start [team]` | — | Launch pending teammates whose deps are satisfied |
| `agents teams message <team> <teammate> <message>` | — | Send a follow-up: steers a running teammate via its mailbox, resumes a stopped one |
| `agents teams resume <team> <teammate> [message]` | — | Resume a stopped teammate (re-enter its own session with the message) |
| `agents teams stop [team] [teammate]` | — | Stop a running teammate (resume it later with `teams resume`) |
| `agents teams remove [team] [teammate]` | `rm` | Remove a stopped teammate's logs |
| `agents teams disband [team]` | `d` | Stop all teammates and delete the team |
| `agents teams logs [teammate]` | `log` | Read a teammate's raw stdout |
| `agents teams doctor` | `dr` | Check which agent CLIs are installed |

### `teams list` options

| Flag | Description |
|---|---|
| `-a, --agent <agent>` | Filter to teams containing this agent (e.g. `claude` or `claude@2.1.112`) |
| `--status <status>` | Filter by team status: `working`, `done`, `failed`, `empty` |
| `--since <time>` | Teams active after this time (e.g. `2h`, `7d`, ISO date) |
| `--until <time>` | Teams active before this time |
| `-n, --limit <n>` | Max results (default 20) |
| `--json` | Machine-readable JSON |

### `teams create` options

| Flag | Description |
|---|---|
| `-d, --description <text>` | One-line summary of what this team is working on |
| `--enable-worktrees` | Each teammate works in its own git worktree |
| `--use-worktree <path>` | All teammates share this existing worktree path |
| `--devices <a,b,c>` | Distributed teams: pool of machines the team may run teammates on (alias `--hosts`). See [Distributed teams](#distributed-teams). |
| `--repo <url\|path>` | How each device gets the code (git URL to clone, or a path). Defaults to the local checkout's `origin`. |
| `--json` | Machine-readable JSON |

### `teams add` options

| Flag | Description |
|---|---|
| `-n, --name <name>` | Friendly name (required when using `--after`) |
| `-m, --mode <mode>` | `plan` (read-only) \| `edit` (write files) \| `full` (write + skip prompts). Default: `edit` |
| `-e, --effort <effort>` | `low` \| `medium` \| `high` \| `xhigh` \| `max` \| `auto`. Default: `medium` |
| `--model <model>` | Override effort tier with a specific model (e.g. `claude-opus-4-6`) |
| `--env <key=value>` | Set an env var for this teammate (repeatable) |
| `--cwd <dir>` | Working directory (default: current directory) |
| `--worktree <name>` | Run in a dedicated git worktree (requires `--enable-worktrees` on the team) |
| `--device <host>` | Distributed teams: run THIS teammate on `<host>` (alias `--host`). Works with or without a team pool. See [Distributed teams](#distributed-teams). |
| `--after <names>` | Comma-separated teammate names to wait for before starting |
| `--task-type <type>` | Factory label: `plan` \| `implement` \| `test` \| `review` \| `bugfix` \| `docs` |
| `--cloud <provider>` | Dispatch to cloud backend: `rush` \| `codex` \| `factory` |
| `--repo <owner/repo>` | GitHub repository (required for `--cloud rush`) |
| `--branch <name>` | Target branch for cloud dispatch |
| `--json` | Machine-readable JSON |

### `teams start` options

| Flag | Description |
|---|---|
| `--watch` | Keep polling; fire new waves as deps complete; exit when DAG drains |
| `--interval <seconds>` | Seconds between waves in `--watch` mode (default 8) |
| `--max-waves <n>` | Safety cap on waves (default 1000) |
| `--json` | Emit one JSON object per wave |

### `teams status` options

| Flag | Description |
|---|---|
| `-f, --filter <state>` | Show teammates in state: `running`, `completed`, `failed`, `stopped`, `all` (default: `all`) |
| `-s, --since <iso>` | Cursor from a previous status call; only show updates after this timestamp |
| `--agent-id <id>` | Show only this teammate (UUID or UUID prefix) |
| `-v, --verbose` | Emit full per-teammate detail (prompt, all paths, all messages); default is compact |
| `--json` | Machine-readable JSON (compact by default; pair with `--verbose` for the full shape) |

### `teams logs` options

| Flag | Description |
|---|---|
| `-n, --tail <n>` | Last N lines only |
| `--team <team>` | Disambiguate when the same name appears in multiple teams |

## Resuming a teammate

A teammate often ends its turn with more to do — a PR opened and waiting on review,
a headless run that hit a turn cap, a task you want to redirect after the fact.
`agents teams resume` re-enters that teammate's **own** session with your message as
the next user turn, so it picks up with full context instead of you finishing the
work by hand or spawning a fresh, context-less teammate.

```bash
# A teammate finished with its PR open, waiting on review. Nudge it home:
agents teams resume my-team backend "prix-cloud approved — rebase-merge the PR, then cut the release"
```

`teams message` is the same command with automatic routing by the teammate's current
state:

| Teammate state | What happens |
|---|---|
| running | The message is **steered** into its mailbox and delivered at its next tool call (no re-launch). |
| completed / failed / stopped | The teammate is **resumed** — its session is re-entered with the message. |
| pending (unmet `--after`) | Rejected — run `teams start` to launch it first. |

The teammate re-launches through the same backend it first used (local process or
remote host) in its original working directory / worktree, and flips back to
`running` so `teams status` tracks it live again.

**Every harness.** The resume delegates to `agents run --resume`, so it inherits that
command's coverage: native resume for Claude (`--resume`) and Codex (`resume`), and a
universal `/continue` replay for the rest (OpenCode, Grok, Kimi, …). The session id it
resumes is the teammate's underlying agent session — captured from the agent's own
output — so a non-Claude teammate that died before emitting its first event (no
captured id) is refused with a clear message rather than resumed into a fresh run.

## Boundary Contracts

Boundary contracts are the core correctness mechanism for parallel teams. Every
time you spawn teammates that touch the same codebase, you must declare what
each one owns, what it must not touch, and which shared artifacts one teammate
produces for others to consume.

The format from AGENTS.md (the canonical memory file for this repo):

```
Owns       — explicit files (with line ranges where helpful)
Must NOT   — files owned by others
Shared deps — one canonical owner; everyone else imports
```

The **independence test**: if teammate A must wait for teammate B's output
before A can start work, the boundary is wrong. Re-cut the split so each
teammate can start from the same baseline, or sequence them explicitly with
`--after`.

### Why this matters

Teammates coordinate via git and the filesystem only. There is no direct
peer-to-peer communication at runtime. The boundary contract is the only
coordination mechanism that runs before the agents start — once they are
running, violations (two agents editing the same file) cause merge conflicts,
test failures, or silent data loss.

### Contract in practice

Before spawning a team, write out the distribution plan:

```
auth teammate  — owns src/auth/* (all files)
               — must NOT touch src/ui/*, src/api/*
               — produces: src/auth/types.ts (shared dep)

ui teammate    — owns src/ui/login.tsx
               — must NOT touch src/auth/*
               — imports: src/auth/types.ts (read-only)
               — must NOT start until auth is done (use --after auth)
```

The `--after` flag enforces temporal ordering. Without `--after`, both
teammates start on wave 1 and race. Without a boundary contract, they race
invisibly — the contract makes the race explicit so you can cut it correctly.

### Worktrees and isolation

When hard filesystem isolation is required, use git worktrees:

```bash
agents teams create my-feature --enable-worktrees
agents teams add my-feature claude "..." --name alice --worktree feature-alice
agents teams add my-feature codex  "..." --name bob   --worktree feature-bob
```

Each teammate gets its own checkout of the branch. Worktrees are cleaned up on
`teams stop` or `teams disband` unless uncommitted changes are present, in
which case the worktree is kept and reported.

## Distributed teams

Teammates can run on **different machines** across your fleet, not just the box
running `teams start`. One orchestrator still drives the DAG, polls status, and
cleans up — teammates just execute over SSH on their assigned host (via the same
device registry as `agents devices` / `agents ssh`).

There is one vocabulary — `--device` / `--devices` (aliases `--host` / `--hosts`) —
and everything is optional; omit it all and teams behave exactly as before (every
teammate local).

**Send one teammate elsewhere** — no pool needed:

```bash
agents teams create feat
agents teams add feat claude "build the API"  --name backend --device yosemite-s0
agents teams add feat claude "build the UI"   --name ui         # stays local
agents teams start feat --watch
```

**A distributed team with a device pool** — unpinned teammates auto-schedule:

```bash
agents teams create feat --devices zion,yosemite-s0,yosemite-s1 \
  --repo https://github.com/you/your-repo.git
agents teams add feat claude "..." --name w1                    # auto-scheduled (least-loaded)
agents teams add feat claude "..." --name w2 --device yosemite-s1   # or pin
agents teams start feat --watch
```

**Where a teammate runs** — resolved at launch, top-down:

1. teammate has `--device X` → **X** (explicit pin — no pool required)
2. else the team pool is a **single** device → that device (whole team there)
3. else the team pool has **many** devices → **auto-scheduled** (least-loaded)
4. else (no pin, no pool) → **local**, exactly like today

**Repo provisioning.** The team's `--repo` (defaulting to the local checkout's
`origin`) is used to ensure the code is present on each device — an existing
checkout is reused, otherwise it is cloned into `~/.agents/repos/<team>`. With
`--enable-worktrees`, each remote teammate also gets its own worktree on the host,
branched off the freshly-fetched default branch, and cleaned up on stop/disband.

`teams status` and `teams logs` show which host each teammate is on and stream its
output back (the local log mirror is capped so a large fleet can't blow up the
orchestrator). **v1 note:** remote teammates require a POSIX host (Linux/macOS);
Windows hosts are rejected with a clear message.

## Recipes

### 1. Two-teammate parallel docs job

```bash
agents teams create docs-update

agents teams add docs-update claude \
  "Rewrite docs/api.md — cover every endpoint in src/routes/" \
  --name api-docs --mode plan

agents teams add docs-update codex \
  "Update docs/config.md — document every option in src/config.ts" \
  --name config-docs --mode plan

# Both start immediately (no --after)
agents teams start docs-update
agents teams status docs-update
```

### 2. DAG with --after dependency

```bash
agents teams create pricing-page

agents teams add pricing-page claude \
  "Rewrite /v2/pricing endpoint" --name backend

agents teams add pricing-page codex \
  "Build /pricing route with three-tier layout" --name frontend

# QA waits for both
agents teams add pricing-page claude \
  "Run Playwright suite, fix flakes" --name qa --after backend,frontend

# Watch mode — supervisor fires QA when backend AND frontend complete
agents teams start pricing-page --watch
```

### 3. Cloud dispatch for one teammate

```bash
agents teams create backend-fix

agents teams add backend-fix claude \
  "Fix the flaky payment test" --name fixer \
  --cloud rush --repo acme/monorepo --branch main

agents teams start backend-fix
agents teams status backend-fix
```

### 4. Git worktree per teammate

```bash
agents teams create parallel-refactor --enable-worktrees

agents teams add parallel-refactor claude \
  "Refactor auth module" --name auth \
  --worktree refactor-auth --name auth

agents teams add parallel-refactor codex \
  "Refactor billing module" --name billing \
  --worktree refactor-billing

agents teams start parallel-refactor --watch
```

### 5. Monitor with --watch and inspect JSON per wave

```bash
# Watch mode, one JSON line per wave — pipe to jq for dashboards
agents teams start my-team --watch --json | \
  jq '{ wave, launched, pending, running, completed, failed }'
```

### 6. Inspect team state via JSON

```bash
# Compact status as JSON (default; drops prompt, folds file paths to basenames)
agents teams status my-team --json

# Full status as JSON (legacy shape — prompt, all paths, all messages)
agents teams status my-team --json --verbose

# All teams as JSON (used by agents-cli observability layer)
agents teams list --json
```

## Budget Guardrails

Teammates **inherit the project's budget caps** (see
[docs/06-observability.md](./06-observability.md#budget-guardrails-agents-budget)).
Before each teammate launches, its estimated cost is projected onto current
spend; under `on_exceed: block`, a teammate that would breach `per_run`,
`per_day`, `per_agent`, or `per_project` is **refused** and the spawn fails with
a `[budget] BLOCKED teammate …` error. Because the caps aggregate across
vendors, a Claude teammate and a Codex teammate draw down the *same*
`per_project` / `per_day` pool — one budget governs the whole team regardless of
which CLIs it uses.

Teammate budgeting is **pre-flight only** in v1: a teammate is estimated and
blocked *before* it spawns, but there is **no live mid-run hard-cap kill** for
teammates (they spawn through the teams runner, not the headless `agents run`
kill path). The live mid-run kill applies to local headless `agents run` today;
extending it to teams is a planned follow-up.

Set caps in the project's `agents.yaml`:

```yaml
budget:
  per_project: 100.00   # the whole team shares this
  on_exceed: block
```

## Demo

<video autoplay loop muted playsinline width="100%" src="../assets/videos/teams.mp4"></video>

## See Also

- [docs/00-concepts.md](./00-concepts.md) — DotAgents repos, resource resolution model
- [docs/06-observability.md](./06-observability.md) — `agents teams list --json` as a fleet observability source
- [docs/cloud.md](./cloud.md) — cloud dispatch (`--cloud rush|codex|factory` on `teams add`)
