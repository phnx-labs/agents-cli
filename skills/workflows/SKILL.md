---
name: workflows
description: "Create and run reusable multi-agent pipelines. Bundle an orchestrator prompt with optional subagents, skills, and plugins into a named workflow invoked as `agents run <workflow-name>`. Triggers on: 'workflow', 'orchestrator', 'WORKFLOW.md', 'multi-agent pipeline', 'reusable agent task'."
argument-hint: "[add|list|view|remove|run]"
allowed-tools: Bash(agents workflows*), Bash(agents run*)
user-invocable: true
---

# Workflows

A workflow is a named, reusable agent pipeline. One directory bundles an orchestrator system prompt with optional subagents, skills, and plugins; invoke it like any other agent: `agents run <workflow-name> "<prompt>"`.

## "I want to bottle up a task I keep repeating"

A workflow is a directory with `WORKFLOW.md` at the root:

```
~/.agents/workflows/code-review/
  WORKFLOW.md
```

`WORKFLOW.md` is YAML frontmatter (the workflow's metadata) plus a Markdown body (the orchestrator's system prompt):

```markdown
---
name: Code Review
description: Evidence-grounded PR review with file:line citations.
model: claude-opus-4-7
tools:
  - Read
  - Grep
  - Glob
  - Bash
  - WebFetch
---

You are Code Reviewer. Read every AGENTS.md/CLAUDE.md/GEMINI.md in touched
directories first. Then identify scope, read full files, trace data flow,
run the project's tests, and produce a review with file:line citations.

Output sections: Summary / Critical / Concerns / Nits / Tests run / Verdict.
Do not commit or modify files.
```

Run it:

```bash
agents run code-review "review PR #42 on acme/api"
```

The workflow name goes in the agent slot. agents-cli resolves it (project `.agents/workflows/` > user `~/.agents/workflows/` > system), launches Claude, and prepends the WORKFLOW.md body to your prompt as the system instructions.

## "My workflow needs multiple specialized agents, not one"

Add a `subagents/` subdirectory. Each `.md` file is a named subagent the orchestrator can dispatch to via Claude's built-in Agent tool — including in parallel:

```
~/.agents/workflows/code-review/
  WORKFLOW.md            ← orchestrator: dispatch + synthesize
  subagents/
    security.md          ← injection, secrets, auth findings
    correctness.md       ← logic, data flow, root cause
    style.md             ← naming, scope creep, test coverage
```

Each subagent `.md` uses Claude's standard subagent format:

```markdown
---
name: security
description: Review code for security issues — injection, secrets, auth.
model: sonnet
tools:
  - Read
  - Grep
  - Bash
---

You are a security reviewer. Focus on injection vectors, secret handling,
and auth/authz gaps. Quote file:line for every finding.
```

Tell the orchestrator (in `WORKFLOW.md` body) when to delegate:

```markdown
For each touched file:
1. Spawn the `security` subagent in parallel with `correctness` and `style`.
2. Wait for all three. Synthesize their findings into one review.
```

At run time, agents-cli copies `subagents/*.md` into `~/.claude/agents/` so the orchestrator can find them by name.

## "How do I run a workflow that writes files or posts comments?"

`agents run` defaults to `--mode plan` (read-only). For workflows that need to write — post a PR comment, edit a file, send a Slack message — pass an explicit mode:

```bash
# Allows file edits + auto-approves bash
agents run code-review --mode edit "review PR #42 and post the review"

# Bypasses all permission prompts (use when fully autonomous)
agents run deploy-bot --mode full "deploy api to staging"
```

Without this, the orchestrator hangs at `ExitPlanMode` waiting for human approval it will never get in a headless run.

## "I want my workflow to ship with its own skills and plugins"

Drop a `skills/` or `plugins/` subdir alongside `WORKFLOW.md`:

```
~/.agents/workflows/deploy-bot/
  WORKFLOW.md
  skills/
    kubernetes/SKILL.md     ← available to this workflow only
    helm/SKILL.md
  plugins/
    rollback-tool/          ← plugin bundle synced in for the run
```

These sync into the version home before launch, so they're only active when this workflow runs — keeps cross-pollution off your general agent environment.

## "I want to share my workflow with my team"

Two paths.

**Push via your user repo:**

```bash
# After authoring locally
agents repo push    # syncs ~/.agents/, workflows included
```

Teammates run `agents repo pull` and the workflow appears for them.

**Install from a GitHub repo:**

```bash
agents workflows add gh:yourteam/code-review
agents workflows add ./local-path           # or from a local dir
agents workflows add gh:yourteam/workflows --agents claude@2.1.138
```

`add` from GitHub clones the repo, discovers every directory with a `WORKFLOW.md`, and installs them into `~/.agents/workflows/`. Project-level workflows go at `.agents/workflows/` in the project root (committed with the repo).

## "Where do my workflows live?"

