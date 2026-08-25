# Teams reliability audit — 100-day fleet transcript mine

Tracking: RUSH-3195

## Executive result

The fleet corpus contains **21 unique team-launch-bearing tool calls** in the last 100
days after fork duplicates and help-only calls are removed. Every one of those
21 calls was recovered from its original harness transcript. The observed
callers were Claude (14 calls across versions 2.1.186–2.1.225) and
Codex (7 calls); no Grok, Kimi, or Cursor session in the indexed corpus
issued such a call. Those harnesses do appear as teammates, so the absence is
an observation about who invoked the command, not proof that they cannot.

The dominant problem is not one catastrophic spawn bug. It is that launching a
team is a multi-command, partially transactional workflow whose preflight,
remote environment, progress, and terminal outcome leak back to the
orchestrator. Agents repeatedly compensate with `tail`, `grep`, retries,
`--confirm`, status polling, and transcript reads. A reliable surface should
make those compensations unnecessary.

## Method and coverage

`mine-teams-sessions.ts` does four things:

1. Queries the pre-indexed tool-call rows in each reachable host's
   `sessions.db` for `agents teams` calls in the last 100 days.
2. Keeps real `create`, `add`, and `start` calls for Claude, Codex, Grok, Kimi,
   and Cursor; it excludes help/status-only calls and de-duplicates calls copied
   into forked transcripts, selecting the earliest-created source session.
3. Streams a redacted session bundle from the owning host and reads the original
   harness body rather than treating the SQLite preview as the transcript.
4. Captures the launch result and following native transcript records for
   classification without committing raw transcripts, local paths, host names,
   or session identifiers.

At the final run, the search index reported **3,906 transcript files**, **217,120
tool calls**, **106 size-limited files**, and **306 files still awaiting tool-call
backfill** in the 100-day selection. One registered host was unreachable. The
21-call count is therefore a verified lower bound, not a claim of mathematical
completeness. All 21 discovered source transcripts were recovered successfully.

## Observed failure and friction classes

### 1. Fatal-looking bootstrap errors accompany successful launches

Four independent Claude launches, spanning versions 2.1.186, 2.1.217,
2.1.218, and 2.1.221, emitted:

> `ERROR: GVM_ROOT not set. Please source $GVM_ROOT/scripts/gvm`

The same command then printed `New team`, and later `teams add` printed
`status running`. Agents hid the line with `grep -v GVM_ROOT` or truncated the
output with `tail`. This is dangerous because the command reports both failure
and success, so neither a person nor an agent can trust the boundary.

Required fix: remote/non-interactive team execution must use a deterministic
shell environment and separate startup diagnostics from command diagnostics. A
successful command must not contain an `ERROR:` line; a broken bootstrap must
fail before creating team state.

### 2. Preflight happens after team state exists

One launch created the team and then blocked the first teammate because its
checkout was 107 commits behind `origin/main`. The output instructed the agent
to merge and rerun or pass `--confirm`. This guard is intentional and tested in
`apps/cli/src/commands/teams.stale-guard.test.ts`, but its placement makes a
normal launch partially successful: the empty team exists while the requested
work does not.

Required fix: add a read-only launch preflight that resolves repository
freshness, harness/version availability, authentication, device reachability,
worktree names, dependencies, and capacity for the complete roster before any
team or teammate is persisted. The stale-repo policy can stay strict; it should
be evaluated before side effects.

### 3. Shell chaining is the de facto batch API and can launch only a prefix

Agents routinely put `create`, several `add` calls, and `start --watch` into one
shell command. In one three-teammate audit launch, the immediate output contained
only the team and first teammate even though the requested command contained
three adds plus start. The orchestrator then had to inspect status to learn what
actually existed. Codex tool-call previews compounded this by recording
`[object Object],[object Object]` instead of the command result.

Required fix: provide one transactional roster-launch operation (a manifest or
repeatable teammate argument) that validates the entire roster, persists it
atomically, starts it, and returns one structured result containing every
teammate. Shell `&&` must not be the only batch contract. JSON output must remain
structured through the session tool index instead of degrading to object string
coercion.

