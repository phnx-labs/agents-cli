---
kind: plan
template: plan.v1
title: "Phoenix Evals — the eval-by-replay loop that connects execution to analytics"
summary: "We have execution and we have analytics as two disjoint subsystems. Phoenix Evals is the bridge: parse a run into a persisted span tree, score it with an LLM-judge, detect a regression vs the last green baseline, dispatch a coding-agent fix, replay the failing case, merge on green. Build local `agents eval` first (dogfood on our fleet), then lift the same judge in-pod for prix (ZDR, per-client)."
status: draft
tracking: RUSH-2667
project: AGI
repository: agents-cli
date: 2026-08-24
---

## Focus for review

Weigh in on these four; everything else I'll decide and state inline.

1. **Sequencing** — I propose **local `agents eval` first, dogfooded on our own fleet**, then the same engine lifted into prix per-client. That order, or cloud-first?
2. **The scoreboard shape** — two terminal layouts in §Public Interface. Pick one (I lean B).
3. **What "regression" means for the auto-fix trigger** — a score drop vs the last green baseline on the *same task*. Agree, or a different bar?
4. **Scope of milestone 1** — line drawn at "score a run, persist the span tree, show a scoreboard." The auto-fix→replay→merge loop is milestone 3. Right first cut?

## Purpose

Your words: *"not just the execution and not just analytics but both combined that enables you to iterate and improve your agents."*

The Prix Cloud pitch names the same thing as its one defensible claim — **eval-by-replay that proves the work** (§2 scorecard: the fifth leg no competitor holds). Today we have execution and we have analytics, and **nothing between them**. Four parallel file:line-grounded sweeps confirmed both halves are built and solid, and the bridge is absent in *both* repos:

| Piece | State today | Evidence |
| --- | --- | --- |
| jsonl capture | present — harnesses write natively; we discover/index | `discover.ts:1204-1213` |
| span/trajectory model | derived by `sessions trace`, then **thrown away** | `trajectory.ts:1-20` ("never persisted") |
| run stats (tokens/cost/tools) | present, rich, on `sessions.db` + `cloud_executions` | `db.ts:76-135`, migration `113` |
| deterministic pass/fail | present — 4 criteria, no scoring | `bench/schema.ts:20-37` |
| **span parser (persisted, typed)** | **absent** | no matches, both repos |
| **LLM-judge / rubric scorer** | **absent** (only human 1–5 stars) | no matches, both repos |
| **eval store + replay loop** | **absent** | no matches, both repos |

<div class="artifact-callout">
The R2 transcript is per-line AES-GCM encrypted server-side (migration <code>113</code>) — the server literally cannot decrypt it. So eval <b>must</b> run in-session, before purge. That is not a limitation: it <i>is</i> the pitch's zero-data-retention wedge, forced by the architecture. Keep only the score and the structure; the content never persists.
</div>

## Proposed Changes

The rule is **no rebuild**: the span parser is `trajectory.ts` made persistent, the scorer is a new criterion on the existing bench engine, the store is one table beside `sessions.db`.

<div class="artifact-behavior">
  <div class="artifact-behavior-panel" data-state="current" data-evidence="capture">
    <strong>Today:</strong> <code>agents sessions trace &lt;id&gt;</code> derives a per-step trajectory (spanMs, paired tool_use/tool_result, idle gaps) and prints it — then <strong>discards it</strong>. Quality is a human 1–5 star rating in the prix console; nothing scores a run automatically, nothing compares a run to a past baseline, nothing acts on a regression.
  </div>
  <div class="artifact-behavior-panel" data-state="proposed" data-evidence="mockup">
    <strong>Proposed:</strong> <code>agents eval run &lt;task&gt; --agent claude,codex</code> runs the task per harness, persists each run's span tree, scores it with an LLM-judge against the task rubric, and prints a scoreboard (score 0–100, pass/fail, wall, tokens, $). A drop vs the last green baseline is flagged a regression; <code>agents eval fix</code> dispatches a coding-agent fix, replays the failing case, and opens a PR that merges on green.
  </div>
