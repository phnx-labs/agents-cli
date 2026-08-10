---
kind: plan
template: plan.v1
title: Routine Reliability — execution context, readiness, single-fire, history
summary: Make routines resolve where they run on the execution target, prove they are runnable before activating, fire each scheduled slot at most once, and record every attempt as inspectable history.
project: agents-cli
context: apps/cli routines subsystem
tracking: RUSH-2290
status: approved
repository: phnx-labs/agents-cli
branch: agents/routine-docs-contract
harness: claude
agent: claude-opus-4-8
host: yosemite-s0
date: 2026-08-07
facts:
  - 'Ticket: RUSH-2290'
  - 'Scope: routines execution + readiness + single-fire + history'
  - 'Runtime change: none in this docs track'
links:
  - https://linear.app/getrush/issue/RUSH-2290
  - https://share.agents-cli.sh/muqsitnawaz/agents-cli-routine-reliability-5975559096b19ff4
  - https://github.com/phnx-labs/agents-cli/blob/main/apps/cli/docs/specifications.md
---

## Purpose

Unattended routines fail silently. A swarm on 2026-08-06 found the live fleet was not
stable: dead accounts produced `auth_failed: Please run /login`, stopped schedulers
left routines overdue, and a single scheduled slot could launch **9–10** times because
no durable per-occurrence claim existed. The common thread is that a routine activates
without proving it can run, resolves its working directory from the wrong machine, and
records nothing when it fails before an agent session starts — so the failure is
invisible until someone looks.

This plan makes a routine (1) resolve **where it runs** on the execution target, (2)
**prove it is runnable** before activating (else save paused with a stable code), (3)
fire each scheduled slot **at most once**, and (4) record **every attempt** as history
that owns its optional session/log/report children.

## Proposed Changes

The reliability model is a gate the routine passes through before any agent body runs,
and an attempt record written for every outcome — including the outcomes that never
spawn a process today.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg class="artifact-diagram" viewBox="0 0 940 300" role="img" aria-label="Routine reliability pipeline: context resolution, readiness gate, single-fire slot claim, run history">
    <rect x="20" y="40" width="180" height="70" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5" />
    <text x="110" y="70" text-anchor="middle" fill="#e8e8e8" font-family="Inter, system-ui, sans-serif" font-size="14">1. Context</text>
    <text x="110" y="90" text-anchor="middle" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="10.5">anchor + cwd on target</text>
    <line x1="200" y1="75" x2="250" y2="75" stroke="#38bdf8" stroke-width="2" />
    <rect x="250" y="40" width="180" height="70" rx="8" fill="#0a1016" stroke="#38bdf8" stroke-width="1.5" />
    <text x="340" y="70" text-anchor="middle" fill="#e8e8e8" font-family="Inter, system-ui, sans-serif" font-size="14">2. Readiness</text>
    <text x="340" y="90" text-anchor="middle" fill="#38bdf8" font-family="JetBrains Mono, monospace" font-size="10.5">auth/trust/path smoke</text>
    <line x1="430" y1="75" x2="480" y2="75" stroke="#38bdf8" stroke-width="2" />
    <rect x="480" y="40" width="180" height="70" rx="8" fill="#0a1016" stroke="#38bdf8" stroke-width="1.5" />
    <text x="570" y="70" text-anchor="middle" fill="#e8e8e8" font-family="Inter, system-ui, sans-serif" font-size="14">3. Slot claim</text>
    <text x="570" y="90" text-anchor="middle" fill="#38bdf8" font-family="JetBrains Mono, monospace" font-size="10.5">(routine, scheduledFor)</text>
    <line x1="660" y1="75" x2="710" y2="75" stroke="#a3e635" stroke-width="2" />
    <rect x="710" y="40" width="200" height="70" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5" />
    <text x="810" y="70" text-anchor="middle" fill="#e8e8e8" font-family="Inter, system-ui, sans-serif" font-size="14">4. Run history</text>
    <text x="810" y="90" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10.5">.history/runs/&lt;r&gt;/&lt;run&gt;</text>
    <!-- blocked branch -->
    <line x1="340" y1="110" x2="340" y2="170" stroke="#ef4444" stroke-width="2" stroke-dasharray="4 3" />
    <rect x="250" y="170" width="180" height="52" rx="8" fill="#160a0a" stroke="#ef4444" stroke-width="1.5" />
    <text x="340" y="192" text-anchor="middle" fill="#e8e8e8" font-family="Inter, system-ui, sans-serif" font-size="13">blocker →</text>
    <text x="340" y="210" text-anchor="middle" fill="#ef4444" font-family="JetBrains Mono, monospace" font-size="10.5">paused + blocked run</text>
    <!-- skipped branch -->
    <line x1="570" y1="110" x2="570" y2="170" stroke="#f59e0b" stroke-width="2" stroke-dasharray="4 3" />
    <rect x="480" y="170" width="180" height="52" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5" />
    <text x="570" y="192" text-anchor="middle" fill="#e8e8e8" font-family="Inter, system-ui, sans-serif" font-size="13">already running →</text>
    <text x="570" y="210" text-anchor="middle" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="10.5">skipped run (linked)</text>
    <text x="470" y="270" text-anchor="middle" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="12">Every path — blocked, skipped, missed, failed, completed — writes one terminal run; a session is an optional child.</text>
  </svg>
  <figcaption><b>Figure 1.</b> The reliability pipeline. A proven blocker pauses the routine and records a <code>blocked</code> run before any agent starts; a slot arriving while a prior run is live records a <code>skipped</code> run instead of a second launch.</figcaption>
