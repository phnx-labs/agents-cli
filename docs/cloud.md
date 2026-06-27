# Cloud Dispatch

Run agent tasks on remote infrastructure across multiple cloud backends, with unified status tracking and live log streaming.

## Overview

`agents cloud` dispatches tasks to remote agent environments without requiring
a local CLI session. **Each agent runs in its own cloud** — four providers ship
today: Rush Cloud (Claude against a GitHub repo → PR), Codex Cloud (pre-built
Codex environments), Factory (Droid on a cloud Droid Computer), and Antigravity
(Gemini Managed Agents). Pass `--agent` and the provider is auto-selected;
`--provider` overrides. Every dispatched task is tracked in a local SQLite store
so `agents cloud list` shows the full history across all providers, and transient
states (`queued`, `allocating`, `running`, `input_required`) are refreshed
from the live provider API on each `list` call. Tasks continue running after
you disconnect — reconnect any time with `agents cloud logs <id>`.

### Agent auto-routing

`agents cloud run --agent <id>` routes to that agent's native cloud unless you
pass `--provider`. Resolution precedence (`resolveProvider` in
`src/lib/cloud/registry.ts`): explicit `--provider` > the agent's `cloudProvider`
(declared in the agent registry, `src/lib/agents.ts`) > `cloud.default_provider`
in `~/.agents/agents.yaml` > `rush`.

| Agent | Native cloud | Why |
|---|---|---|
| `claude` | `rush` | Claude Code has no headless Anthropic-hosted dispatch CLI (only `--remote-control`, which bridges a *local* session). Rush runs Claude against a repo → PR. |
| `codex` | `codex` | `codex cloud exec` — first-class native CLI. |
| `droid` | `factory` | Factory Droid Computer (cloud VM) via `droid computer ssh` + remote `droid exec`. |
| `antigravity` | `antigravity` | Gemini Managed Agents Interactions API (remote sandbox). |

## Architecture

```
CLI (agents cloud run ...)
  │
  ├─ resolveProvider()               src/lib/cloud/registry.ts
  │    reads cloud.default_provider  from ~/.agents/agents.yaml
  │    returns CloudProvider impl
  │
  ├─ provider.dispatch(options)      rush.ts | codex.ts | factory.ts
  │    POST to remote API
  │    returns CloudTask { id, status, ... }
  │
  ├─ insertTask(task)                src/lib/cloud/store.ts
  │    SQLite: ~/.agents/.cache/cloud/tasks.db
  │
  └─ renderStream(provider.stream(id))   src/lib/cloud/stream.ts
       SSE parser → CloudEvent union
       renders to terminal (or --json)
       returns { status, summary, prUrl }

agents cloud list
  ├─ listActiveTasks()               refresh transient states from each provider
  └─ listStoredTasks({ provider, status, limit })

agents cloud providers
  └─ getAllProviders()                instantiate all three, report capabilities()
```

## Command Reference

| Command | Description |
|---|---|
| `agents cloud run [prompt]` | Dispatch a task to a cloud agent |
| `agents cloud list` | List cloud tasks (most recent first) |
| `agents cloud status <id>` | Show task detail and latest status |
| `agents cloud logs <id>` | Stream live output from a running task |
| `agents cloud cancel <id>` | Cancel a running task |
| `agents cloud message <id> <text>` | Send a follow-up to a finished or needs-review task |
| `agents cloud providers` | List available providers and their status |

### `cloud run` options

| Flag | Description |
|---|---|
| `--provider <id>` | Cloud backend: `rush`, `codex`, `factory` |
| `--agent <name>` | Agent to run: `claude`, `codex`, `droid` |
| `--repo <owner/repo>` | GitHub repository. Repeatable for multi-repo dispatch (Rush Cloud only) |
| `--branch <name>` | Target git branch |
| `-p, --prompt <text>` | Inline prompt (alternative to positional argument) |
| `--timeout <duration>` | Kill after duration (e.g., `30m`, `2h`) |
| `--model <model>` | Model override |
| `--env <id>` | Codex Cloud environment ID |
| `--computer <name>` | Factory/Droid computer target |
| `--mode <mode>` | Execution mode (`plan`, `edit`, `full`) |
| `-b, --balanced` | Shortcut for `--strategy balanced` |
| `--strategy <strategy>` | Account selection strategy for factory: `balanced` — rotates across all healthy accounts on rate-limit |
| `--upload-account-tokens` | Upload Claude OAuth credentials to Rush Cloud on first dispatch |
| `--json` | Structured JSON output |
| `--no-follow` | Dispatch and exit without streaming output |