</div>

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg class="artifact-diagram" viewBox="0 0 900 380" role="img" aria-label="Execution and analytics exist as two disjoint subsystems with the eval bridge missing between them">
    <text x="30" y="30" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="15" font-weight="700">EXECUTION — exists</text>
    <rect x="30" y="45" width="220" height="52" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
    <text x="42" y="72" fill="#c8c8c8" font-family="Inter, sans-serif" font-size="13">harness writes jsonl</text>
    <text x="42" y="89" fill="#7c9a4e" font-family="JetBrains Mono, monospace" font-size="10">discover.ts:1204</text>
    <rect x="30" y="107" width="220" height="52" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
    <text x="42" y="134" fill="#c8c8c8" font-family="Inter, sans-serif" font-size="13">sessions.db index</text>
    <text x="42" y="151" fill="#7c9a4e" font-family="JetBrains Mono, monospace" font-size="10">tokens·cost·tools db.ts:76</text>
    <rect x="30" y="169" width="220" height="52" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
    <text x="42" y="196" fill="#c8c8c8" font-family="Inter, sans-serif" font-size="13">sessions trace → trajectory</text>
    <text x="42" y="213" fill="#d08a1a" font-family="JetBrains Mono, monospace" font-size="10">derived, NOT persisted</text>
    <rect x="30" y="231" width="220" height="52" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
    <text x="42" y="258" fill="#c8c8c8" font-family="Inter, sans-serif" font-size="13">run --broadcast (ex-bench)</text>
    <text x="42" y="275" fill="#7c9a4e" font-family="JetBrains Mono, monospace" font-size="10">exit-code only schema.ts:20</text>

    <text x="650" y="30" fill="#c8c8c8" font-family="Inter, sans-serif" font-size="15" font-weight="700">ANALYTICS — exists</text>
    <rect x="650" y="45" width="220" height="52" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
    <text x="662" y="72" fill="#c8c8c8" font-family="Inter, sans-serif" font-size="13">prix console analytics</text>
    <text x="662" y="89" fill="#7c9a4e" font-family="JetBrains Mono, monospace" font-size="10">SQL rollups analytics.ts:61</text>
    <rect x="650" y="107" width="220" height="52" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
    <text x="662" y="134" fill="#c8c8c8" font-family="Inter, sans-serif" font-size="13">session_analytics table</text>
    <text x="662" y="151" fill="#7c9a4e" font-family="JetBrains Mono, monospace" font-size="10">flat summary migration 072</text>
    <rect x="650" y="169" width="220" height="52" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
    <text x="662" y="196" fill="#c8c8c8" font-family="Inter, sans-serif" font-size="13">quality signal =</text>
    <text x="662" y="213" fill="#d08a1a" font-family="JetBrains Mono, monospace" font-size="10">human 1–5 stars only</text>
    <rect x="650" y="231" width="220" height="52" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
    <text x="662" y="258" fill="#c8c8c8" font-family="Inter, sans-serif" font-size="13">run-stats → cloud_executions</text>
    <text x="662" y="275" fill="#7c9a4e" font-family="JetBrains Mono, monospace" font-size="10">scalar counters mig 113</text>

    <rect x="300" y="55" width="300" height="240" rx="10" fill="#1a1206" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="6 4"/>
    <text x="450" y="80" text-anchor="middle" fill="#f4b942" font-family="Inter, sans-serif" font-size="13" font-weight="700">THE GAP — Phoenix Evals</text>
    <text x="450" y="99" text-anchor="middle" fill="#b98a2a" font-family="Inter, sans-serif" font-size="11">absent in BOTH repos</text>
    <rect x="322" y="115" width="256" height="44" rx="8" fill="#0f0f12" stroke="#38bdf8" stroke-width="1.5"/>
    <text x="450" y="142" text-anchor="middle" fill="#c8c8c8" font-family="Inter, sans-serif" font-size="12">① span parser (jsonl → typed tree)</text>
    <rect x="322" y="169" width="256" height="44" rx="8" fill="#0f0f12" stroke="#38bdf8" stroke-width="1.5"/>
    <text x="450" y="196" text-anchor="middle" fill="#c8c8c8" font-family="Inter, sans-serif" font-size="12">② LLM-judge + rubric scorer</text>
    <rect x="322" y="223" width="256" height="44" rx="8" fill="#0f0f12" stroke="#38bdf8" stroke-width="1.5"/>
    <text x="450" y="250" text-anchor="middle" fill="#c8c8c8" font-family="Inter, sans-serif" font-size="12">③ regression → fix → replay → merge</text>

    <line x1="250" y1="195" x2="318" y2="185" stroke="#a3e635" stroke-width="2"/>
    <line x1="582" y1="185" x2="648" y2="195" stroke="#f59e0b" stroke-width="2" stroke-dasharray="4 4"/>
    <text x="450" y="330" text-anchor="middle" fill="#8a8a8a" font-family="Inter, sans-serif" font-size="11">execution feeds the parser; the scored signal feeds analytics —</text>
    <text x="450" y="348" text-anchor="middle" fill="#8a8a8a" font-family="Inter, sans-serif" font-size="11">the dashed edge on the right is what's missing today</text>
  </svg>
  <figcaption><b>Figure.</b> Execution (left) and analytics (right) are both built. The three boxes in the middle band exist in neither repo — that is Phoenix Evals.</figcaption>
