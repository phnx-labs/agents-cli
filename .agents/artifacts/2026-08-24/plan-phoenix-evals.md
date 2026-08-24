---
kind: plan
template: plan.v1
title: "Phoenix Evals v0 — import your fleet's trajectories, see where your agents fail"
summary: "UI-first wedge (approved): sign in, import your own sessions.db across every device, and see your trajectories + failure hotspots + session-topic treemap — all from signal agents-cli already computes (trajectory.ts, session_insights, tool_calls). Backed by a protected Cloudflare trace store: a sibling agents-traces worker + R2, private-by-construction (Phoenix-bearer on write AND read, owner-namespaced keys, no public GET). The CLI computes, R2 stores, the worker guards, the console renders. Evals grow out of the failures you spot."
status: draft
tracking: RUSH-2667
project: AGI
repository: agents-cli
date: 2026-08-24
---

## Focus for review

The UI shape and the sequencing are approved. Remaining calls that are yours:

1. **Storage & protection** (this plan's core) — confirm the trace store below: sibling `agents-traces` worker + R2, private-by-construction (no public GET), derived-signal-only. Or move a line.
2. **Topic classifier** — the one genuinely-new bit of compute. Cheap heuristic (repo · tools-used · label) to start, LLM label later? I lean heuristic-first.
3. **Home surface** — prix web console (standalone) vs. inside AGI EXT's Fleet panel vs. both. I lean web console first, AGI EXT mirrors it.

## Purpose

Muqsit: *"we should be able to import all his chats and show him his trajectories and problematic areas where his agents are failing… build the UI part first."* Approved after two mockup rounds.

Every eval tool (Braintrust, Maxim) makes you author datasets, scorers, and experiments before you see anything. This inverts that: agents-cli **already indexes every run** in `sessions.db` across every device, and already derives the trajectory (`trajectory.ts`), the friction/correction/stall facets (`session_insights`), and per-call outcomes (`tool_calls`). The analysis exists — it has no screen. A Phoenix account (`agents auth`) is the unlock: import your own runs, see your trajectories and where your agents fail. **Evals grow out of the failures you spot** (score this run → add to a suite), so the eval engine is downstream, not the wedge.

The approved v0 console (mockup committed alongside: `console-v0-mockup.html`): a stat strip (sessions imported · median length · need-attention · tool-error rate), a severity-ranked **Needs attention** list, a **trajectory waterfall** with failure markers and a plain-language "where it went wrong," a **session-topic treemap** (Code/Research/Review/Content/Ops), and a **failure taxonomy** classified *tool · error · cause* — separating a real command failure from a `git-guard` denial from a `PreToolUse` hook rejection.

## Proposed Changes

The build is **UI + a thin, protected sync** — not a new analysis engine. The one load-bearing design is *how the traces are stored and protected*.

<div class="artifact-behavior">
  <div class="artifact-behavior-panel" data-state="current" data-evidence="capture">
    <strong>Today:</strong> every run is indexed only in a per-device local <code>sessions.db</code>. To see a trajectory you run <code>agents sessions trace &lt;id&gt;</code> in a terminal, one session at a time, on the machine that ran it. There is no cross-device view, no failure ranking, no place a human looks. The signal (friction, stalls, tool-error causes) is computed and thrown away.
  </div>
  <div class="artifact-behavior-panel" data-state="proposed" data-evidence="mockup">
    <strong>Proposed:</strong> sign in once, <code>agents traces sync</code> pushes your derived, redacted trajectories from every device into your Phoenix account, and the console shows your whole fleet — ranked by what needs attention, classified by topic, with each failure attributed to its real cause. Private to you: no trace is ever publicly readable.
  </div>
</div>

### The trace store — reuse Cloudflare, guard it hard

We already run `agents-share` (`share.agents-cli.sh`) — a Cloudflare Worker + R2 bucket, with a Phoenix-bearer auth seam (`verifyPhoenixToken` → `GET /api/v1/auth/me` → `{userId}`) and owner-namespaced keys (`worker-template.ts:4-12,76-124`, from RUSH-3135). Traces reuse that seam but flip one thing: **the share worker's GET is public; a trace's GET must never be.**

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg class="artifact-diagram" viewBox="0 0 900 380" role="img" aria-label="The CLI computes and redacts a trace shard, PUTs it with a Phoenix bearer to the agents-traces worker which enforces owner isolation into R2, and the console reads it back owner-scoped">
    <text x="30" y="26" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="14" font-weight="700">YOUR DEVICES (source of truth)</text>
    <rect x="30" y="40" width="200" height="60" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
    <text x="42" y="64" fill="#c8c8c8" font-family="Inter, sans-serif" font-size="12.5">sessions.db (per device)</text>
    <text x="42" y="82" fill="#7c9a4e" font-family="JetBrains Mono, monospace" font-size="10">trajectory · insights · tool_calls</text>
    <rect x="30" y="112" width="200" height="60" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
    <text x="42" y="136" fill="#c8c8c8" font-family="Inter, sans-serif" font-size="12.5">CLI: compute + REDACT</text>
    <text x="42" y="154" fill="#7c9a4e" font-family="JetBrains Mono, monospace" font-size="10">agents traces sync → shard</text>

    <text x="335" y="26" fill="#f4b942" font-family="Inter, sans-serif" font-size="14" font-weight="700">agents-traces WORKER (the guard)</text>
    <rect x="335" y="40" width="230" height="132" rx="10" fill="#1a1206" stroke="#f59e0b" stroke-width="1.5"/>
    <text x="450" y="64" text-anchor="middle" fill="#f4b942" font-family="Inter, sans-serif" font-size="11.5" font-weight="600">PUT + GET both require:</text>
    <rect x="352" y="76" width="196" height="30" rx="6" fill="#0f0f12" stroke="#38bdf8" stroke-width="1.2"/>
    <text x="450" y="95" text-anchor="middle" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="10.5">① valid Phoenix bearer</text>
    <rect x="352" y="110" width="196" height="30" rx="6" fill="#0f0f12" stroke="#38bdf8" stroke-width="1.2"/>
    <text x="450" y="129" text-anchor="middle" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="10.5">② userId == object owner</text>
    <rect x="352" y="144" width="196" height="22" rx="6" fill="#160a0c" stroke="#f0616d" stroke-width="1.2"/>
    <text x="450" y="159" text-anchor="middle" fill="#f0616d" font-family="JetBrains Mono, monospace" font-size="10">NO public GET — private only</text>

    <text x="660" y="26" fill="#c8c8c8" font-family="Inter, sans-serif" font-size="14" font-weight="700">R2 (encrypted at rest)</text>
    <rect x="660" y="40" width="210" height="132" rx="8" fill="#0f0f12" stroke="#56b6e6" stroke-width="1.5"/>
    <text x="672" y="64" fill="#8a8a90" font-family="JetBrains Mono, monospace" font-size="10">bucket: agents-traces</text>
    <text x="672" y="90" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="10.5">&lt;userId&gt;/&lt;device&gt;/</text>
    <text x="688" y="110" fill="#8a8a90" font-family="JetBrains Mono, monospace" font-size="10">index.json</text>
    <text x="688" y="128" fill="#8a8a90" font-family="JetBrains Mono, monospace" font-size="10">sessions/&lt;id&gt;.json</text>
    <text x="672" y="154" fill="#7c9a4e" font-family="JetBrains Mono, monospace" font-size="9.5">derived signal only · no transcripts</text>

    <rect x="335" y="230" width="230" height="60" rx="8" fill="#0f0f12" stroke="#b18aff" stroke-width="1.5"/>
    <text x="450" y="254" text-anchor="middle" fill="#c8c8c8" font-family="Inter, sans-serif" font-size="12.5">Console (web / AGI EXT)</text>
    <text x="450" y="272" text-anchor="middle" fill="#9a7fd0" font-family="JetBrains Mono, monospace" font-size="10">GET owner-scoped → render</text>

    <line x1="230" y1="70" x2="230" y2="142" stroke="#3a3a3f" stroke-width="1.2"/>
    <line x1="230" y1="142" x2="332" y2="120" stroke="#a3e635" stroke-width="2"/>
    <text x="262" y="112" fill="#7c9a4e" font-family="JetBrains Mono, monospace" font-size="9.5">PUT + bearer</text>
    <line x1="565" y1="106" x2="658" y2="106" stroke="#f59e0b" stroke-width="2"/>
    <line x1="658" y1="150" x2="565" y2="260" stroke="#b18aff" stroke-width="1.5" stroke-dasharray="4 3"/>
    <text x="470" y="222" fill="#8a8a90" font-family="JetBrains Mono, monospace" font-size="9.5">read-back via the same guarded worker</text>
  </svg>
  <figcaption><b>Figure.</b> The CLI computes and redacts locally; the worker is a pure guard (bearer + owner check) in front of R2; the console only ever reads its owner's objects. Private-by-construction: no public GET path exists in this worker.</figcaption>
</figure>

<div class="artifact-callout">
Why a <b>separate</b> <code>agents-traces</code> worker/bucket and not a <code>traces/</code> prefix on the public share worker: the security boundary becomes a distinct deployment, so no code path in the artifact worker can <i>ever</i> serve a trace. Fail-safe by isolation, not by an <code>if</code>. Traces have no public/unlisted mode — unlike a shared artifact, a trace is private, full stop.
</div>

**The four protection rules:**
1. **Auth on write AND read** — both verify a Phoenix bearer via the existing `verifyPhoenixToken` seam. No anonymous access.
2. **Owner-namespaced keys** — every object is `<userId>/…`; PUT enforces the path's first segment == the token's `userId` → 403 on mismatch (reuses the share worker's check).
3. **Private GET** — every GET requires the bearer and verifies `userId == owner`. No public route exists.
4. **Redaction at source** (`redactSecrets`, the path `trajectory.ts` labels already use) + R2 encryption at rest. Strict tier later: client-side per-user encryption before upload.

### Milestones

- **M1 — Store + sync.** `agents-traces` worker + R2; `agents traces sync` computes/redacts the shard and PUTs it; owner-isolation tests. *Depends on RUSH-3135's `verifyPhoenixToken` seam (PR #3008).*
- **M2 — Console v0.** The approved surface: needs-attention, trajectory waterfall, topic treemap, failure taxonomy. Reads owner-scoped from the worker.
- **M3 — Classify + attribute.** Topic classifier (repo · tools · label heuristic); failure-cause attribution (real / guard / hook) from `tool_calls` error fields.
- **M4 — Evals grow in.** "Score this run / add to a suite" from a flagged trajectory — the `soon` nav items light up (the eval engine from the earlier draft, now demand-pulled).

## Public Interface

```bash
agents traces sync                 # push this device's derived, redacted trajectories (incremental)
agents traces status               # what's synced, last sync per device, owner
agents traces open                 # open the console for your account
```

Worker routes (`agents-traces`, all Phoenix-bearer + owner-checked — no public route):

```
PUT  /<userId>/<device>/index.json            # dashboard shard
PUT  /<userId>/<device>/sessions/<id>.json    # per-session detail
GET  /<userId>/...                            # 401 without bearer; 403 if userId != owner
```

## Validation

| Check | Expected result |
| --- | --- |
| No public trace | `GET /<userId>/index.json` with no bearer → **401**; with another user's bearer → **403** |
| Owner-namespaced write | PUT to a path whose first segment != token userId → **403** (namespace mismatch) |
| Derived-only | A stored blob contains spans/facets/counts and **no** raw prompt/output text (grep for secrets → none) |
| Redaction at source | Secret-shaped values masked before upload (reuses `redactSecrets`) |
| Incremental sync | A second `traces sync` with no new sessions uploads nothing (mtime-stamped) |
| Console owner-scope | The console renders only the signed-in user's sessions across their devices |

## Risks

- **Public-GET regression.** The whole protection story is "no public read." Mitigate: separate worker/bucket (not a prefix), and a test that a bearer-less GET is 401 — in CI.
- **Cross-device merge.** v0 merges per-device shards client-side; correct but as-of-last-sync. Mitigate: show "synced Nm ago" per device; D1 is the drop-in if server-side query is needed.
- **Topic classifier accuracy.** The one new compute. Mitigate: heuristic first (repo · tools · label), visible as a facet the user can correct; LLM label only if the heuristic is weak.
- **RUSH-3135 dependency.** The trace worker reuses `verifyPhoenixToken`. Mitigate: M1 lands after/with PR #3008; coordinate, don't duplicate the auth.
- **Redaction completeness.** A missed secret ships to R2. Mitigate: redact at source with the proven path, and never store raw transcript text at all — structure only.