### `cloud list` options

| Flag | Description |
|---|---|
| `--provider <id>` | Filter by provider |
| `--status <status>` | Filter by status |
| `--limit <n>` | Max results (default 20) |
| `--json` | JSON output |

### `cloud status` options

| Flag | Description |
|---|---|
| `--json` | JSON output |

### `cloud logs` options

| Flag | Description |
|---|---|
| `-f, --follow` | Follow output (default for running tasks) |
| `--json` | JSON event stream |

## Providers

Four providers are registered at startup (`src/lib/cloud/registry.ts`):

| ID | Name | Dispatch target | Multi-repo |
|---|---|---|---|
| `rush` | Rush Cloud | GitHub repo + branch | Yes — clones each repo into `/workspace/<owner>/<name>/` |
| `codex` | Codex Cloud | Pre-built Codex environment (`--env`) | No — bundle the repos into the env |
| `factory` | Factory (Droid) | Droid Computer (`--computer`) via relay SSH + `droid exec` | No |
| `antigravity` | Antigravity (Gemini) | Gemini Managed Agents remote sandbox | No — raw sandbox, no repo → PR |

The default provider is read from `cloud.default_provider` in
`~/.agents/agents.yaml`. If unset, it falls back to `rush`. Note that an
agent's native cloud (via `--agent`) takes precedence over `default_provider`.

**Factory (Droid).** `droid exec` is synchronous, so a Factory dispatch runs the
remote exec to completion (no live SSE — output appears when the run finishes)
and the task id is droid's own `session_id`. Requires the `droid` CLI, a Factory
login, and a pre-provisioned Droid Computer (`--computer <name>`, or
`cloud.providers.factory.computer`). Create one in Factory (Settings → Droid
Computers) or register a machine with `droid computer register`.

**Antigravity (Gemini).** Talks to the Interactions API
(`POST /v1beta/interactions`, agent `antigravity-preview-05-2026`). The Gemini
API key comes from an `agents secrets` bundle named in
`cloud.providers.antigravity.secretsBundle` (or `GEMINI_API_KEY` /
`GOOGLE_API_KEY` in the env). It is a raw sandbox — no GitHub repo → PR; pass a
repo and it routes you to `--provider rush` instead.

### Provider configuration (`~/.agents/agents.yaml`)

```yaml
cloud:
  default_provider: rush     # optional; defaults to rush

  providers:
    codex:
      env: env_a1b2c3        # default Codex Cloud environment ID
    factory:
      computer: linux-vm-1   # default Droid Computer name
      autonomy: high         # droid exec --auto level (low|medium|high; default high)
    antigravity:
      secretsBundle: gemini.com   # agents secrets bundle holding GEMINI_API_KEY
      # model: antigravity-preview-05-2026   # optional managed-agent override
```

Rush Cloud uses the session token injected by `agents` — no separate config
key is needed.

## Task Lifecycle

Task status values (from `src/lib/cloud/types.ts:19-27`):

```
queued
  │
  ▼
allocating
  │
  ▼
running ──────────────────────────▶ input_required
  │                                   (agent paused, awaiting message)
  │                                        │
  │        agents cloud message <id> ──────┘
  │
  ├── exit OK  ──▶ completed
  ├── exit err ──▶ failed
  └── cancel   ──▶ cancelled
```

`idle` is a long-lived session state — the agent has stopped between turns and
can be resumed via `agents cloud message`. It is distinct from the terminal
states (`completed`, `failed`, `cancelled`) which cannot re-enter `running`.

### Stream events

`agents cloud logs` and the post-dispatch follow mode consume a Server-Sent
Events stream decoded into typed `CloudEvent` values
(`src/lib/cloud/stream.ts:16-57`):

