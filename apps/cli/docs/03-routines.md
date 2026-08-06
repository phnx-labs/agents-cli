# Routines (Scheduled Jobs)

Scheduled agent execution with sandboxed permissions and scheduler-driven cron execution.

## Architecture

```
~/.agents/
  routines/
    daily-review.yml        # Job config (YAML)
    weekly-cleanup.yml
  daemon/
    state.json              # Daemon PID, last reload timestamp
```

Each job is a YAML file in `~/.agents/routines/`. A background scheduler parses cron expressions with [croner](https://github.com/hucsm/croner), spawns agent processes at trigger time, and captures output.

### Project routines (opt-in daemon firing)

`agents routines list` and `agents routines view <name>` also discover routines in `<project>/.agents/routines/` when invoked from inside a project — project routines shadow user routines of the same name in those views.

**Daemon firing is opt-in.** A cloned public repo's `.agents/routines/*.yml` never auto-executes. To schedule project routines:

```bash
# From inside the project (or pass the path). Confirms interactively unless --yes.
agents routines enable-project
agents routines enable-project /path/to/repo --yes

# Refresh user-layer copies after editing project YAML
agents routines sync
agents routines sync /path/to/repo

# See which projects are on the allowlist
agents routines projects

# Reverse
agents routines disable-project --remove-synced
```

What happens on enable/sync:

1. The project root is recorded in `~/.agents/agents.yaml` under `routines.projects`.
2. Each `.agents/routines/*.yml` is materialised into `~/.agents/routines/<name>.yml` with a `source:` block (`kind: project`, `projectPath`, and git `repo`/`branch`/`commit` when known).
3. The daemon (which only loads user + system layers) can now fire them. Reload (`SIGHUP` / `agents routines` mutations) re-syncs opted-in projects automatically.
4. Hand-authored user routines of the same name are never overwritten.

`agents routines list` groups terminal output by effective device/host scope so it is clear what runs on the current machine, the fleet, cloud, named devices, and named hosts. Use `agents routines list --flat` for the legacy single table, or `--json` for the flat machine-readable payload. Project-sourced routines still show the source repo (and `@branch` when known) in the Repo column; `--json` includes `source`, `sourceRepo`, `sourceBranch`, `hostStrategy`, `oneShot`, and `expired`.

A project may also declare `routines: { enable: true }` in its own `agents.yaml` as a documentation signal; daemon firing still requires the explicit `enable-project` allowlist step so consent is materialised into the user layer.

### Host placement strategy

Where the **job body** runs when the daemon fires it (`devices` still controls which daemon may *fire*):

| Strategy | YAML | CLI | Behaviour |
| --- | --- | --- | --- |
| `local` | `hostStrategy: local` (default) | `--placement local` | Run on the firing machine |
| `host` | `hostStrategy: host` + `host: <name>` | `--placement host --run-on <name>` | Run on a named machine over SSH |
| `fleet` | `hostStrategy: fleet` | `--placement fleet` | Pick one online registered device per run |
| `cloud` | `hostStrategy: cloud` | `--placement cloud` | Dispatch via the agent's native cloud provider |

```bash
# Pin firing to this machine and place the body on a GPU box
agents routines add train --schedule "0 2 * * *" --agent claude \
  --placement host --run-on gpu-box --prompt "Train overnight"

# Fire once from this machine; each run picks any online fleet device
agents routines add drain --schedule "0 3 * * *" --agent claude \
  --placement fleet --prompt "Drain the local work queue"

# Dispatch to Rush Cloud / the agent's native cloud
agents routines add review --schedule "0 9 * * 1" --agent claude \
  --placement cloud --repo phnx-labs/agents-cli --prompt "Review open PRs"
```

```yaml
# ~/.agents/routines/drain.yml
name: drain
schedule: "0 3 * * *"
agent: claude
hostStrategy: fleet
devices: [yosemite-s0]   # firing pin — only this daemon fires (avoids double-fire)
prompt: "Drain the local work queue"
```

**Double-fire guard.** `host` / `fleet` / `cloud` require a `devices` pin naming which daemon may *fire* the job. Without it every fleet daemon would fire and each dispatch once. Add and sync auto-pin `devices` to this machine when you omit `--devices`. For `fleet`, that pin is **firing only** — the body still runs on any online fleet device (`pickFleetDevice` does not filter by `devices`). `devices --clear` refuses for off-box strategies. Bare `host:` (without `hostStrategy`) still works and implies `host` strategy (and still needs a pin).

`--host` on `agents routines` is the remote-management passthrough ("manage routines **on** that machine") — do not overload it for placement. Use `--placement` / `--run-on`.

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
account: muqsit@trp.so        # Optional: pin to a signed-in account by identity (see "Pinning an account")
version: 2.0.65               # Optional: pin to an exact version; uses global default if omitted
mode: auto                    # auto (default), plan (read-only), edit, or skip
effort: default               # fast, default, or detailed
timeout: 10m
runOnce: false                # true for one-shot jobs (--at)
endAt: "2026-12-31T23:59:00Z" # optional: auto-disable on/after this time
hostStrategy: local           # local | host | fleet | cloud (see Host placement strategy)
devices:                      # optional: the ONE device that owns this routine
  - yosemite-s0               # omit entirely (or --clear) to run on every device
projects:                     # optional: organises the routine under a project group in `list`
  - myapp                     # single name → "myapp" group; ["*"] → All projects
# source:                     # set by `agents routines enable-project` / sync
#   kind: project
#   projectPath: /path/to/repo
#   repo: owner/name
#   branch: main
#   commit: abc1234

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

Prefer `--at` for one-time routines. It accepts `"14:30"` (today at that time, or tomorrow if the time already passed) or `"2026-02-24 09:00"` (absolute). The daemon converts it to a cron expression with `runOnce: true` and deletes the routine after it fires.

Raw cron schedules that pin minute, hour, day, and month with wildcard weekday, such as `"0 14 29 7 *"`, are also treated as one-shot at creation time. The CLI prints a warning and persists `runOnce: true`; use `--at` instead when an agent is scheduling a one-time wake-up.

List output marks one-shot routines in the Schedule column. Expired one-shots that missed cleanup show `expired` instead of next year's recurrence.

Remove completed, expired one-shots that still have user-layer YAML:

```bash
agents routines cleanup --dry-run
agents routines cleanup
```

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

Add `--action` and `--label` when a routine should fire only for a specific
GitHub webhook action and label, such as a UX test agent after a human adds
`ux-approved`:

```bash
agents routines add ux-tests \
  --on github:pull_request \
  --repo phnx-labs/agents-cli \
  --branch main \
  --action labeled \
  --label ux-approved \
  --agent claude \
  --prompt "Run Playwright E2E and visual regression checks, then comment the results on the PR."
```

Run the localhost receiver with signing keys from an `agents secrets` bundle:

```bash
agents webhook serve --secrets-bundle webhooks --port 8787
```

The bundle may contain `GITHUB_WEBHOOK_SECRET`, `LINEAR_WEBHOOK_SECRET`, or both.
The receiver accepts `POST /hooks/github` and `POST /hooks/linear`, rejects
unsigned deliveries, dedupes repeated delivery IDs, rate-limits each source, and
binds `127.0.0.1` by default. Keep webhook signing keys in `agents secrets`; do
not put keys in webhook URLs, path segments, query strings, routine YAML, or
Funnel commands.

Expose the receiver publicly from a Linux/macOS Tailscale node with Funnel:

```bash
agents funnel up yosemite-s0 --local-port 8787 --port 443
agents funnel status yosemite-s0
```

Funnel public ports are limited to `443`, `8443`, and `10000`; `agents funnel up`
validates that before running the remote Tailscale CLI.

Operational runbook:

1. Create or update the secret bundle on the ingress host:

   ```bash
   agents secrets create webhooks
   agents secrets add webhooks GITHUB_WEBHOOK_SECRET
   agents secrets add webhooks LINEAR_WEBHOOK_SECRET
   ```

   If a key already exists, replace the matching `add` command with
   `agents secrets rotate webhooks <KEY>`.

2. Start the receiver on the ingress host and leave it bound to localhost:

   ```bash
   agents webhook serve --secrets-bundle webhooks --host 127.0.0.1 --port 8787
   ```

3. Enable Funnel only after the receiver is listening:

   ```bash
   agents funnel up yosemite-s0 --local-port 8787 --port 443
   agents funnel status yosemite-s0
   ```

4. Rotate a signing key source by source. Set the new source secret in the
   `webhooks` bundle, update the provider webhook configuration to sign with the
   new value, restart `agents webhook serve`, then send one signed test delivery
   before deleting the old provider secret.

5. Disable public ingress before stopping or moving the receiver:

   ```bash
   agents funnel down yosemite-s0 --port 443
   agents funnel status yosemite-s0
   ```

### Webhook handlers

In addition to routine triggers, you can define one-off **webhook handlers** in
`~/.agents/webhooks/*.yml`. A handler matches incoming webhooks the same way a
routine trigger does, but instead of scheduling a recurring job it runs an
agent, workflow, shell command, or an existing routine once.

```yaml
# ~/.agents/webhooks/linear-status-planner.yml
name: linear-status-planner
source: linear
event: Issue
action: update
stateTo: Plan
devices:
  - mac-mini
run:
  agent: claude
  prompt: |
    Issue {{issue.identifier}} moved from {{updatedFrom.state.name}} to {{issue.state.name}}.
    Create a concise implementation plan and post it as a Linear comment.
```

#### Handler YAML format

| Field | Description |
| --- | --- |
| `name` | Unique handler name. |
| `enabled` | Set to `false` to disable without deleting the file. |
| `devices` | Same fleet allowlist as routines — only matching devices run the handler. |
| `source` | `github` or `linear`. |
| `event` | Source event name (e.g. `Issue`, `pull_request`). |
| `action` | Webhook action (e.g. `update`, `opened`, `labeled`). |
| `run` | One-of `agent`, `workflow`, or `command`, plus an optional `prompt` and `env`. |
| `host` | Where the action executes: a device name, `fleet`, or `fleet/<platform>`. Omitted runs locally. |
| `routine` | Name of a routine to delegate to instead of `run`. |

#### Filters

Handlers support the same filters as routine triggers:

- `source`, `event`, `action` — always available.
- Linear: `teamKey`, `label`, `stateTo`, `stateFrom`.
- GitHub: `repo`, `branch`, `label`.

`stateTo` matches the current Linear state name (`payload.data.state.name`);
`stateFrom` matches the previous state (`payload.updatedFrom.state.name`).

#### Actions

- `run.agent` — run the agent headlessly with the substituted prompt.
- `run.workflow` — run `agents run <workflow>` with the prompt.
- `run.command` — run a shell command directly (the command string is also
  variable-substituted). Substituted values are **shell-quoted**: the webhook
  payload is external input, so `{{issue.title}}` and friends arrive as one inert
  argument and cannot inject extra commands. Your own template is not quoted, so
  pipes, redirects, and `&&` still work — write `grep {{issue.title}} log.txt`,
  not `grep '{{issue.title}}' log.txt` (the quotes are added for you). On Windows
  this path runs through `cmd.exe`, which these quoting rules do not cover, so a
  `run.command` containing `{{…}}` is refused with an error; use `run.prompt` or
  a command without placeholders there.
- `routine` — load the named routine, substitute its prompt, and run it
  detached. The handler's `devices` pin overrides the routine's for this fire.

#### Environment and placement

`run.env` injects environment variables into the spawned process, on top of the
sandbox overlay's own. It applies to both the foreground and detached paths.

`host` chooses where the action executes. It is distinct from `devices`:
`devices` says which daemon may *fire* the handler, `host` says where the fired
run *executes*.

| `host` | Effect |
| --- | --- |
| omitted | run locally |
| `yosemite-s0` | run on that device over SSH (or locally if it names this machine) |
| `fleet` | pick any eligible online worker device |
| `fleet/linux`, `linux/fleet`, `linux` | pick any eligible online worker on that platform |

Platforms are `linux`, `macos`, `windows`. A fleet expression that matches no
eligible device raises `no eligible online fleet device` rather than falling back
to this machine — otherwise `fleet/linux` could silently land on a macOS box.

```yaml
# ~/.agents/webhooks/deploy-on-merge.yml
source: github
event: pull_request
action: closed
host: fleet/linux
run:
  agent: claude
  prompt: "Deploy {{pull_request.title}}"
  env:
    DEPLOY_TARGET: staging
```

#### Prompt variables

Use `{{dotted.path}}` placeholders in `run.prompt` (and in the delegated
routine's prompt). For Linear webhooks the context is:

```ts
{
  source: 'linear',
  event: 'Issue',
  action: 'update',
  issue: payload.data,
  updatedFrom: payload.updatedFrom,
}
```

Examples: `{{issue.identifier}}`, `{{issue.state.name}}`,
`{{updatedFrom.state.name}}`, `{{issue.title}}`, `{{issue.description}}`.

For GitHub webhooks the context includes `repository`, `pull_request`, and
`issue`.

#### mac-mini ingress with funnel

Handlers are fired by the same `agents webhook serve` receiver as routine
triggers. On a headless Mac (e.g. `mac-mini`), expose it publicly with
Tailscale Funnel:

```bash
# On mac-mini
agents webhook serve --secrets-bundle webhooks --port 8787 &
agents funnel up mac-mini --local-port 8787 --port 443
```

Then point Linear/GitHub at `https://mac-mini.<tailnet>.ts.net/hooks/<source>`.
The handler's `devices: [mac-mini]` pin ensures only that machine dispatches the
one-off agent run.

### Device activation

Routine YAML files are immutable definitions: they describe what runs and when.
Enablement is device-owned metadata in
`~/.agents/devices/<hostname>/agents.yaml`:

```yaml
routines:
  - check-updates
  - drain
  - watchdog
```

Membership means enabled; absence means disabled. Each host writes only its own
file, so toggles on different devices do not conflict when the DotAgents repo
syncs. The same definition can be active on several devices; each daemon runs it
against that device's local state.

```bash
agents routines resume drain
agents routines resume drain --host yosemite-s0
agents routines pause drain --host mac-mini
agents routines devices drain --set yosemite-s0,mac-mini
agents routines devices drain --clear   # disable everywhere
```

`agents routines devices` reads the synced manifests and executes each mutation
on its target host. `routines list --json` exposes `enabledDevices` and
`runsHere`. Run history remains under
`~/.agents/.history/runs/<routine>/<run>/`; definitions are never rewritten with
activation or last-run metadata.

On upgrade, explicit legacy `enabled:` and `devices:` values are materialized
once into the current host's routine membership. Subsequent toggles edit only the
device manifest.

### Legacy device allowlists

> Historical format only. `enabled:` and `devices:` in definition YAML are read
> during migration but are no longer written or used after a host has a
> `routines:` manifest. Use the device-activation commands above.

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
prompt: "Drain the local work queue"
```

Only the **owner** fires the job — one copy, one run history. Ownership is the
first device in normalized sort order, computed from the config alone, so every
daemon agrees without coordination. Listing several devices is a misconfiguration
(it used to fire the routine once per device) and is refused at creation; omit
`devices:` entirely for a routine that genuinely belongs on every machine.
A single-entry list is equivalent to an exclusive pin: `devices: [yosemite-s0]`
restricts the job to one machine.

Or set the allowlist at creation with `--devices`:

```bash
agents routines add drain --schedule "0 3 * * *" --agent claude \
  --devices yosemite-s0 --prompt "Drain the local work queue"
```

`--devices` is validated against the registered fleet (`agents devices sync`).

For a grouped view of everything, run:

```bash
agents routines list                    # Default: group by project
agents routines list --group-by device  # Group by device/placement instead
agents routines list --flat             # Flat table, no grouping
```

The default grouping buckets routines under their associated project name, **All projects** (for routines tagged `["*"]`), **Cross-project** (multiple projects), **Operations** (no project tag), or **Unknown projects** (stale project names). Pass `--group-by device` to restore the device-placement view, which buckets routines under **This machine**, **Fleet-wide**, **Cloud**, one section per pinned device, and one section per named host. Offline or unknown registry entries are marked in the section header.

Device names are compared against the local `machineId()` (normalized hostname, as
shown by `agents devices`), so `Yosemite-S0` and `yosemite-s0.tailnet.ts.net` both
match `yosemite-s0`.

**A routine runs on exactly one device.** `devices:` is an allowlist, but only its
**owner** fires — the first entry in normalized sort order. Ownership is derived from
the config alone, so every daemon independently reaches the same answer with no lease
and no coordination. Listing several devices is a misconfiguration: it used to fire the
routine once per listed device (duplicate work, duplicate spend), so `add`/`devices --set`
now reject it and `agents doctor` reports any that remain on disk.

**Omitting `devices:` means unrestricted** — the job fires on every device running
the scheduler. That is the genuine fleet-wide case (`watchdog`, `check-updates`).
`--clear` restores it (see below).

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

#### Last Status is per-device

Run records live in the runs dir of whichever machine fired the routine and carry
no device attribution, so a record only ever describes the device you are reading
it on. `agents routines list` therefore reports **Last Status only for routines
this device fires**: a routine pinned elsewhere shows `-` in the table, and
`--json` returns `null` for `lastStatus`, `exitCode`, `failureReason`,
`lastRunStartedAt`, and `lastRunCompletedAt` (`runsHere: false` says why). The
same routine renders one row per pinned device, and only the **This machine** row
carries a status.

Without this, a routine re-pinned from one device to another kept reporting the
old device's leftover records — showing a peer's healthy routine as failed, both
in the table and in the menu bar, which reads this JSON.

Read a peer's status where it actually ran:

```bash
agents routines list --device yosemite-s0     # that device's own view
agents routines runs <name> --device yosemite-s0
```

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
agents routines devices drain --set yosemite-s0            # set the owning device
agents routines devices drain --clear                      # remove allowlist (unrestricted)
```

### Project tagging

Tag a routine to one or more projects defined in `agents projects`. Tagging is
**metadata-only** — it organises the routine in `agents routines list` and the menu
bar, and has no effect on scheduling or execution.

```bash
# Tag to a single project
agents routines add nightly-build --schedule "0 3 * * *" --agent claude \
  --project myapp --prompt "Build and run nightly tests"

# Tag to multiple projects (--project is repeatable)
agents routines add cross-test --schedule "0 4 * * *" --agent claude \
  --project myapp --project billing --prompt "Run cross-service integration tests"

# Tag to all defined projects
agents routines add fleet-check --schedule "0 9 * * 1-5" --agent claude \
  --all-projects --prompt "Check fleet health across every project"
```

`--all-projects` and `--project` are mutually exclusive. Both validate names
against `agents projects list` — unknown project names are rejected with a helpful
message.

Project names appear in the YAML as a `projects:` array. The special value `["*"]`
means "all defined projects" (set by `--all-projects`). Routines with no `projects:`
field appear under the **Operations** group.

`agents routines list` groups by project by default:

| Group | Condition |
| --- | --- |
| `<project name>` | single entry in `projects:` |
| **All projects** | `projects: ["*"]` |
| **Cross-project** | two or more entries |
| **Operations** | `projects:` absent or empty |
| **Unknown projects** | project name(s) no longer exist in `agents projects` |

Pass `--group-by device` to switch to the device/placement grouping, or `--flat`
for a single unordered table.

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
  --devices yosemite-s0 --prompt "Drain queue" --host yosemite-s0
```

When you try to run a job on a host outside its allowlist, the CLI prints:

```
Job 'drain' can only run on: yosemite-s0, mac-mini
  agents routines run drain --host yosemite-s0
```

## Sandbox Isolation

Each job runs with `HOME` set to an overlay directory:

```
~/.agents/routines/daily-review/home/
  .claude/
    settings.json             # Generated with allow.tools permissions
  projects -> ~/projects      # Symlink from allow.dirs
```

The agent can only:
- See directories listed in `allow.dirs`
- Use tools listed in `allow.tools`
- Cannot access `~/.ssh`, `~/.gitconfig`, etc.

When an agent routine finishes, agents-cli copies the agent transcript out of
the overlay before the next run recreates it. The durable copy lives beside the
run metadata:

```
~/.agents/.history/runs/<routine>/<run-id>/sessions/<agent>/...
```

Those archives are indexed by `agents sessions` with `origin: "routine"`,
`routineName`, and `routineRunId`. Use `agents sessions --routine --all` (or the
`--routines` alias) to pick a routine interactively, or pass a fuzzy name such
as `agents sessions --routine nightly-review --all`, to list them. The picker
includes last-run and session-count context, and the selected view groups sessions
by run ID and timestamp. Use `agents sessions <run-id>` to render the existing session summary view
for a specific routine run.

Archiving is per-agent (`ROUTINE_TRANSCRIPT_SPECS` in `runner.ts`, mirroring
`SESSION_ROOT_SPECS` in `session/discover.ts`) and covers every on-disk session
agent: claude, codex, cursor, gemini, antigravity, droid, kimi, grok. `opencode`
is the one exception — its transcripts live in one incrementally-scanned SQLite
db (`~/.local/share/opencode/opencode.db`), not a per-session file tree, so
there's nothing for this mechanism to copy out.

### Claude auth for routines

A routine authenticates exactly like an interactive `agents run claude` on the
same device: through the pinned account's own on-disk login.
`buildRoutineSpawnEnv` sets `CLAUDE_CONFIG_DIR` to the account's per-version home
(`runner.ts`), so even under the sandbox overlay — which gives the spawn a clean
`HOME` — Claude Code reads its credential from `CLAUDE_CONFIG_DIR/.credentials.json`,
the real interactive login. That access token is short-lived but refreshes itself
per-device, so a box that runs at least once inside the refresh window stays
signed in on its own.

The daemon holds **no** Claude token and injects nothing — no ambient
`CLAUDE_CODE_OAUTH_TOKEN`, no per-account variant. A shared or injected token was
the *cause* of the fleet-wide rotation logout, not the fix (see "Pinning an
account" below). If a routine's pinned account login has gone dead, the auth-health
preflight (`runner.ts`) skips the run up front with a `re-login required` message
rather than firing a doomed run.

To bring a signed-out box back, log in on that box once — `agents run claude` (or
`claude` directly) drives the interactive login and writes the credential the
routine then reuses. The daemon does not need restarting; it reads no credential.

### Cursor auth and workspace trust for routines

A sandboxed Cursor routine reuses the login from this same device without copying
credentials to another host. The routine overlay links the local Cursor auth file
from `$XDG_CONFIG_HOME/cursor` (or `~/.config/cursor`) and the CLI preferences from
`~/.cursor/cli-config.json`, then pins `XDG_CONFIG_HOME` to that overlay. If the
device is signed out, the run fails as `auth_failed` with Cursor's `agent login`
instruction.

Cursor routines pass `--trust` because configuring a routine with a working
directory is the user's workspace-trust decision. This is narrower than `--yolo`
or `-f`: it accepts the workspace without bypassing tool permissions. Cursor's
read-only plan mode exists in the CLI but is not enabled in the agents-cli
capability registry yet (RUSH-2101), so `mode: plan` currently warns and runs the
registry-selected writable mode.

The same trust rule applies to any headless `agents run cursor "<prompt>"` launch:
agents-cli passes `--trust` because the caller selected both a working directory
and a non-interactive prompt. Interactive `agents run cursor` launches preserve
Cursor's own workspace-trust prompt and never add `--trust`.

### Pinning an account (avoid the OAuth-rotation revocation storm)

Left unpinned, a `claude` routine selects its account by the default `balanced`
strategy — a stateless weighted-random roll (`rotate.ts`) that can land two
concurrent runs, on one box or across the fleet, on the *same* account. Claude's
OAuth refresh token is **single-use and rotates server-side on every refresh**, so
when a second run refreshes an account the first is still holding, the first run's
token is revoked mid-flight and the run dies with:

```
Failed to authenticate. API Error: 401 OAuth access token has been revoked.
```

Multiplied across ~20 unpinned routines that all wake in the same morning window,
this is a self-inflicted logout storm (RUSH-1957).

**The durable cure: give each routine (or each device's routines) its own
account.** Pin by identity with `account:` — the login email, resolved at launch
to whichever installed version holds that account, run pinned with no rotation and
no failover onto other accounts:

```yaml
name: drain-prix
schedule: "15,45 * * * *"
agent: claude
devices: [yosemite-s1]
account: muqsit@trp.so      # this box's routines all refresh ONE account, no one else's
```

Prefer `account:` over `version:`: a `version:` pin names a version *number* that
is garbage-collected on the next `claude` upgrade, after which the routine
silently falls back to `balanced` and the storm returns. Pinning by account
identity survives version churn. If the named account is not signed in on the box
at fire time, the run warns and falls back to the strategy rather than refusing —
so a stale pin degrades to "unpinned", never to "dead". List signed-in accounts
with `agents view`.

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

### `missed` — the run that never started

`missed` is the one status the runner never writes, because no process was ever
spawned. It records that a scheduled fire **did not happen**: the scheduler was
down, asleep, or wedged when the routine came due. `claimMissedFire`
(`catchup.ts`) writes it with `pid: null`, `exitCode: null`, and `startedAt` set
to the moment the fire was **due** — not the moment it was noticed — so the gap
lands at the right point in `agents routines runs <name>`.

Without it a miss left no trace at all, and the listing kept showing the previous
run's `completed` as though it were current.

## Catching up a missed fire

Fires are in-process croner timers, and croner only schedules forward from "now".
A daemon that was not running when a routine came due therefore loses that fire —
`loadAll()` (`scheduler.ts`) rebuilds every timer looking only at the future, so
nothing replays it. This is routine on a laptop: close the lid over a 9pm
schedule and the routine simply never ran.

The daemon recovers from this itself. `detectOverdueJobs` (`overdue.ts`) compares
each enabled routine's most recent expected fire against its most recent recorded
run; `runCatchup` (`catchup.ts`) then records each miss and re-runs it via the
same detached path `agents routines catchup` uses. It runs **at daemon startup
and every 5 minutes** — a startup-only pass would miss a fire lost while the
daemon stayed up but its event loop was wedged, or one lost across an OS suspend
the process survived.

Detection looks back far enough to see the routine's own period. The window widens
week → month → quarter → year, and only when the narrower one finds nothing, so a
dense schedule never walks more than a week of occurrences. A fixed one-week
lookback silently skipped anything sparser: `0 9 1,13,25 * *` has 12-day gaps, so on
10 of every 28 days it could not be evaluated at all.

A routine past its `endAt`, and a one-shot (by flag *or* by schedule shape), is never
caught up — catch-up replays a missed fire, it does not resurrect a retired routine.

Catch-up is idempotent without a ledger: the `missed` record advances the overdue
comparison, so the same missed fire is never reconsidered — across ticks, a daemon
restart, or a restart storm.

Two callers that overlap are handled by a claim rather than a lock. Writing the
`missed` record creates its run directory with a non-recursive `mkdir` — an
atomic test-and-set — and only the caller that wins it runs the routine. So if
the daemon's 5-minute pass and a manual `agents routines catchup` overlap, the
routine still starts exactly once; the loser reports `already claimed by the
scheduler`. This is deliberately at-most-once: a process that dies between
claiming and spawning leaves that fire un-run, which is the right trade when the
alternative is spawning an agent twice.

Device scoping still applies: a routine pinned elsewhere is skipped, so a fleet of
machines never all catch up the same routine.

A routine is also never caught up for a fire that **predates it**. `writeJob` stamps
`createdAt` once, and overdue detection floors the most recent expected occurrence at
it (`routineEffectiveStart`, `overdue.ts`), falling back to the routine file's mtime
for routines written before the field existed. Without that floor, adding a routine on
any daily or weekly schedule whose slot had already passed would make it instantly
overdue — and catch-up would run it once, immediately, minutes after you created it.

### Opting out — `catchup: false`

Catch-up defaults to **on**: a routine you scheduled is one you expect to have
run, so losing a fire silently is never the helpful default.

Set `catchup: false` on a routine whose value is tied to its clock — a 9am
standup brief is worthless at 3pm:

```yaml
name: crm-pipeline-brief
schedule: "0 8 * * 1-5"
catchup: false
```

or at creation:

```bash
agents routines add crm-pipeline-brief --schedule "0 8 * * 1-5" --agent claude \
  --no-catchup --prompt "Morning pipeline brief"
```

An opted-out routine still **records** the miss — you see it as `missed` in the
listing and in `agents routines runs` — it is just not re-run.
`agents routines list --json` reports the effective value as `catchup`.

Force a pass by hand at any time:

```bash
agents routines catchup            # record + run every missed fire now
agents routines catchup --dry-run  # record the misses, run nothing
```

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
        meta.json                     # RunMeta: { agent, version, mode, status, duration, ... }
```

### Desktop notifications

The daemon fires a native macOS notification on the routine lifecycle, routed
through the `MenubarHelper.app` companion (`src/lib/menubar/notify-desktop.ts`)
so it carries the agents-cli mark (the bundle's `AppIcon`) rather than the
generic AppleScript/Script Editor icon. An agent routine carries the harness it
runs on as the banner's right-hand avatar (`routineAgent`); a workflow routine
runs via `agents run <workflow>` (delegated to claude), so it shows the Claude
avatar — the same harness the finish banner records; a command routine has no
agent and shows the agents-cli mark alone. When the
menu-bar helper is not
installed (Linux, or a machine that disabled it), delivery degrades to
`osascript`/`notify-send` so a notice is never silently lost.

| Event | When | Threshold |
| --- | --- | --- |
| **Start** | The scheduler triggers a routine | Agent/workflow routines only — command (housekeeping) routines are suppressed to avoid spam |
| **Finish** | The run reaches a terminal state | Always for agent/workflow; command routines notify only on **failure** |
| **Overdue** | Daemon startup finds a missed recurring routine | Any overdue routine (`src/lib/overdue.ts`) |

All three of the above fire from **inside** `runDaemon()`, so none of them can
ever notice that the daemon itself has died — the exact outage that means no
routine will fire again until someone restarts it. That gap is closed by a
separate, daemon-independent watchdog in the menu-bar helper (which runs as its
own launchd `KeepAlive` service): see
[menubar.md → Daemon-down watchdog](menubar.md#daemon-down-watchdog).

"Notable output" is folded into the single **Finish** notification, not sent as
a third message: on success the body is the first line of `report.md` (the
routine's user-facing result), on failure it is the error reason. So a normal
run produces exactly one start + one finish notification.

Notifications are actionable where a target exists: clicking a **Finish** opens
the run's `report.md`/`stdout.log`; **Start**/**Overdue** open the runs folder.
The finish notification only fires for locally-run routines — `host:`-placed
runs are finalized by the monitor sweep and do not emit one.

### Owner notification on failure (RUSH-2288)

Desktop notifications never leave the machine, so a failed routine on a headless
fleet box was invisible until someone looked. On a **failure only** — a
`failed`/`timeout` finish, or a pre-spawn failure such as `auth_failed` — the
daemon also pings the **owner's phone**, through the same channel stack `agents
notify` uses (the `owner.channels` in `humans.yaml`, or the legacy
`notify.owner` in `agents.yaml`). This is the failure the per-routine `agents
notify` prompt can never send itself: when the routine's own agent fails to
spawn, that prompt never runs.

- **Only failures.** A green routine of any kind stays silent. The desktop
  thresholds above are unchanged; this is an additional failures-only lane.
- **In-process, not `ssh`.** The daemon calls the channel providers directly
  (`src/lib/routine-notify-owner.ts`) — it does not shell out to `ssh mac-mini
  agents notify`.
- **Fallback channel.** If the primary owner channel cannot deliver from this
  box, the daemon walks the remaining configured `owner.channels` in order
  (e.g. an OpenClaw channel after iMessage). Telegram and intrusive (voice)
  channels are excluded; an owner whose only channel is Telegram gets no ping.
- **Deduped** per job+runId, so a run reaches the owner at most once.

## Commands

```bash
# Lifecycle
agents routines list                  # List all jobs with next run + status
agents routines list --host yosemite-s0  # List another device's routines
agents routines add <name> --schedule "0 9 * * *" --agent claude --prompt "..."  # Inline
agents routines add <name> --devices yosemite-s0 --schedule "0 3 * * *" \
  --agent claude --prompt "..."       # Add with device allowlist
agents routines add <name> --project myapp --schedule "0 9 * * *" \
  --agent claude --prompt "..."       # Tag to a named project (repeatable)
agents routines add <name> --all-projects --schedule "0 9 * * *" \
  --agent claude --prompt "..."       # Tag to all defined projects
agents routines add <path.yml>        # Add from YAML file
agents routines add <name> --at "14:30" --agent claude --prompt "..."            # One-shot
agents routines edit <name>           # Open job in $EDITOR
agents routines remove <name>         # Delete a job
agents routines pause <name>          # Disable a job
agents routines resume <name>         # Re-enable a paused job

# Device allowlist management
agents routines devices <name>                         # Interactive multi-select picker
agents routines devices <name> --set yosemite-s0           # Set the owning device
agents routines devices <name> --clear                 # Remove allowlist (unrestricted)

# Execution
agents routines run <name>            # Run immediately in foreground
agents routines run <name> --host yosemite-s0  # Run on a specific remote device
agents routines view <name>           # Show job config
agents routines runs <name>           # View execution history (last 10)
agents routines stats                 # Run count/failed/missed/avg/p50/p95 duration, every job
agents routines stats <name>          # Same rollup, scoped to one job
agents routines logs <name>           # Show concise summary from latest run
agents routines logs <name> --run <id>  # Show specific run
agents routines logs <name> --full    # Show raw stdout from latest run
agents routines report <name>         # Show report from latest run
agents routines report <name> --run <id>  # Show specific run report
agents sessions <run-id>              # Show the archived agent transcript summary

# Scheduler (auto-starts on first `routines add`; these are manual controls)
agents routines start                 # Start the background scheduler
agents routines stop                  # Stop the scheduler
agents routines status                # Show scheduler status + upcoming runs
agents routines scheduler-logs        # Read scheduler log output
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

Scheduled fires are single-flight per routine. If the previous execution is still
running, the next cron, catchup, or monitor fire exits without spawning another
process. The claim is shared across CLI processes, so two simultaneous dispatchers
cannot both pass the running-run check.

`agents routines status` reports the scheduler as `running`, `wedged`, or `stopped`. A live PID whose heartbeat is more than three monitor ticks old is `wedged`; the status output includes the restart command. Both `routines list` and `routines status` also finalize orphaned `running` records before rendering. Run metadata records process birth time to reject recycled PIDs and persists the configured execution deadline. Detached children are killed when that deadline expires, including after a scheduler restart.

The status output includes the resolved daemon binary. Startup rejects bun virtual-filesystem paths and warns when the binary lives under an ephemeral root — a git worktree, or a temporary directory (`/tmp`, `/var/folders`, `/dev/shm`) — because deleting that directory would strand the service. The daemon resolves its own job modules from the launch path, so a direct `agents __daemon-run` from such a build wedges every routine with `ENOENT` once the directory is removed; the warning fires both at spawn time (`validateDaemonBinary`) and at the daemon's own startup (`warnEphemeralDaemonRoot`), so a directly-launched daemon still surfaces the risk. Run it from the globally installed binary to root it at a stable version home.

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
| `routineStats()` | routines.ts | Fold `listRuns()` into `{count, failed, missed, avgMs, p50, p95}` — `agents routines stats` |
