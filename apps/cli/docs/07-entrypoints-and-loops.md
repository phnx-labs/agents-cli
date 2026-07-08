# Entrypoints, Packaging, and Loops

The unifying model behind plugins, workflows, routines, and loops: two axes — one for packaging, one for invocation.

> **Status: design direction.** The resources-vs-entrypoints split (see [00-concepts.md](00-concepts.md)) is current. The unification below — plugins packaging workflows, per-routine plugin scoping, unified `run` dispatch — is proposed and only partly implemented. **The `loop` block ships** (`agents run --loop` + `--resume-checkpoint`, issue #332): the driver, the four guard fields, and harness-level checkpoint/resume are live. The [Today vs. proposed](#today-vs-proposed) table marks each item.

---

## Two axes

```
PACKAGE axis  →  plugin   (the one package: bundles resources + entrypoints)
                   │
   resources (passive, an agent USES)      entrypoints (invocable, you RUN)
   ── skills                               ── commands   (a prompt)
   ── mcp / lsp                            ── subagents  (prompt + model + tools)
   ── rules / hooks / permissions          ── workflows  (orchestrator prompt + subagents + methodology)

INVOKE axis   →  routine / `agents run`  =  entrypoint  ×  prompt  ×  scoped plugins  [× loop]
```

A **plugin** is the only package. It bundles resources and entrypoints under one versioned manifest. An **invocation** picks one entrypoint, hands it a prompt, scopes which plugins' resources are in reach, and optionally wraps it in a loop.

This removes a concept rather than adding one: today there are two package-ish things — plugins and workflow bundles — with overlapping contents (both hold subagents, skills, plugins). Folding workflows into plugins as one more entrypoint kind collapses that overlap and gives workflows the distribution, versioning, and dependency handling plugins already have.

---

## The entrypoint family

The three invocable kinds differ only in orchestration weight:

| Kind | Is | Runs |
|------|----|------|
| `command` | a packaged, parameterized prompt | one turn, current agent |
| `subagent` | a prompt + model + tool set | one focused agent |
| `workflow` | an orchestrator prompt + subagents + methodology | many agents, authored topology |

A workflow is "statically-defined subagents" — the deterministic counterpart to subagents the model spawns on the fly. Reach for a workflow when you will run the thing repeatedly, on a schedule, under a budget, with the verification baked in; reach for dynamic subagents when you are exploring once. (See [why determinism is worth paying for](#why-this-shape) below.)

---

## Packaging: the plugin owns its entrypoints

A plugin already packages `commands/`, `agents/` (subagents), `skills/`, `.mcp.json`, `hooks/`, and more (see [plugins.md](plugins.md)). The direction is to add `workflows/` to that list so a plugin is the single distributable unit for everything an agent can use *or* run.

```
my-plugin/
  .claude-plugin/plugin.json
  skills/        resources
  commands/      entrypoints
  agents/        entrypoints (subagents)
  workflows/     entrypoints (proposed)
  .mcp.json      resources (exec surface)
```

When a plugin is installed, its workflows register into the workflow resolution path alongside project/user/system workflows. Pick one nesting direction: **plugin is outer, workflow is inner.** The current inverse — a workflow embedding `plugins/` (`src/commands/exec.ts`) — should be retired once this lands, so there is never plugins-in-workflows-in-plugins.

---

## Invocation: routine / `agents run`

One shape covers every entrypoint:

```yaml
name: cluster-feedback
schedule: "*/30 * * * *"          # routine cadence (omit for a one-off `agents run`)
run: feedback-clustering          # entrypoint: command | subagent | workflow | agent
prompt: "cluster the last 30m of social mentions into themes"
plugins: [posthog, social-scan]   # scoped capability grant — not the whole HOME
loop:                             # optional; omit for a single run per fire
  until: signal                   # stop when loop-signal.continue == false
  max_iterations: 3
  budget: 500000                  # token hard-cap, enforced outside the agent
```

`run` replaces today's separate `agent:` / `workflow:` routine fields with one target that accepts any entrypoint. `plugins:` scopes resource access per invocation instead of the current all-or-nothing (global enablement, or `sandbox: false` to inherit everything). `loop:` wraps the entrypoint in a bounded until-condition loop.

### Resolving the `run` target

`run` takes a bare name for the common case, with two qualifiers for ambiguity — which *kind*, and which *source*.

Form: `[<type>:]<name>[@<source>]`, or a structured object.

- **Bare** — `run: feedback-clustering` — resolved by layered precedence (`project > user > plugin > extra repos > system`). If the name matches more than one entrypoint *type*, resolution **fails closed** and asks you to qualify. It never guesses.
- **Type-qualified** — `run: workflow:feedback-clustering` — pins the kind. `<type>` is `command | subagent | workflow | agent`.
- **Source-qualified** — `run: feedback-clustering@social-tools` — pins where it comes from: a plugin name or an extra-repo alias (`~/.agents-<alias>/`, registered via `agents repo add`).
- **Both** — `run: workflow:feedback-clustering@social-tools`.
- **Structured** (verbose, self-documenting):

```yaml
run:
  type: workflow          # command | subagent | workflow | agent
  name: feedback-clustering
  from: social-tools       # plugin name or repo alias (optional)
```

Rule of thumb: omit qualifiers until there is a collision; qualify `type` when two kinds share a name, `@source` when two repos or plugins ship the same name.

### The loop block

`loop:` turns a single invocation into a bounded until-condition loop. The driver is deterministic; the entrypoint inside stays dynamic (it can spawn subagents freely).

| Field | Meaning |
|-------|---------|
| `until` | stop condition. `signal` reads `loop-signal.json` (`{ "continue": bool, "reason": str }`) written by the entrypoint each iteration; absence is treated as `continue: false` (fail-closed). |
| `max_iterations` | hard cap on iterations. |
| `budget` | token hard-cap, enforced **outside** the agent (a kill-switch the agent cannot vote past). |
| `interval` | delay between iterations; `0` runs back-to-back, `"30m"` paces. |

Without `loop:`, a routine fires its entrypoint once per cadence — the current behavior. With `loop:`, each fire runs the entrypoint until the condition is met or a guard trips. Exit reasons mirror the teams supervisor (`condition-met | budget | stalled | max | signal`).

### Running a loop today (`agents run --loop`)

The loop driver ships as additive flags on `agents run` (issue #332). The CLI verb is **`agents run --loop`** — not a separate `agents loop` command.

```bash
# Re-inject a prompt back-to-back, up to 5 turns, stopping early on the signal,
# with a 100k-token hard cap enforced OUTSIDE the agent.
agents run claude "drive the migration to green" \
  --loop --until signal --max-iterations 5 --budget 100000 --interval 0 --mode skip
```

| Flag | Maps to | Meaning |
|------|---------|---------|
| `--loop` | activate | Re-inject the prompt/entrypoint each iteration until a stop condition. |
| `--max-iterations <n>` | `max_iterations` | Hard cap on iterations (`stoppedBy: max`). |
| `--budget <tokens>` | `budget` | Cumulative-token hard cap (`stoppedBy: budget`), enforced outside the agent. |
| `--until signal` | `until` | Read `<runDir>/loop-signal.json` each turn; absent or `continue:false` stops (`stoppedBy: condition-met`, fail-closed). |
| `--interval <dur>` | `interval` | Delay between iterations (`0` back-to-back, `30m` paces). Units `w/d/h/m` — `30s` and bare numbers are rejected at config build, never silently run full-speed. |
| `--resume-checkpoint <file>` | resume | Continue a killed run from its `checkpoint.json`. |

**Each iteration** spawns one headless turn (`--json` stream) and **pins its own fresh `--session-id`** — `--session-id` *creates* a session, so re-passing one errors `Session ID already in use`. To carry conversation memory forward, iteration 2+ injects the established `/continue <prior session id>` directive (the same mechanism the rate-limit fallback chain uses) ahead of the re-injected entrypoint, so the agent recalls the prior turn before doing this iteration's work. Cross-iteration continuity applies to **claude only**; other agents run each iteration as an independent fresh conversation (the driver warns when `--loop` is paired with a non-claude agent). The driver exposes the signal path to the entrypoint via the `AGENTS_LOOP_SIGNAL` env var (plus `AGENTS_RUN_DIR` and `AGENTS_LOOP_ITERATION`) — the agent writes its `{continue, reason}` vote there; the driver, OUTSIDE the agent, decides whether to continue.

A workflow may declare a `loop:` block in its WORKFLOW.md frontmatter; `agents run <workflow>` then honors it **without** a `--loop` flag. CLI flags override the workflow's declared fields one-by-one.

### Checkpoint / resume

The driver writes `<runsDir>/<runId>/checkpoint.json` **after every iteration** (atomic temp+rename) and inside the SIGINT/SIGTERM handler. The checkpoint records `{ id, agent, version, prompt, sessionId, iteration, loop, loopSignal, cumulativeTokens }` — the harness state a kill would otherwise destroy. `sessionId` is the **last completed iteration's** session id; resume threads the *conversation* forward by `/continue`-ing from it, while the rest of the checkpoint resumes the *harness* (iteration count, prompt chain, token tally).

```bash
# A SIGTERM/timeout/machine-sleep killed the run mid-loop. Continue from the
# last completed iteration — same runId, /continue from the last session,
# carried token count.
agents run claude --resume-checkpoint ~/.agents/.history/runs/<runId>/checkpoint.json --max-iterations 10
```

Resume reuses the checkpoint's loop config but lets the resume command **raise** the bounds field-by-field (e.g. a higher `--max-iterations`) so "continue, run more" is one gesture.

---

## Today vs. proposed

| Capability | Today | Proposed |
|------------|-------|----------|
| Plugin packages skills / commands / subagents / mcp / hooks | yes | — |
| Plugin packages workflows | no — workflows resolve from project/user/system/extra-repos only | yes — `workflows/` discovered and registered into the resolver |
| `agents run <workflow>` | yes | — |
| `agents run <subagent>` / `<command>` as the top-level target | no — only agent / profile / workflow | yes — unified entrypoint dispatch |
| Routine target | `agent` or `workflow` | any entrypoint via `run:` |
| Per-routine / per-run plugin scoping | no — global enablement, or `sandbox: false` for all | `plugins: [...]` / `--plugins` |
| Workflow frontmatter `model` / `tools` / `mcpServers` / `allowedAgents` enforced | yes (Claude) — `model` → `--model`, `tools` → `--tools` (restricts available tools), `mcpServers` → ephemeral `--mcp-config` + `--strict-mcp-config` (only named servers), `allowedAgents` → only listed subagent definitions copied into the run; unenforceable declarations warn, never silently drop | yes |
| `run` target qualifiers | n/a — auto-detect (agent > profile > workflow) | `[<type>:]<name>[@<source>]` |
| Loop a workflow on a *cadence* | yes — routine with `workflow:` | — |
| Loop an entrypoint *until a condition* | **shipped** — `agents run --loop` + workflow `loop:` frontmatter (issue #332) | — |
| Harness checkpoint / resume a killed loop | **shipped** — `checkpoint.json` after every iteration; `agents run --resume-checkpoint <file>` | — |

---

## Why this shape

- **One package, not two.** Plugins already version, depend, and distribute; workflows do not. Making the plugin the only package gives every entrypoint the same lifecycle.
- **Deterministic skeleton, dynamic muscle.** The loop driver and guards are fixed and safe to repeat; the entrypoint inside is free to spawn subagents and decide *how*. You script the loop, not the work.
- **Guards live outside the agent.** `budget`, `max_iterations`, and stall detection are enforced by the driver, not by the thing being looped — the standard answer to runaway-loop and runaway-cost failure modes.
- **Least privilege.** `plugins:` grants exactly the capabilities an invocation needs instead of the whole HOME.

## Design cautions

- **Do not collapse the entrypoint kinds into one mushy "prompt + resources" type.** Keep `commands/`, `agents/`, `workflows/` as distinct named directories even though dispatch unifies. Names are documentation.
- **Pick one nesting direction.** Plugin outer, workflow inner. Retire the workflow-embeds-plugins path so precedence stays reasonable.
- **Namespacing is required once two sources can provide the same name.** `@source` plus the `project > user > plugin > extra > system` precedence is the contract; same-name-different-type is an error, not a silent pick.

## See Also

- [00-concepts.md](00-concepts.md) — resource kinds, the resources-vs-entrypoints split, layered resolution
- [plugins.md](plugins.md) — the package: manifest, exec-surface gate, sync
- [workflows.md](workflows.md) — the heaviest entrypoint kind
- [subagents.md](subagents.md) — the middle entrypoint kind
- [03-routines.md](03-routines.md) — scheduled invocation with sandboxed permissions
