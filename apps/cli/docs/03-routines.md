# Routines (Scheduled Jobs)

Scheduled agent execution with sandboxed permissions and daemon-driven cron scheduling.

## Architecture

```
~/.agents/
  routines/
    daily-review.yml        # Job config (YAML)
    weekly-cleanup.yml
  daemon/
    state.json              # Daemon PID, last reload timestamp
```

Each job is a YAML file in `~/.agents/routines/`. A background daemon (`agents daemon`) parses cron expressions with [croner](https://github.com/hucsm/croner), spawns agent processes at trigger time, and captures output.

### Project routines (inspection-only)

`agents routines list` and `agents routines view <name>` also discover routines in `<project>/.agents/routines/` when invoked from inside a project — project routines shadow user routines of the same name in those views.

Execution paths are intentionally **not** project-aware:

- `agents routines run <name>` only resolves user routines. A project routine spawns a full agent session with a YAML-supplied prompt, so honoring the project layer would let a cloned public repo prompt-inject the user's next Claude session via `.agents/routines/<name>.yml`.
- `add`, `edit`, `remove`, `pause`, `resume` are mutation surfaces and stay on the user layer.
- The background scheduler (which runs from `$HOME`) only loads user routines.

If you want to run a project routine, copy the YAML body into `~/.agents/routines/<name>.yml` first; that materializes consent.

### Ending a recurring routine

Set `endAt` (ISO 8601) on a recurring routine to have the scheduler auto-disable it on or after that time:

```bash
agents routines add cleanup --schedule "0 3 * * *" --agent claude \
  --prompt "Tidy logs" --end-at "2026-12-31T23:59:00Z"
```

## Job Config

```yaml
# ~/.agents/routines/daily-review.yml
name: daily-review
schedule: "0 9 * * *"         # 9am daily (cron syntax)
agent: claude
version: 2.0.65               # Optional, uses global default if omitted
mode: auto                    # auto (default), plan (read-only), edit, or skip
effort: default               # fast, default, or detailed
timeout: 10m
runOnce: false                # true for one-shot jobs (--at)
endAt: "2026-12-31T23:59:00Z" # optional: auto-disable on/after this time
devices:                      # optional: allowlist — each listed device fires independently
  - yosemite-s0               # omit entirely (or --clear) for unrestricted
  - mac-mini

prompt: |
  Review open PRs and summarize status.

allow:
  dirs:
    - ~/projects/myapp
  tools:
    - Bash(git *)
    - Read
    - Grep
```

### One-Shot Jobs

```bash
agents routines add reminder --at "14:30" --agent claude --prompt "Remind Muqsit to stand up"
```

`--at` accepts `"14:30"` (today at that time) or `"2026-02-24 09:00"` (absolute). The daemon converts it to a cron expression with `runOnce: true`.

### Webhook Triggers

Routines can fire from signed GitHub or Linear webhooks instead of a cron
schedule. The same detached runner path is used as scheduled jobs.

```bash
agents routines add agent-labeled-issue \
  --on linear:Issue \
  --action update \
  --team-key RUSH \
  --label agent \
  --agent claude \
  --prompt "Work the Linear issue that was just labeled agent"
```

Equivalent YAML:

```yaml
name: agent-labeled-issue
trigger:
  type: linear_event
  event: Issue
  action: update
  teamKey: RUSH
  label: agent
agent: claude
prompt: "Work the Linear issue that was just labeled agent"
```

GitHub triggers use `type: github_event` with optional `repo` and `branch`:

```bash
agents routines add pr-review \
  --on github:pull_request \
  --repo phnx-labs/agents-cli \
  --branch main \
  --agent claude \
  --prompt "Review the pull request"
```

Run the localhost receiver with signing keys from an `agents secrets` bundle:

```bash
agents webhook serve --secrets-bundle webhooks --port 8787
```

The bundle may contain `GITHUB_WEBHOOK_SECRET`, `LINEAR_WEBHOOK_SECRET`, or both.
The receiver accepts `POST /hooks/github` and `POST /hooks/linear`, rejects
unsigned deliveries, dedupes repeated delivery IDs, rate-limits each source, and
binds `127.0.0.1` by default.

Expose the receiver publicly from a Linux/macOS Tailscale node with Funnel:

```bash
agents funnel up yosemite-s0 --local-port 8787 --port 443
agents funnel status yosemite-s0
```

Funnel public ports are limited to `443`, `8443`, and `10000`; `agents funnel up`
validates that before running the remote Tailscale CLI.

### Device Allowlist

`~/.agents/routines/` rides the user repo, so every routine syncs to every machine —
and without a restriction, an enabled routine fires on **every** device running the
scheduler. Set `devices:` to restrict which machines may execute the job:

```yaml
# ~/.agents/routines/drain.yml
name: drain
schedule: "0 3 * * *"
agent: claude
devices:
  - yosemite-s0
  - mac-mini
prompt: "Drain the local work queue"
```

Each listed machine fires the job **independently** on its own schedule — both
`yosemite-s0` and `mac-mini` run their own copy, with their own run history.
A single-entry list is equivalent to an exclusive pin: `devices: [yosemite-s0]`
restricts the job to one machine.

Or set the allowlist at creation with `--devices`:

```bash
agents routines add drain --schedule "0 3 * * *" --agent claude \
  --devices yosemite-s0,mac-mini --prompt "Drain the local work queue"
```

`--devices` is validated against the registered fleet (`agents devices sync`).

Device names are compared against the local `machineId()` (normalized hostname, as
shown by `agents devices`), so `Yosemite-S0` and `yosemite-s0.tailnet.ts.net` both
match `yosemite-s0`.

**Omitting `devices:` means unrestricted** — the job fires on every device running
the scheduler. `--clear` restores unrestricted behavior (see below).

On a device not in the allowlist the job is fully inert:

- the cron scheduler skips it
- webhook triggers never match it
- it is never counted overdue, so `catchup` won't fire it and the daemon won't nag
- detached daemon fires and one-shot `--at` jobs skip it
- `agents routines run <name>` errors, naming the allowed devices and offering a
  ready-to-paste `--host <device>` command to run it remotely

`agents routines list` shows the allowlist in a **Devices** column. Unrestricted
jobs display the word `all`; restricted lists are grayed when the local machine
is not in the list. `--json` includes a `devices` array and `runsHere` boolean.

#### v12 migration

Existing routines that use the legacy singular `device: X` field are automatically
migrated to `devices: [X]` on the next load. No manual edit is required.

#### Managing the allowlist

`agents routines devices <name>` opens a preselected multi-select so you can toggle
devices without editing the YAML:

```bash
agents routines devices drain
```

The picker starts with the current allowlist pre-checked. Confirm to overwrite.
`--set` and `--clear` are mutually exclusive.

For scripting:

```bash
agents routines devices drain --set yosemite-s0,mac-mini  # replace allowlist
agents routines devices drain --clear                      # remove allowlist (unrestricted)
```

### Remote Routing

`--host <device>` (alias: `--device`) routes any `routines` subcommand to a remote
machine over SSH, so you can query or trigger a job on another box without an
explicit `agents ssh` call:

```bash
# List another device's routines
agents routines list --host yosemite-s0

# Trigger a job on a specific machine right now
agents routines run drain --host yosemite-s0

# Create a job pre-assigned to two hosts, then confirm it looks right on one
agents routines add drain --schedule "0 3 * * *" --agent claude \
  --devices yosemite-s0,mac-mini --prompt "Drain queue" --host yosemite-s0
```

When you try to run a job on a host outside its allowlist, the CLI prints:

```
Job 'drain' can only run on: yosemite-s0, mac-mini
  agents routines run drain --host yosemite-s0
```

## Sandbox Isolation

Each job runs with `HOME` set to an overlay directory:

```
~/.agents/routines-sandbox/daily-review-<timestamp>/
  .claude/
    settings.json             # Generated with allow.tools permissions
  projects -> ~/projects      # Symlink from allow.dirs
```

The agent can only:
- See directories listed in `allow.dirs`
- Use tools listed in `allow.tools`
- Cannot access `~/.ssh`, `~/.gitconfig`, etc.

### Headless claude auth

The sandbox overlay builds a clean `HOME` with no Claude credentials — the real
`~/.claude/` (and its OAuth tokens) is invisible to the spawned process by design.
A routine that drives headless `claude` will fail authentication unless one of two
conditions is met.

**Current workaround — `sandbox: false`**

Set `sandbox: false` on the routine to skip overlay creation. The agent inherits
the daemon's full environment, including `CLAUDE_CODE_OAUTH_TOKEN` if the daemon
was started with it (`runner.ts:218`):

```yaml
name: my-claude-routine
schedule: "0 9 * * *"
agent: claude
sandbox: false            # overlay HOME has no claude credentials
prompt: |
  Do something useful.
```

**Why `sandbox: false` works, and why the default does not**

When the daemon starts, it reads `CLAUDE_CODE_OAUTH_TOKEN` from the `claude`
secrets bundle (`daemon.ts:550-563`) and bakes it into the daemon process
environment (`daemon.ts:820-821`). With `sandbox: true` (the default),
`buildSpawnEnv` only forwards keys in `ENV_ALLOWLIST` — `CLAUDE_CODE_OAUTH_TOKEN`
is not on that list (`sandbox.ts:28-49`), so the token is stripped before the
agent launches. `sandbox: false` sidesteps this by passing `process.env` directly,
which includes the daemon-level token.

To store the token in the `claude` secrets bundle:

```bash
agents secrets set claude CLAUDE_CODE_OAUTH_TOKEN <token>
# Restart the daemon so the updated token is baked into its environment:
agents routines stop && agents routines start
```

## Execution Flow

Temporal sequence from cron fire to report saved.

```
croner            JobScheduler          runner.ts           sandbox.ts       spawned agent       filesystem
(library)         scheduler.ts:20       executeJob          prepareJobHome   (claude/codex/      ~/.agents-system/runs/
                                                                              gemini)

     │                  │                  │                    │                │                    │
     ●──fire callback──▶│                  │                    │                │                    │
     │                  │                  │                    │                │                    │
     │                  │──onTrigger(cfg)──▶                    │                │                    │
     │                  │  (scheduler.ts:42)                    │                │                    │
     │                  │                  │                    │                │                    │
     │                  │                  │──resolveJobPrompt──│                │                    │
     │                  │                  │  + buildJobCommand │                │                    │
     │                  │                  │  (runner.ts:40)    │                │                    │
     │                  │                  │                    │                │                    │
     │                  │                  │  if sandbox≠false: │                │                    │
     │                  │                  │──prepareJobHome───▶│                │                    │
     │                  │                  │                    │                │                    │
     │                  │                  │                    ├─rm old overlay─────────────────────▶│
     │                  │                  │                    ├─mkdir ~/.agents/routines/{name}/home▶│
     │                  │                  │                    ├─generateClaudeConfig (etc.)────────▶│ .claude/
     │                  │                  │                    │                                    │   settings.json
     │                  │                  │                    ├─symlinkAllowedDirs─────────────────▶│ home/<dir>->...
     │                  │                  │                    │                │                    │
     │                  │                  │◀──overlayHome──────│                │                    │
     │                  │                  │                    │                │                    │
     │                  │                  │──buildSpawnEnv─────▶│                │                    │
     │                  │                  │  HOME=overlay      │                │                    │
     │                  │                  │  + ENV_ALLOWLIST   │                │                    │
     │                  │                  │  (sandbox.ts:19)   │                │                    │
     │                  │                  │                    │                │                    │
     │                  │                  ├─mkdir runDir, open stdout fd────────────────────────────▶│ runs/{job}/{runId}/
     │                  │                  ├─writeRunMeta(status='running')──────────────────────────▶│   meta.json
     │                  │                  │                    │                │                    │
     │                  │                  ├─spawn(cmd, {       │                │                    │
     │                  │                  │    detached:true,  │                │                    │
     │                  │                  │    stdio:[ign,     │                │                    │
     │                  │                  │          fd, fd],  │                │                    │
     │                  │                  │    env: spawnEnv   │                │                    │
     │                  │                  │  })  runner.ts:159─────────────────▶●                    │
     │                  │                  │                    │                │──stdout────────────▶│ stdout.log
     │                  │                  │                    │                │                    │
     │                  │                  │  setTimeout(timeout)                │                    │
     │                  │                  │  runner.ts:170     │                │                    │
     │                  │                  │                    │                ●──agent runs──       │
     │                  │                  │                    │                │   prompt, uses     │
     │                  │                  │                    │                │   allowed tools    │
     │                  │                  │                    │                ●──exits(code)───    │
     │                  │                  │◀───────'exit'──────────────────────────────────────────  │
     │                  │                  │                    │                │                    │
     │                  │                  ├─writeRunMeta(status=code===0 ? 'completed' : 'failed')──▶│ meta.json
     │                  │                  │                    │                │                    │
     │                  │                  ├─extractAndSaveReport(stdoutPath, agent, runDir)─────────▶│ report.md
     │                  │                  │  runner.ts:271     │                │                    │
     │                  │                  │                    │                │                    │
     │                  │◀──resolve────────│                    │                │                    │
     │                  │                  │                    │                │                    │
     │                  │  if runOnce:     │                    │                │                    │
     │                  │  ├─unschedule    │                    │                │                    │
     │                  │  └─deleteJob     │                    │                │                    │
     ▼                  ▼                  ▼                    ▼                ▼                    ▼
```

On timeout: the setTimeout at `runner.ts:170` fires, sends `SIGTERM` to the
process group (`process.kill(-child.pid, 'SIGTERM')`), waits 5s, then
`SIGKILL`. Report extraction runs regardless — a truncated stdout is still
valuable.

## Run State Machine

Each `RunMeta.status` value maps to one terminal state. Transitions are
one-shot — a run never re-enters `running` once it leaves.

```
                        ┌─────────────┐
                        │  (spawned)  │
                        └──────┬──────┘
                               │
                               ▼
              writeRunMeta(status='running')
              runner.ts:149
                               │
                               │
         ┌─────────────────────┼─────────────────────┐
         │                     │                     │
         │                     │                     │
         ▼                     ▼                     ▼
    exit code=0          exit code≠0         timeout fires
    runner.ts:200        runner.ts:200       runner.ts:184
         │                     │                     │
         ▼                     ▼                     ▼
    ┌─────────┐           ┌────────┐            ┌─────────┐
    │completed│           │ failed │            │ timeout │
    └─────────┘           └────────┘            └─────────┘
                                                      │
                                                      │
                                             SIGTERM → wait 5s → SIGKILL
                                             report still extracted from
                                             partial stdout
```

Plus one error branch: `child.on('error')` at `runner.ts:208` (spawn itself
failed — binary not found, EACCES, etc.) → `status='failed'` with `exitCode=null`.

## Sandbox Data Flow

What `prepareJobHome` produces on disk, given a job config.

```
Input:  JobConfig                                Output:  ~/.agents/routines/{name}/home/

┌──────────────────────────┐                    ┌─────────────────────────────────────────┐
│ name: daily-review       │                    │ (cleanJobHome removes any prior overlay)│
│ agent: claude            │                    │                                         │
│ mode: plan               │  prepareJobHome    │ .claude/                                │
│ allow:                   │  sandbox.ts:74     │   settings.json  ← generateClaudeConfig │
│   dirs:                  │                    │                    - mode → permMode    │
│     - ~/projects/myapp   │ ─────────────────▶ │                    - allow.tools        │
│   tools:                 │                    │                    - SAFE_TOOLS expand  │
│     - Bash(git *)        │                    │                                         │
│     - Read               │                    │ myapp -> /Users/you/projects/myapp      │
│     - web_search         │                    │   (symlink, from allow.dirs)            │
│                          │                    │                                         │
└──────────────────────────┘                    └─────────────────────────────────────────┘

                                                 Env handed to child process:
                                                 (sandbox.ts:52, buildSpawnEnv)
                                                 ┌─────────────────────────────────────────┐
                                                 │ HOME=~/.agents/routines/daily-review/home│
                                                 │ + forwarded from parent only if in      │
                                                 │   ENV_ALLOWLIST (sandbox.ts:19):        │
                                                 │   PATH, SHELL, TERM, LANG, LC_*, USER,  │
                                                 │   TMPDIR, XDG_*, NVM_DIR, NODE_PATH,    │
                                                 │   BUN_INSTALL, EDITOR, VISUAL, NO_COLOR │
                                                 │   FORCE_COLOR                           │
                                                 │ + TZ (if config.timezone)               │
                                                 │                                         │
                                                 │ Everything else (AWS_*, OPENAI_API_KEY, │
                                                 │ GITHUB_TOKEN, etc.) is DROPPED.         │
                                                 └─────────────────────────────────────────┘
```

Tools in `allow.tools` are expanded per two small tables at `sandbox.ts:43-49`:

- `SAFE_TOOLS` — safe wildcards (`web_search` → `WebSearch(*)`, `web_fetch` → `WebFetch(*)`)
- `DIR_SCOPED_TOOLS` — always scoped, never wildcarded (`read`, `write`, `edit`, `glob`, `grep`, `notebook_edit`). A bare `Read` in config expands to `Read(dir1)`, `Read(dir2)`… for each entry in `allow.dirs`.

This is the core isolation invariant: the spawned agent's view of the
filesystem is **only** the symlinks we created in the overlay, plus any
file:// paths its tools touch via the allowed-tool expansion. No `~/.ssh`,
no `~/.gitconfig`, no ambient AWS/OPENAI keys.

### Run Output

Each execution creates a run directory with structured output:

```
~/.agents/
  runs/
    daily-review/
      2026-04-17T09:00:00.000Z/
        stdout.log                    # Full terminal output
        stderr.log                    # Error output
        exit-code                     # Exit status (0, 1, etc.)
        report.md                     # Extracted report
        meta.json                     # { agent, version, mode, status, durationMs }
```

## Commands

```bash
# Lifecycle
agents routines list                  # List all jobs with next run + status
agents routines list --host yosemite-s0  # List another device's routines
agents routines add <name> --schedule "0 9 * * *" --agent claude --prompt "..."  # Inline
agents routines add <name> --devices yosemite-s0,mac-mini --schedule "0 3 * * *" \
  --agent claude --prompt "..."       # Add with device allowlist
agents routines add <path.yml>        # Add from YAML file
agents routines add <name> --at "14:30" --agent claude --prompt "..."            # One-shot
agents routines edit <name>           # Open job in $EDITOR
agents routines remove <name>         # Delete a job
agents routines pause <name>          # Disable a job
agents routines resume <name>         # Re-enable a paused job

# Device allowlist management
agents routines devices <name>                         # Interactive multi-select picker
agents routines devices <name> --set yosemite-s0,mac-mini  # Replace allowlist
agents routines devices <name> --clear                 # Remove allowlist (unrestricted)

# Execution
agents routines run <name>            # Run immediately in foreground
agents routines run <name> --host yosemite-s0  # Run on a specific remote device
agents routines view <name>           # Show job config
agents routines runs <name>           # View execution history (last 10)
agents routines logs <name>           # Show stdout from latest run
agents routines logs <name> --run <id>  # Show specific run
agents routines report <name>         # Show report from latest run
agents routines report <name> --run <id>  # Show specific run report

# Scheduler (auto-starts on first `routines add`; these are manual controls)
agents routines start                 # Start the background scheduler
agents routines stop                  # Stop the scheduler
agents routines status                # Show scheduler status + upcoming runs
agents routines scheduler-logs        # Read scheduler log output

# Deprecated (removed in v2.0): `agents daemon start|stop|status|logs`
```

### Non-Interactive Usage

For scripting, pass explicit names and flags to avoid interactive pickers:

```bash
# Add a job without pickers
agents routines add morning-briefing --schedule "0 8 * * 1-5" \
  --agent claude --mode plan --prompt "Summarize overnight changes in the repo"

# Run a job in the foreground
agents routines run morning-briefing

# View the report
agents routines report morning-briefing
```

## Scheduler

A background scheduler (historically called "the daemon" internally) watches for cron-triggered jobs. It persists across CLI invocations and auto-reloads when job configs change.

```bash
agents routines start     # Start manually (usually unnecessary)
agents routines stop      # Stop
agents routines status    # Check health, PID, binary, heartbeat, and upcoming runs
```

The scheduler **auto-starts on the first `agents routines add`**, so in most cases you never invoke `start` manually. When you `add`, `remove`, `pause`, or `resume` a job, it auto-reloads -- no manual restart needed.

`agents routines status` reports the scheduler as `running`, `wedged`, or `stopped`. A live PID whose heartbeat is more than three monitor ticks old is `wedged`; the status output includes the restart command. Both `routines list` and `routines status` also finalize orphaned `running` records before rendering. Run metadata records process birth time to reject recycled PIDs, and any run still active after 24 hours is finalized as a timeout.

The status output includes the resolved daemon binary. Startup rejects bun virtual-filesystem paths and warns when the binary lives inside `.agents/worktrees/`, because deleting that worktree would strand the service.

The legacy `agents daemon <cmd>` subcommands still work but print a deprecation warning and will be removed in v2.0.

## Key Functions

| Function | File | Purpose |
|------|------|------|
| `listJobs()` | routines.ts | List all configured jobs |
| `writeJob()` / `readJob()` | routines.ts | Persist job config |
| `executeJob()` | runner.ts | Run job with sandbox isolation |
| `createOverlay()` | sandbox.ts | Create HOME overlay with permissions |
| `scheduleJob()` | scheduler.ts | Register cron trigger |
| `signalDaemonReload()` | daemon.ts | Notify daemon to reload config |
| `parseAtTime()` | routines.ts | Parse --at time strings to cron |
| `getLatestRun()` / `listRuns()` | routines.ts | Query execution history |
| `jobRunsOnThisDevice()` | routines.ts | Check if job is eligible on current machine |