</figure>

### ① Persist the span tree — lift `trajectory.ts`, don't fork it

`trajectory.ts` already builds the typed tree; its own docblock says it is *"never persisted onto `SessionEvent` or the SQLite `tool_calls` index."* Milestone 1 persists it under a schema-versioned table so a judge and a later replay can read it back. `TrajectoryStep` (`trajectory.ts:28-88`) already carries every column below — this is a straight projection, redaction already applied.

```diff title=apps/cli/src/lib/session/db.ts
@@ SCHEMA_VERSION 40 → 41 @@
+  db.exec(`
+    CREATE TABLE IF NOT EXISTS eval_spans (
+      session_id   TEXT NOT NULL,
+      ordinal      INTEGER NOT NULL,
+      kind         TEXT NOT NULL,          -- 'tool' | 'thinking'
+      tool         TEXT,
+      program      TEXT,                   -- effective shell program (git/bun/gh)
+      start_ms     INTEGER NOT NULL,
+      duration_ms  INTEGER NOT NULL,
+      outcome      TEXT,                   -- 'ok' | 'error' | 'unknown'
+      exit_code    INTEGER,
+      label        TEXT NOT NULL,          -- already redacted by trajectory.ts
+      PRIMARY KEY (session_id, ordinal)
+    );`);
```

### ② The judge — a new criterion type on the existing engine

Bench criteria today are deterministic only (`bench/schema.ts:20-37`). Add one variant; the deterministic ones still run first and short-circuit, so the judge fires only when structure passes.

```diff title=apps/cli/src/lib/bench/schema.ts
@@ inside parseTask's pass.map @@
   if (type === "command_succeeds")
     return { type, command: string(criterion.command, `…command`) };
+  if (type === "llm_judge")
+    return {
+      type,
+      rubric: string(criterion.rubric, `task.pass[${index}].rubric`),
+      // 0–100; below (baseline − drop) on the same task = regression
+      min_score: typeof criterion.min_score === "number" ? criterion.min_score : 70,
+    };
   throw new Error(`task.pass[${index}].type is unsupported: ${type}`);
```

The judge itself is a headless `agents run` against the run's **span tree + final diff**, returning structured per-dimension scores (Claude as judge by default; model is a flag). No new provider plumbing — it reuses `executeCellViaAgentsRun` (`bench/runner.ts:33`).

### Milestones