### 4. Teammate failures are visible only after manual status archaeology

The mined launches include a team later reported as `0 working, 0 done, 3
failed`. The status row showed a seven-second failure with 46 tools but did not
surface the causal error in the compact summary; the orchestrator proceeded to
query team status and external PR state. Another launch inherited non-blocking
hook errors pointing at deleted temporary hook-shim paths before the team command
ran. These are upstream environment defects, but teams is the orchestration
boundary that must turn them into an actionable terminal result.

Required fix: a failed teammate needs a stable `cause`, `stage`, `retryable`,
and `next_command` in both JSON and the default status row. `start --watch`
should finish with a roster-wide terminal summary that includes the first real
failure for each failed teammate without requiring `teams logs`.

### 5. Watching is not ownership

The corpus contains the documented dead-watch case: an orchestrator claimed a
background poll would re-invoke it, but no watcher process existed while four
teammates remained running. Other launches repeatedly moved from launch to
manual `teams status`, PR queries, and transcript inspection. The current teams
skill explicitly calls this the most expensive failure mode.

Required fix: `teams start --watch` must be a durable supervisor contract, not a
foreground convenience. It should persist supervision in the daemon, expose a
watch identity and heartbeat, and emit exactly one terminal event that can
re-enter the owner. Registration without a live action must fail loud.

### 6. Completion is not a team-level invariant

Several briefs explicitly say “PR open” or “waiting for review” is incomplete,
because teammates historically stop there. That contract currently lives in
prompt prose and hooks. The team state machine still treats agent-process
completion as the primary terminal signal, while delivery is inferred later by
the orchestrator.

Required fix: let a team declare its completion policy (`session-finished`,
`artifact-produced`, `PR-open`, `PR-merged`, or composed verification). Persist
delivery evidence per teammate. A team configured for `PR-merged` must not show
done merely because the harness exited.

## Stability backlog

| Priority | Canonical change | Acceptance signal |
|---|---|---|
| P0 | Transactional `teams launch`/manifest: preflight full roster, persist all-or-none, start, structured result | One command creates 3 mixed-harness teammates; any invalid teammate leaves no team/worktree/process |
| P0 | Durable daemon-owned supervisor for `start --watch` | Kill the invoking terminal; team continues, heartbeat remains visible, owner receives one terminal event |
| P0 | Deterministic local/SSH shell environment | Fleet launch has no startup `ERROR:` noise; bootstrap failure creates no state |
| P0 | Structured terminal causes in status/watch JSON | A real failed harness reports stage, cause, retryability, and exact recovery command without reading logs |
| P1 | Delivery-aware completion policy | `PR-merged` team remains unfinished while any linked PR is open/red/unreviewed |
| P1 | Preserve structured tool results in session indexing | Codex launch output is JSON/text evidence, never `[object Object]` |
| P1 | Fleet-wide launch conformance suite | Claude, Codex, Grok, Kimi, and Cursor each orchestrate; every applicable harness also runs as teammate on local and remote paths |
| P2 | Friction telemetry rollup | `teams doctor` reports preflight failure counts by stable cause without mining transcripts |

## Proposed end-to-end test matrix

The real-service suite should cover the composed workflow, not isolated command
helpers:

- local and remote launch;
- clean and stale repositories;
- valid and invalid harness/version/account;
- one teammate and a three-stage DAG;
- per-teammate worktrees and a deliberate name collision;
- invoking terminal disappears during watch;
- harness exits before session id, after session id, and after opening a PR;
- retry/resume after a retryable failure;
- machine-readable output round-tripped through `sessions.db`;
- orchestrator harnesses Claude, Codex, Grok, Kimi, and Cursor, with all
  applicable teammate harnesses exercised.

The success criterion is simple: after one launch request, either the complete
declared team is durably supervised to its declared delivery state, or no side
effect remains and one actionable error explains why.