| Layer | Path | Wins over |
|-------|------|-----------|
| Project | `<repo>/.agents/workflows/<name>/` | user, system |
| User | `~/.agents/workflows/<name>/` | system |
| System | `~/.agents-system/workflows/<name>/` | — |

Same precedence as every other resource. Higher layer overrides by name.

## "How do I inspect or remove a workflow?"

```bash
agents workflows list                    # all + sync status across versions
agents workflows view code-review        # frontmatter, subagent count, path
agents workflows remove code-review      # remove (interactive picker if no name)
```

## `WORKFLOW.md` frontmatter reference

```yaml
name: <string>              # display name (also used for `view` output)
description: <string>       # one-line summary shown in `list`
model: <string>             # claude-opus-4-7, claude-sonnet-4-6, etc.
tools:                      # available-tool restriction — ENFORCED (Claude, --tools)
  - Read
  - Bash
skills:                     # extra skills to load for this run
  - debug
mcpServers:                 # MCP servers to enable — ENFORCED (Claude, --strict-mcp-config)
  - github
allowedAgents:              # subagents the orchestrator may dispatch to — ENFORCED (Claude, file filter)
  - security
  - correctness
loop:                       # optional autonomous loop (issue #332)
  until: signal             #   stop when loop-signal.json says continue:false (absent = fail-closed)
  max_iterations: 3         #   hard cap on iterations
  budget: 500000            #   cumulative-token hard cap, enforced outside the agent
  interval: "0"             #   delay between iterations ("0" back-to-back, "30m" paces)
```

All fields are optional. A workflow with no frontmatter beyond `---` fences still works — the Markdown body alone is enough.

### Looping a workflow (`loop:` block)

A `loop:` block wraps the workflow in a bounded until-condition loop. `agents run <workflow>` then re-injects the orchestrator each iteration **without a `--loop` flag** — the declared block is honored automatically. CLI loop flags (`--max-iterations`, `--budget`, `--until`, `--interval`) override the declared fields one-by-one.

| Field | Stop reason | Meaning |
|---|---|---|
| `until: signal` | `condition-met` | Reads `<runDir>/loop-signal.json` `{continue,reason}` each turn; absent or `continue:false` stops (fail-closed). The orchestrator writes its vote to the path in `AGENTS_LOOP_SIGNAL`. |
| `max_iterations: <n>` | `max` | Hard cap on iterations. |
| `budget: <tokens>` | `budget` | Cumulative-token cap, enforced OUTSIDE the agent (the agent cannot vote past it). |
| `interval: "<dur>"` | — | Delay between iterations. |

A malformed `loop:` field (bad `until`, non-positive `max_iterations`/`budget`, non-string `interval`) is dropped defensively rather than passed to the driver — same discipline as the `tools:`/`mcpServers:` coercion. A `checkpoint.json` is written after every iteration; resume a killed run with `agents run <workflow> --resume-checkpoint <file>`. See [docs/07-entrypoints-and-loops.md](../../docs/07-entrypoints-and-loops.md) for the full loop model.

### Scoping & security (enforced at run time, Claude)

These fields are not just displayed — on Claude they translate to headless flags that actually scope the run:

| Frontmatter | Claude flag | Effect |
|---|---|---|
| `tools: [Read, Grep]` | `--tools Read Grep` (+ matching `--allowedTools`) | Read-only sandbox — `Write`, `Bash`, and `Edit` are unavailable in the session |
| `mcpServers: [github]` | `--mcp-config <ephemeral json>` + `--strict-mcp-config` | ONLY the named registry servers load (the config flag alone would merely add them) |
| `mcpServers: [missing]` (none installed) | `--mcp-config <empty {}>` + `--strict-mcp-config` | **Fail-closed:** declaring `mcpServers` with no installed match scopes the run to NO MCP servers — never the user's full ambient set |
| `allowedAgents: [security]` | copies only `security.md` into the run's agents dir | Unlisted subagents have no definition on disk, so the orchestrator can't dispatch them. **Fail-closed prune (issue #401):** before copying, any workflow-managed subagent left over from a prior unrestricted run that is no longer permitted is removed from the shared dir (a user's own hand-placed subagent is never touched), and the run's copies are torn down afterward. |
| `allowedAgents: []` (explicit empty) | copies NO subagent files | **Fail-closed:** allow none. Omitting the field entirely copies all subagents; an empty list copies zero |

Read-only review example — this workflow can read and search but cannot write files or shell out:

```yaml
name: ro-review
description: read-only review
tools:
  - Read
  - Grep
  - Glob
```

If you run a workflow declaring these fields on an agent without the tool-allowlist capability (`allowlist` in `src/lib/agents.ts` — today only Claude), the run proceeds *unscoped* and prints a `declared but unenforceable on <agent>` warning. The boundary is never silently dropped.

## "What else can I do?"

Run `agents workflows --help` — there's more: listing per agent version, syncing to specific versions on install, viewing subagent details.