</figure>

**Grouping vs anchor.** `projects` (plural) stays grouping-only metadata for listings;
a singular `project` (CLI `--project-anchor`) plus a routine-level `cwd` is the
execution anchor, resolved **on the execution target**. A rootless Linear-imported
project, or a bare relative `cwd`, anchors at the target `$HOME`.

**Readiness saves paused.** `add`/`edit` verify readiness (a real headless auth smoke,
not a cache read) and save a proven blocker paused with a stable code
(`project_not_found`, `cwd_missing`, `codex_workspace_untrusted`, `agent_auth_failed`,
`execution_context_missing`, …). `resume` rechecks; a raw YAML edit is atomic
(temp → parse → validate → replace, paused-when-blocked). An agent/workflow routine
with no context saves paused; a `command` routine may default to the target `$HOME`.

**Single-fire.** One atomic claim on `(routine, scheduledFor)` before dispatch, kept
separate from the active-run claim that prevents self-overlap. `repo` is an external
Git/cloud/webhook identity, never a local cwd. The menu bar stays read-only for
scheduling.

## Public Interface

```bash
# Execution anchor + working directory (planned)
agents routines add nightly --project-anchor myapp --cwd services/api \
  --schedule "0 3 * * *" --agent claude --prompt "..."

# Diagnose + repair readiness (planned)
agents routines doctor            # re-check every routine's readiness
agents routines doctor nightly --fix

# Already landed
agents routines resume nightly    # (planned) rechecks readiness before activating
agents routines runs nightly      # attempt history, including blocked/skipped/missed
```

Run statuses distinguish `running | completed | failed | timeout | missed | blocked | skipped`.
`blocked` (readiness failed, no body ran) and `skipped` (self-overlap) are the two new
terminal states.

## Validation

| Check | Expected result |
| --- | --- |
| Context resolver | project base / project+relative / rootless+home / no-project+home resolve; absolute-outside-home + traversal rejected; resolves against the target's filesystem |
| Add / edit / resume | ready activates; missing path/trust/write/auth saves paused; resume cannot bypass readiness |
| Atomic edit | invalid YAML leaves prior bytes untouched; valid-but-unready replaces and pauses |
| Scheduler | two callbacks for one UTC slot → one launch; restart replays no launch |
| Overlap | scheduled/manual/foreground/detached across host/fleet/cloud launch at most one |
| Attempt history | placement, sandbox, account, trust, auth, dispatch failures each write one terminal run; overlap links the active run |

## Risks

| Risk | Mitigation |
| --- | --- |
| `projects[]` grouping silently promoted to execution context | Anchor is a separate singular field + `--project-anchor`; grouping never affects placement (RT-1) |
| Readiness smoke becomes an implicit auto-login or sandbox bypass | Contract forbids it (RT-5); no login, no bypass introduced |
| Documenting planned behavior as if it were live | Every unlanded requirement is marked `[Intended]` with a `-GAP-`; docs mark landed vs planned throughout |
| Backward compatibility of the repeatable `--project` flag | Preserved; the singular anchor is a distinct flag name |

<aside class="artifact-callout"><strong>Load-bearing takeaway:</strong> ready means active; any proven blocker means paused and visible. A routine never overlaps itself, and one scheduled slot launches at most once.</aside>

## Tracking

This docs track (RUSH-2290) lands the normative contract only — no runtime change:

- `apps/cli/docs/specifications.md` — new §Routine execution & readiness (RT-1..RT-11, RT-GAP-1); SING-11..SING-13 + SING-GAP-3.
- `apps/cli/docs/03-routines.md` — user-facing execution-context/readiness/status docs.
- `README.md` §Routines, `apps/cli/AGENTS.md` invariant #7, `apps/cli/.changelog/next/RUSH-2290.md`.
- Companion `phnx-labs/.agents-system` audited: no consumer teaches a contradicted shape (no change needed).

The runtime tracks (context/readiness resolver, fire/history) land separately and flip
each `[Intended]` requirement to `Current` as they ship.