| Event type | Content |
|---|---|
| `text` | Agent's text output — written to stdout |
| `thinking` | Extended reasoning content — written to stderr |
| `tool_use` | Tool invocation — written to stderr |
| `tool_result` | Tool result — acknowledged on stderr |
| `status` | Lifecycle transition |
| `usage` | Token counts and model name |
| `done` | Final status, optional PR URL, optional summary |
| `error` | Error message from the provider |
| `unknown` | Provider event not in the known taxonomy — surfaced, not dropped |

Stream disconnect does not cancel the task. The task continues running; reconnect
with `agents cloud logs <id>`.

## Recipes

### 1. Dispatch to Rush Cloud and stream output

```bash
agents cloud run "fix the flaky e2e in tests/checkout.spec.ts" \
  --provider rush \
  --repo acme/monorepo \
  --branch main
```

### 2. Multi-repo dispatch (Rush Cloud)

Each repo is cloned into `/workspace/<owner>/<name>/` in the pod.

```bash
agents cloud run "rename POST /v1/charge -> /v2/charge across server + extension" \
  --provider rush \
  --repo acme/server \
  --repo acme/extension
```

### 3. Fire-and-forget, then tail logs later

```bash
# Dispatch and exit immediately
TASK=$(agents cloud run "bump tailwind to v4 and fix the breaks" \
  --provider rush --repo acme/monorepo --no-follow --json | jq -r .id)

# Reconnect later
agents cloud logs "$TASK"
```

### 4. Cancel a runaway task

```bash
agents cloud cancel tsk_4f2a91
```

### 5. List all active tasks, refreshed from providers

```bash
# Human-readable table
agents cloud list

# Filter by provider and status
agents cloud list --provider rush --status running

# Machine-readable (used by the observability layer)
agents cloud list --json
```

### 6. Send a follow-up when the agent needs input

```bash
# Agent paused at input_required
agents cloud status tsk_4f2a91

# Unblock it
agents cloud message tsk_4f2a91 "Looks good — also update the OpenAPI spec"
```

### 7. Dispatch to a droid's own cloud (Factory Droid Computer)

`--agent droid` auto-routes to Factory; the run executes `droid exec` on the
named Droid Computer.

```bash
agents cloud run "add a vitest for src/util/slug.ts" \
  --agent droid \
  --computer cloud-vm-1 \
  --autonomy high
```

### 8. Dispatch to Antigravity (Gemini Managed Agents)

`--agent antigravity` auto-routes to the Gemini Interactions API. No repo — it's
a remote sandbox.

```bash
# key resolved from cloud.providers.antigravity.secretsBundle, or GEMINI_API_KEY
agents cloud run "benchmark three JSON parsers and report the fastest" --agent antigravity
```

## Budget Guardrails

Cloud dispatches **inherit the local project's budget caps** (see
[docs/06-observability.md](./06-observability.md#budget-guardrails-agents-budget)).
Before a run is POSTed, its estimated cost is projected onto current spend;
under `on_exceed: block`, a dispatch that would breach a cap is **refused
client-side** with a `[budget] BLOCKED cloud dispatch …` error — the run never
starts. The target repo slug is the project attribution key, so caps span every
agent dispatched against that repo.

Cloud budgeting is **pre-flight only** in v1: the client-side estimate blocks a
dispatch before it is POSTed, but agents-cli does **not** apply its own live
mid-run hard-cap kill to a running cloud task — once a task starts on the
provider, the provider's own controls govern it. The agents-cli live mid-run
kill applies to local headless `agents run` today; a live cloud kill is a
planned follow-up.

## Demo

<video autoplay loop muted playsinline width="100%" src="../assets/videos/cloud.mp4"></video>

## See Also

- [docs/00-concepts.md](./00-concepts.md) — DotAgents repos, resource kinds, `agents.yaml` structure
- [docs/06-observability.md](./06-observability.md) — `agents cloud list --json` as a fleet observability source
- [docs/teams.md](./teams.md) — use `--cloud rush|codex|factory` on `agents teams add` to dispatch cloud teammates from a DAG
