---
kind: report
title: agents-cli Design Constraints
summary: A searchable map of the invariants governing sessions, secrets, daemon, teams, run, and routines, including what is current, intended, drifting, or undocumented.
header: Phoenix Labs / agents-cli
footer: Architecture and contract audit
project: agents-cli
repository: phnx-labs/agents-cli
status: current-code audit
date: "2026-08-10"
facts:
  - 6 critical subsystems audited
  - Sessions, secrets, and run have normative contracts
  - Teams is documented but not normatively specified
  - Routine readiness remains substantially intended
---

## Summary

This report distinguishes implemented guarantees from intended architecture and descriptive-only documentation across the six most important state and execution subsystems.

### The operating model

The design is built around three separations: durable facts versus live state, one execution funnel versus many callers, and one scheduler versus many control surfaces.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg class="artifact-diagram" viewBox="0 0 1080 430" role="img" aria-label="Architecture map connecting durable state, execution funnels, and scheduling ownership">
  <rect x="25" y="25" width="1030" height="380" rx="14" fill="#090c0f" stroke="#303840" stroke-width="1.5"/>
  <text x="55" y="62" font-family="JetBrains Mono, monospace" font-size="12" fill="#a3e635">DURABLE FACTS</text>
  <rect x="55" y="82" width="265" height="112" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="75" y="112" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">Sessions DB</text>
  <text x="75" y="138" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">metadata · parser continuation</text>
  <text x="75" y="158" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">FTS content · archived sessions</text>
  <text x="75" y="178" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">headless · teammate · routine transcripts</text>

  <text x="407" y="62" font-family="JetBrains Mono, monospace" font-size="12" fill="#38bdf8">ONE EXECUTION FUNNEL</text>
  <rect x="407" y="82" width="265" height="112" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="427" y="112" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">agents run</text>
  <text x="427" y="138" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">sanitize → resolve → isolate</text>
  <text x="427" y="158" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">spawn → audit exactly once</text>
  <text x="427" y="178" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">local · SSH · fallback · routine</text>

  <text x="760" y="62" font-family="JetBrains Mono, monospace" font-size="12" fill="#f59e0b">ONE SCHEDULER</text>
  <rect x="760" y="82" width="265" height="112" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="780" y="112" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">CLI daemon</text>
  <text x="780" y="138" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">slot claims · no overlap</text>
  <text x="780" y="158" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">routine history · adoption</text>
  <text x="780" y="178" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">UIs render and request only</text>

  <path d="M320 138 L407 138" stroke="#38bdf8" stroke-width="2" stroke-dasharray="5 5" opacity="0.8"/>
  <path d="M672 138 L760 138" stroke="#38bdf8" stroke-width="2" stroke-dasharray="5 5" opacity="0.8"/>

  <rect x="55" y="245" width="215" height="100" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="75" y="276" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">Sessions</text>
  <text x="75" y="301" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">every agent transcript indexed</text>
  <text x="75" y="321" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">origin + parent/run links retained</text>

  <rect x="305" y="245" width="215" height="100" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="325" y="276" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">Secrets</text>
  <text x="325" y="301" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">metadata ≠ protected value</text>
  <text x="325" y="321" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">broker cache ≠ authority</text>

  <rect x="555" y="245" width="215" height="100" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="575" y="276" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">Team ledger</text>
  <text x="575" y="301" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">DAG · task · process state</text>
  <text x="575" y="321" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">links to teammate session ids</text>

  <rect x="805" y="245" width="220" height="100" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="825" y="276" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">Routine run ledger</text>
  <text x="825" y="301" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">attempts incl. no-session outcomes</text>
  <text x="825" y="321" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">links to archived session ids</text>
</svg>
<figcaption>Read left to right: durable data feeds the common execution funnel; the daemon exclusively decides when autonomous work runs.</figcaption>
</figure>

<div class="artifact-callout"><strong>Search tip:</strong> use the browser’s Find command for an invariant id such as <code>SES-5</code>, <code>EXEC-18</code>, <code>SING-1</code>, or <code>RT-5</code>.</div>

### Where headless, team, and routine executions go