- **M1 — Score & persist.** `eval_spans` table; lift `trajectory.ts` to persist; `llm_judge` criterion; `agents eval run`/`show`/`ls`; scoreboard. Dogfoodable on our fleet. *No cloud.*
- **M2 — Baselines & regression.** `eval baseline`; regression vs last green on the same task; house rubric-tasks for our own skills (blog, plan, review).
- **M3 — The loop.** `eval fix`: regression → dispatch coding-agent fix (isolated worktree) → replay failing case → PR → merge on green. The pitch's improvement loop.
- **M4 — Lift to prix (product).** Same judge, run **in-pod before purge** (ZDR); per-client scoped; scored signal → control plane, content never persisted. Gated on RUSH-2988.

## Public Interface

`agents bench` was retired into `run --broadcast` (`command-registry.ts:70`). `eval` is the noun that owns scoring; `run --broadcast` stays the matrix primitive underneath. Every subcommand takes `--json`; `run`/`show` carry a `setHelpSections` examples block so help teaches the loop.

```bash
agents eval run <task> --agent claude,codex [--model …]   # score a task across cells
agents eval show <run-id>                                  # scored span trajectory
agents eval baseline <task>                                # the current green bar
agents eval ls [--task <t>] [--json]                       # scoreboard history
agents eval fix <run-id>                                   # M3: dispatch → replay → PR
```

**Scoreboard — pick one (Focus #2). Variant A, matrix (agent × task):**

```text
  agents eval run skill-blog --agent claude,codex

  TASK          claude                    codex
  ────────────  ────────────────────────  ────────────────────────
  skill-blog    ● 88  4.2s  12k  $0.14     ● 71  6.1s  22k  $0.19
                citations ✓  voice ✓       citations ✗ (0 links) ▼

  baseline (green): claude 86 · codex 79        1 regression ▼ codex
```

**Variant B, ranked rows (one run per line, sorted by score) — I lean B:**

```text
  agents eval run skill-blog --agent claude,codex

  #  AGENT   SCORE  Δbase   PASS  WALL   TOK   COST   NOTES
  1  claude   88    +2 ▲    ✓     4.2s   12k   $0.14  —
  2  codex    71    −8 ▼    ✗     6.1s   22k   $0.19  citations 0 links

  regression: codex −8 vs green baseline 79 → `agents eval fix <run>`
```

B reads as a leaderboard (better for `eval ls` history and the future public scoreboard, RUSH-2305) and puts the regression + next action last; A reads as a bench matrix (better for one-shot agent comparison).

## Validation

| Check | Expected result |
| --- | --- |
| `eval_spans` persists | After `eval run`, one row per `TrajectoryStep`; re-scan is idempotent (mtime/size-stamped like `tool_calls`) |
| Judge is real, not mocked | `eval run` on a task with a bad output scores it low and names the failing rubric dimension |
| Deterministic-first | A structurally-failing run never reaches the judge (exit/file criteria short-circuit) |
| Regression detection | A run below `baseline − drop` on the same task is flagged, exit non-zero for CI |
| Redaction | Persisted `label` carries no secrets (reuses `redactSecrets`, same path as `render`/`share`) |
| Dogfood | `eval run` over our own skills (blog/plan/review) produces a stable scoreboard across two runs |

## Risks

- **Judge nondeterminism.** LLM scores wobble run-to-run. Mitigate: score the *diff of structure*, fix the judge model+prompt per task, and treat only a drop beyond a margin as a regression (not any delta).
- **Rubric authoring cost.** Each house task needs a rubric. Mitigate: start with 3 (blog, plan, review) we already have opinions on; deterministic criteria carry the rest.
- **`trajectory.ts` coupling.** Persisting its output couples the store to its shape. Mitigate: `SCHEMA_VERSION` bump + the table is a projection, not the source of truth — re-derivable from the transcript.
- **Prix encryption (M4).** In-pod eval is mandatory, not optional (mig 113). Accepted — it is the ZDR design, and M1–M3 don't touch it.
- **Scope creep into RUSH-2988.** M4 depends on the control plane; M1–M3 deliberately don't, so value lands before that ticket does.