| Execution | Durable session record | Additional ledger |
|---|---|---|
| Plain or headless `agents run` | The harness transcript is discovered and indexed in `sessions.db` like an interactive session | Dispatch/audit events |
| Team teammate | Its own harness transcript is indexed as a session with team-origin metadata and a parent orchestrator link | Team registry and teammate `meta.json` retain DAG/task/process state |
| Agent/workflow routine | Its transcript is archived beneath the routine run and indexed as a session with `routineName` + `routineRunId` | `RunMeta` retains the attempt outcome |
| Command-only, blocked, skipped, or missed routine | No session exists because no agent conversation occurred | `RunMeta` is the canonical record |

Team-origin sessions are stored but excluded from the ordinary historical listing unless the teams filter is enabled. Use `agents sessions --teams`; live teammates are also surfaced by `agents sessions --active` with `context: teams`.

## Contract coverage

| Surface | Status | What callers can rely on |
|---|---|---|
| Sessions | Normative | RFC-2119 contract plus scenarios and implementation citations |
| Secrets | Normative | Storage, prompt, materialization, broker, and audit boundaries |
| Run | Normative with named drift | One execution funnel; ACP and some version isolation deviate |
| Daemon | Partly normative | Scheduler ownership and lifecycle invariants; status/health largely unspecified |
| Routines | Mixed | Scheduling and run history are current; readiness/context is mostly intended |
| Teams | Descriptive only | Strong design documentation, but no normative `TEAM-*` contract |

Source: [`apps/cli/docs/specifications.md`, coverage inventory](../../../apps/cli/docs/specifications.md#coverage-inventory).

## Findings

### 1. Sessions

## Parse and persist once—then consume deltas

The correct invariant is not “a transcript is literally parsed only once.” It is:

> Parse the existing transcript on cold discovery, persist its derived row plus parser continuation, and thereafter fold only appended complete records. Reparse from byte zero only when the continuation is unsafe.

| Invariant | Status | Evidence |
|---|---|---|
| Unchanged directories and files are served from SQLite without reparsing | Current | [`sessions.md:115`](../../../apps/cli/docs/sessions.md) |
| Claude, Codex, and Kimi resume from persisted byte offsets and accumulators | Current | [`sessions.md:278`](../../../apps/cli/docs/sessions.md) |
| Incremental output must equal a from-scratch parse | `SES-5`, Current | [`specifications.md:180`](../../../apps/cli/docs/specifications.md) |
| Unterminated JSONL tails are deferred, preventing partial/double application | `SES-5`, Current | [`sessions.md:295`](../../../apps/cli/docs/sessions.md) |
| Claude/Codex first-event identity is rechecked before trusting continuation | `SES-5`, Current | [`discover.ts:4007`](../../../apps/cli/src/lib/session/discover.ts) |
| A malformed line is skipped; an unknown format fails loudly | `SES-3/4`, Current | [`specifications.md:173`](../../../apps/cli/docs/specifications.md) |

## Durable facts are separate from live state

| Invariant | Status |
|---|---|
| Transcript-derived preview data is cached by source mtime and size | Current |
| Live working/waiting state is fetched separately and expires within 15 seconds | Current |
| Empty rescans cannot clobber a better stored label | `SES-14`, Current |
| PID liveness must guard against PID reuse | `SES-17`, Current |
| File-gone sessions with indexed user content remain archived and render from the DB | Current, RUSH-2436 |

Evidence: [`sessions.md:137`](../../../apps/cli/docs/sessions.md), [`sessions.md:194`](../../../apps/cli/docs/sessions.md), and [`specifications.md:262`](../../../apps/cli/docs/specifications.md).

### 2. Secrets

| Invariant | Status | Consequence |
|---|---|---|
| Bundle metadata is separate from protected values | `SEC-4`, Current | Enumeration cannot trigger biometric reads |
| Every command occupies exactly one materialization boundary | `SEC-6`, Current | A code path cannot “sometimes” expose plaintext |
| Injection reaches only the child environment, never stdout or argv | `SEC-7/8a`, Current | Agents do not ingest secrets into context/transcripts |
| Agent and detached execution are broker-only | `SEC-13/13a`, Current | Automation cannot spontaneously raise Touch ID |
| Only explicit interactive reveal/run commands may prompt | `SEC-13b`, Current | Prompt authority follows user intent |
| A broker miss is a normal cache miss, not an error or prompt | `SEC-14`, Current | The broker is a cache, not the credential authority |
| Auditing has one value-free write path and attributes the requester | `SEC-26/28`, Current | Broker/daemon identity cannot replace session identity |

Evidence: [`specifications.md:1090`](../../../apps/cli/docs/specifications.md) through the Secrets requirements.

### 3. Run

## One funnel, deterministic inputs

| Invariant | Status | Consequence |
|---|---|---|
| Every ordinary invocation reaches `buildExecCommand` + `buildExecEnv` + spawn | `EXEC-18`, Current | Teams, routines, loops, fallback, and SSH do not invent engines |
| Ambient loader/interpreter hijack variables are stripped | `EXEC-1`, Current | The parent shell cannot silently subvert the child |
| Env precedence is profile → share → secrets → explicit `--env` | `EXEC-5/6`, Current | Configuration resolution is deterministic |
| Secret bundle resolution is atomic before spawn | `EXEC-9`, Current | No partially credentialed child launches |
| Every finalized run records exactly one dispatch audit | `EXEC-21`, Current | One governance chokepoint |
| Modes are resolved against harness capabilities | `EXEC-22`, Current | Unsupported modes fail or use documented degradation |
| Remote dispatch re-executes `agents run` on the target | `EXEC-30`, Current | Remote execution retains the same engine |
| Actor provenance crosses SSH | `EXEC-31`, Current | Attribution survives placement |
| Remote secret values never enter the command line | `EXEC-33/39`, Current | No argv/shell leakage |
| Remote `~`/`$HOME` cwd resolves on the remote machine | `EXEC-35`, Current | No local-home path corruption |
| `--no-follow` reports dispatch, not completion | `EXEC-36`, Current | Detached success is not mistaken for task success |

Evidence: [`specifications.md:1700`](../../../apps/cli/docs/specifications.md).

## Named drift

<div class="artifact-callout artifact-callout-warn"><strong>Version isolation:</strong> several registered harnesses do not receive a complete per-version configuration directory from <code>buildExecEnv</code>. This is explicitly marked <code>[Drift]</code> under <code>EXEC-16</code>.</div>

<div class="artifact-callout artifact-callout-warn"><strong>ACP:</strong> <code>--acp</code> bypasses the normal env builder, losing sanitization, provenance, mailbox/session wiring, runtime labeling, and version pinning. This is explicitly marked <code>[Drift]</code> under <code>EXEC-19/20</code>.</div>

### 4. Daemon and scheduler ownership

| Invariant | Status |
|---|---|
| Every fleet-affecting capability has exactly one scheduler and executor | `SING-1`, Current |
| UIs cannot own autonomous acting timers/watchers | `SING-2`, Current |
| UI-owned actions expose narrow endpoints; the CLI retains the trigger | `SING-3`, Current |
| Scheduled slots have deterministic UTC identities and atomic claims | `SING-5b`, Current |
| A routine cannot overlap itself across entry points | `SING-5c`, Current |
| Run metadata exists before pre-spawn work | `SING-5e`, Current |
| Shared-input jobs require an owner, atomic item claim, or proven idempotency | `SING-9`, Current |
| Detached children survive takeover and are adopted from persisted state | `SING-11a`, Current |
| Stop verifies that owned resources were actually released | `SING-12/12a`, Current |
| Restart supervision is bounded | `SING-14`, Current |

Evidence: [`specifications.md:2377`](../../../apps/cli/docs/specifications.md).

<div class="artifact-callout artifact-callout-warn"><strong>Coverage gap:</strong> daemon scheduler ownership is normative, but <code>agents daemon status</code>, services, health rendering, and doctor behavior do not have their own command contract.</div>

### 5. Teams

## Strong design, weak contract status

| Invariant described today | Why it matters |
|---|---|
| Team and teammate state persists on disk | A supervisor restart cannot erase DAG progress |
| One orchestrator drains the DAG, including distributed teams | Remote workers do not independently schedule waves |
| Names, dependencies, and cycles validate before worktree creation | Invalid DAGs leave no branch debris |
| Editing teammates receive explicit ownership boundaries | Parallelism does not become invisible file contention |
| Worktrees branch from freshly fetched `origin/<default>` locally and remotely | Every teammate begins from the current shared baseline |
| Failed creation is transactional | Retrying the same teammate name works |
| Cleanup fails closed when ownership is uncertain | Recoverable leftovers beat deleted work |
| `meta.json` writes are atomic | Process death cannot leave torn state |
| No eligible remote device means a loud failure, not implicit local placement | Placement intent is preserved |
| One team has one repository | Cross-repo work uses explicit team boundaries |
| Pending dependency-blocked teammates are not reaped | Waiting is a durable state, not inactivity |

Evidence: [`teams.md`](../../../apps/cli/docs/teams.md), especially [boundary contracts](../../../apps/cli/docs/teams.md#boundary-contracts), [worktree isolation](../../../apps/cli/docs/teams.md#worktrees-and-isolation), and [distributed teams](../../../apps/cli/docs/teams.md#distributed-teams).

<div class="artifact-callout artifact-callout-danger"><strong>Missing contract:</strong> these behaviors are descriptive documentation. There is no normative <code>TEAM-*</code> section with RFC-2119 guarantees and Given/When/Then scenarios.</div>

## Minimum normative contract teams still needs

1. Durable and atomic state transitions.
2. DAG validation and supervisor restart recovery.
3. Fresh-base worktree isolation.
4. Transactional add and fail-closed cleanup.
5. Remote placement without silent fallback.
6. A distinction between process completion and delivered/merged work.
7. Exactly one supervisor per team.

### 6. Routines

## Current guarantees

| Invariant | Status |
|---|---|
| The daemon is the only automatic scheduler | `SING-1/5`, Current |
| Slot claims and no-overlap prevent duplicate execution | `SING-5b/5c`, Current |
| `projects[]` is grouping metadata only | `RT-1`, Current |
| Routine run history—not sessions—is the canonical attempt ledger | `RT-6`, Current portion |
| `repo` is external identity/provenance, never a local cwd | `RT-8`, Current |
| Menu-bar routine views remain read-only schedulingly | `RT-11`, Current |

## Intended but not implemented

| Target invariant | Status today |
|---|---|
| Singular project execution anchor separate from grouping tags | `RT-2`, Intended |
| Resolve cwd on the actual execution target | `RT-3`, Intended |
| Agent/workflow bodies cannot silently default to home | `RT-4`, Intended |
| Add/edit proves cwd, trust, and authenticated readiness before activation | `RT-5`, Intended |
| Proven blockers save the routine paused with stable machine-readable codes | `RT-5`, Intended |
| Resume reruns readiness and cannot bypass a blocker | `RT-9`, Intended |
| Raw YAML edits validate then atomically replace | `RT-10`, Intended |
| Run statuses distinguish `blocked` and `skipped` from `failed` | `RT-7`, Intended portion |

Evidence: [`specifications.md:2771`](../../../apps/cli/docs/specifications.md) and the explicit [known gaps](../../../apps/cli/docs/specifications.md).

## Evidence

The findings were checked against the current normative specification, subsystem design documents, and the scanner/database implementation. The linked source locations throughout the report are the evidence index; the primary sources are:

- [`apps/cli/docs/specifications.md`](../../../apps/cli/docs/specifications.md)
- [`apps/cli/docs/sessions.md`](../../../apps/cli/docs/sessions.md)
- [`apps/cli/docs/teams.md`](../../../apps/cli/docs/teams.md)
- [`apps/cli/src/lib/session/discover.ts`](../../../apps/cli/src/lib/session/discover.ts)
- [`apps/cli/src/lib/session/db.ts`](../../../apps/cli/src/lib/session/db.ts)

## Priority gaps

| Priority | Gap | Reason |
|---|---|---|
| 1 | Routine readiness and target-side context resolution | A scheduled definition can appear valid and fail only after firing |
| 2 | Normative teams contract | Durable DAG/worktree behaviors are important but not protected as caller guarantees |
| 3 | Run ACP funnel parity | A named bypass loses core environment and provenance guarantees |
| 4 | Complete per-version run isolation | Some harnesses remain account/config global despite the broader isolation principle |
| 5 | Daemon status and health contract | Scheduler ownership is specified; operational observability is not |

## Bottom line

- **Sessions:** compute durable metadata incrementally and store it; recompute only live state or changed transcript deltas.
- **Secrets:** metadata, values, broker cache, materialization, and audit identity remain separate layers.
- **Run:** every caller uses one sanitized, isolated, auditable execution funnel.
- **Daemon:** one owner schedules and executes autonomous actions.
- **Teams:** durable DAG plus isolated worktrees, but the guarantees need promotion from prose to a normative contract.
- **Routines:** the scheduling core is real; readiness, execution anchoring, and honest blocked/skipped outcomes are still target architecture.
