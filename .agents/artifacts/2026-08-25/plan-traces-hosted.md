---
kind: plan
template: plan.v1
title: "Phoenix Evals — system design: pre-computed trajectories, task clustering, and projects"
summary: "The CLI already syncs session data to a live Worker + R2 and pings api.prix.dev, but no console reads it, classification is a 5-group heuristic, and there's no query engine. This design (revised after independent blind review) extends api.prix.dev with a rules-first 18-leaf classifier + async LLM fallback, a Supabase rollup index over the existing R2 blobs, and project identity from git remote — computed once at sync, never on dashboard open."
status: approved
surface: api
tracking: PHNX-3351
project: Prix
repository: agents-cli
date: 2026-08-25
links:
  - https://linear.app/getrush/issue/PHNX-3351
  - https://linear.app/getrush/issue/PHNX-3141
  - https://linear.app/getrush/issue/PHNX-3142
  - https://linear.app/getrush/issue/PHNX-3143
---

## Resolution — reviewed 2026-08-27

All six decisions below were reviewed. Three (project identity, storage reuse, pre-compute-at-sync)
were **confirmed as proposed**; three (embedding location, clustering shape, LLM usage) were
**superseded** by an independent blind design — see **§Verification**, after §Clustering below, for
exactly what changed and why. Independently of that, a second pass read the actual shipped code
(`cli/src/lib/traces/{sync,backend,classify}.ts`) before finalizing, and it overturned the doc's
own "nothing is hosted" framing — see **Current architecture** below. `agents traces sync` already
PUTs to a live Cloudflare Worker + R2 (`traces.agents-cli.sh`) and already fire-and-forgets a link
call to `api.prix.dev` (PHNX-3257). The real gap is that no console reads that store, classification
has no embedding, and R2 has no query engine — not that a backend needs to be built from zero. Every
section below (architecture, schema, API surface, tasks) was corrected to extend that live path
rather than propose a parallel one.

RUSH-2667 (this doc's original umbrella) and RUSH-3143 (M4, evals grow-in) were both canceled on the
agents-cli board with the same rationale this doc's own backend decision implies: *Phoenix Evals'
hosted half is Prix product work, not an agents-cli deliverable.* The scope splits at the seam the
doc already draws — **agents-cli** keeps `agents traces sync` and gains the classifier upgrade
(Task 3 below); everything downstream (the Supabase schema, the `api.prix.dev` endpoint work, the
nightly batch, the console) is tracked on **PHNX-3351** in the Prix project. This doc stays
committed here as the reference design for that ticket.

**A blind independent design (Grok, no exposure to this doc — see §Verification) changed the
classifier call.** It converged with everything above except Decisions #1/#3/#4: it argued for
**rules-first + async server-side LLM fallback on low-confidence sessions only**, with no client
embedding model and no vector clustering, against **my own stated risk** that anchored-embedding's
emergent-clustering half ships as scaffolding nobody wires up. That argument won on re-reading it —
§Verification below documents why, and Decisions #1/#3/#4's text stays below as the analysis that
was run, with the final call recorded where each is superseded.

## Focus for review

I want your experienced read on these six decisions specifically — each has a default I argue for, but they're where your judgment matters most:

1. **Where the embedding runs** — I propose embedding each session **locally in the CLI at sync** (data-local, ~10 ms/session on CPU), pushing only the vector + assignment. The alternative is server-side embedding in prix/api. (§Pre-computation, §Options D2.)
2. **Task-taxonomy granularity** — I propose **~18 leaves in 6 groups** (below), anchored, not free clustering. Too coarse loses signal; too fine is noise. Is 18 the right order of magnitude, and are the groups the right cut? (§Taxonomy.)
3. **Anchored vs emergent clustering** — I propose **anchored** (taxonomy centroids) for stable day-1 buckets, with **emergent** unsupervised discovery as a slow batch that *grows* the taxonomy. Agree, or start emergent? (§Clustering.)
4. **Do we ever run an LLM?** — I propose **no LLM per session** (embedding is enough and ~free); a **small LLM labels only the ~18–30 cluster centroids**, as a rare batch. Is that the right cost/quality line? (§Clustering tier 2, §Options D3.)
5. **Project = git-remote, cwd-basename as fallback** — the `repo="muqsit"` bug I hit is exactly the cwd-basename failure. Confirm project identity should be the git remote. (§Projects.)
6. **Pre-compute cadence** — classify/cluster/roll-up **at sync, incrementally** (only changed sessions, mtime-keyed), plus a **nightly re-cluster** of centroids. Never on dashboard open. (§Storage & read paths.)

## Purpose

Muqsit: *"land the feature in a working state so it works for our users… what pre-computation are we doing? are we running an agent to process traces, where does it run, are we using a small model? cluster by task type (10–20), take inspiration from how OpenRouter describes tasks; and do we have a project concept from cwd? we don't want to pre-compute every time the user opens a dashboard."*

This doc answers exactly those. The console already renders real trajectories (verified: 668 real sessions at **~123 sessions/sec heuristic-only, no LLM**). What's missing is (a) the console doesn't read the store that already exists, (b) one auth seam needs a real design, and (c) the "insight" is a first-pass regex with no project rollup. This specifies the real system: a **pre-computation pipeline** on top of the sync path that already ships, a **task taxonomy + clustering**, and a **project** rollup — extending our existing infra (`api.prix.dev` + a new Supabase index), not standing up a parallel backend.

<div class="artifact-callout">
The governing rule this doc enforces end to end: <strong>compute once, at sync</strong>. A dashboard open must never trigger a parse, an embedding, or an LLM call — every panel is a pre-aggregated read.
</div>

## Current architecture

**Correction from the first draft of this doc:** re-reading `cli/src/lib/traces/sync.ts` and
`backend.ts` before proposing anything shows the backend is not hypothetical — it already ships
and already runs on every `agents traces sync`. The real gap is narrower than "nothing is hosted":
it's that the *console* doesn't read the store that exists, classification is heuristic-only, and
there's no relational index for fast cross-session queries.

**Already live, in production, today:**
- `resolveTracesBackend()` (`cli/src/lib/traces/backend.ts:33`) resolves a signed-in Phoenix
  session to a bearer + `userId`, targeting the managed Worker at `traces.agents-cli.sh` (backed by
  its own R2 bucket, provisioned by `agents traces setup` — `cli/src/lib/traces/provision.ts`,
  `config.ts:9-10`).
- Every non-dry-run `agents traces sync` PUTs a redacted `SessionDetail` per session and a
  per-device `TracesIndexShard` (`sync.ts:538`, `:284`) to `${baseUrl}/${userId}/${device}/...`
  — already owner-namespaced, already authenticated, already computing `topics`, `needsAttention`,
  `failurePatterns`, `wastedMsTotal`, and a **14-day rolling `bucketHistory` + `driftSignals`**
  (`classify.ts:104-127`) entirely at sync time. That last piece is exactly this doc's "pre-compute,
  never on open" rule — already shipped for one dimension (drift), not yet for task
  classification/clustering/projects.
- On every real sync, the CLI also fire-and-forgets a `POST /api/v1/traces/link` to
  **`api.prix.dev`** with the Phoenix bearer (`sync.ts:262-267`, PHNX-3257) — "so the console can
  fetch live data." `api.prix.dev` is not a new service either: it's the same Rush Cloud proxy
  already serving secrets sync, cloud-agent dispatch, and cloud session capture
  (`cli/src/lib/secrets/drivers/rush.ts:19`, `cli/src/lib/cloud/rush.ts:29`).
- Classification already has a taxonomy — 5 groups (`code · research · review · content · ops`,
  `classify.ts:1`), heuristic (regex + tool-name match), cached self-healingly in `session_topics`
  by transcript mtime+size (`db.ts:335`, confirmed from the console-shard prior session).

**The actual gap, precisely:**
1. `agents traces open` opens `managedTracesBaseUrl()` "which will route to the console once
   deployed" (`commands/traces.ts:163`) — the console **is not live at that URL yet**; today it only
   renders from a hand-copied `--dry-run --out` fixture.
2. The 5-group heuristic has no embedding, no per-leaf granularity, and no clustering — it can't
   answer "what kind of work is this" at the ~18-leaf resolution Decision #2 below asks for.
3. There is no **project** concept — `IndexedSession.repo` (`sync.ts:454`) is `row.project ??
   basename(cwd)`, which is exactly the fallback that produced the `repo="muqsit"` bug.
4. R2/KV (what `traces.agents-cli.sh` already uses) has no query engine — `GROUP BY project_id`,
   `ORDER BY severity DESC` across a user's full history needs a real index, which is what the new
   Supabase layer below is *for*, not a replacement for the R2 store.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg class="artifact-diagram" viewBox="0 0 960 260" role="img" aria-label="Today: the CLI already syncs redacted session detail and an index shard to a real Cloudflare Worker and R2 bucket, authenticated with the user's Phoenix bearer, and fire-and-forget registers the sync with api.prix.dev. The gap is that no console reads this store yet, and there is no relational index for cross-session queries.">
    <text x="20" y="20" font-family="Inter, sans-serif" font-weight="700" font-size="12" fill="#a3e635">ALREADY LIVE — every real `agents traces sync`</text>
    <rect x="20" y="32" width="190" height="86" rx="9" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
    <text x="115" y="56" text-anchor="middle" font-family="Inter, sans-serif" font-size="10.5" fill="#c8c8c8">CLI: sessions.db</text>
    <text x="115" y="74" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="8.5" fill="#7c9a4e">classify.ts: 5-group regex</text>
    <text x="115" y="90" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="8.5" fill="#7c9a4e">buildIndexShard + bucketHistory</text>
    <text x="115" y="106" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="8" fill="#8a8a90">sync.ts:87</text>
    <line x1="210" y1="75" x2="266" y2="75" stroke="#a3e635" stroke-width="2.2" marker-end="url(#c1)"/>
    <defs><marker id="c1" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#a3e635"/></marker></defs>
    <rect x="266" y="20" width="220" height="110" rx="9" fill="#0f0f12" stroke="#56b6e6" stroke-width="1.6"/>
    <text x="376" y="42" text-anchor="middle" font-family="Inter, sans-serif" font-size="10.5" fill="#56b6e6">traces.agents-cli.sh</text>
    <text x="376" y="58" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="8.5" fill="#c8c8c8">Cloudflare Worker + R2</text>
    <text x="376" y="76" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="8" fill="#8a8a90">PUT /{userId}/{device}/sessions/{id}.json</text>
    <text x="376" y="90" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="8" fill="#8a8a90">PUT /{userId}/{device}/index.json</text>
    <text x="376" y="106" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="8" fill="#7c9a4e">Phoenix-bearer authed, owner-namespaced</text>
    <text x="376" y="120" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="8" fill="#8a8a90">backend.ts:33 · already live</text>
    <line x1="115" y1="118" x2="115" y2="150" stroke="#f4b942" stroke-width="2" stroke-dasharray="3 3" marker-end="url(#c2)"/>
    <defs><marker id="c2" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#f4b942"/></marker></defs>
    <rect x="20" y="150" width="270" height="70" rx="9" fill="#12100a" stroke="#f4b942" stroke-width="1.5"/>
    <text x="155" y="172" text-anchor="middle" font-family="Inter, sans-serif" font-size="10.5" fill="#f4b942">api.prix.dev</text>
    <text x="155" y="188" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="8" fill="#c8c8c8">POST /api/v1/traces/link (fire-and-forget)</text>
    <text x="155" y="202" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="8" fill="#8a8a90">sync.ts:263 · PHNX-3257 · same proxy as secrets/cloud</text>
    <line x1="486" y1="75" x2="546" y2="75" stroke="#8a8a90" stroke-width="2" stroke-dasharray="3 3" marker-end="url(#c3)"/>
    <defs><marker id="c3" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#8a8a90"/></marker></defs>
    <text x="516" y="66" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="7.5" fill="#8a8a90">no reader yet</text>
    <rect x="546" y="20" width="220" height="110" rx="9" fill="#160a0c" stroke="#f0616d" stroke-width="1.5" stroke-dasharray="5 3"/>
    <text x="656" y="42" text-anchor="middle" font-family="Inter, sans-serif" font-size="10.5" fill="#f0616d">console — THE GAP</text>
    <text x="656" y="60" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="8" fill="#c8c8c8">not deployed at traces.agents-cli.sh</text>
    <text x="656" y="76" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="8" fill="#c8c8c8">dev-only: reads a hand-copied</text>
    <text x="656" y="90" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="8" fill="#c8c8c8">`--dry-run --out` fixture</text>
    <text x="656" y="108" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="8" fill="#f0616d">no relational index → no fast</text>
    <text x="656" y="122" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="8" fill="#f0616d">GROUP BY project/severity across R2</text>
    <text x="20" y="240" font-family="Inter, sans-serif" font-size="9.5" fill="#8a8a90">The write path (green + blue) is already correct and stays unchanged below. Everything new in this doc is: local embedding added to the CLI step, and a Supabase index fed from the link call.</text>
  </svg>
  <figcaption><b>Figure 0.</b> The real current state: the sync/store/link path (green → blue → orange) is live in production. The console (red, dashed) is the actual gap — not because nothing is hosted, but because nothing reads what's already hosted, and R2 has no query engine for cross-session rollups.</figcaption>
</figure>

## Proposed Changes

<div class="artifact-behavior">
  <div class="artifact-behavior-panel" data-state="current" data-evidence="capture">
    <strong>Today:</strong> the CLI already syncs real, redacted, owner-namespaced session detail + a rolling drift index to <code>traces.agents-cli.sh</code> (Worker + R2) on every <code>agents traces sync</code>, and fire-and-forgets a link registration to <code>api.prix.dev</code> (<code>sync.ts:262-267</code>). A local dev preview only ever reads a hand-copied <code>--dry-run</code> fixture, because no console is deployed to read the real store yet. Classification is a 5-group regex (<code>classify.ts:1</code>); there is no embedding, no per-leaf clustering, no project rollup, and R2 has no query engine for cross-session aggregates. If we naïvely pointed a console at R2 directly, every panel would still recompute its rollup on open — R2 has no `GROUP BY`.
  </div>
  <div class="artifact-behavior-panel" data-state="proposed" data-evidence="mockup">
    <strong>Proposed:</strong> at sync, each new/changed session is classified (heuristic → embedded → anchored to a task cluster), assigned a project (from git-remote), and its rollup facets POSTed to <code>api.prix.dev</code>'s existing traces-link endpoint (extended, not replaced) — which upserts them into a new Supabase index, <strong>once</strong>. Detail stays exactly where it already lives, in the R2 store — Supabase's <code>detail_key</code> points at the existing <code>{userId}/{device}/sessions/{id}.json</code> key rather than duplicating storage. The user opens the deployed prix console and every panel (treemap by task cluster, project rollups, needs-attention, failure taxonomy) is a <strong>cheap indexed SELECT over pre-computed rows</strong> — no recompute, no model call at open. Drill-down streams the untouched R2 blob.
  </div>
</div>

## Pre-computation — the pipeline, and what runs where

The governing rule (your explicit ask): **compute once, at ingest; the dashboard only reads.** A dashboard open must never trigger a parse, an embedding, or an LLM call. Everything below is a write-time (sync) or slow-batch cost, cached in Supabase, keyed on transcript `mtime+size` so a re-sync recomputes **only** changed sessions.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg class="artifact-diagram" viewBox="0 0 960 470" role="img" aria-label="A three-tier pre-computation pipeline: the CLI at sync computes heuristics and a local embedding on the user's machine and pushes derived facets to prix/api; prix/api writes them to Supabase and blob; a nightly batch re-clusters centroids and optionally labels new clusters with a small LLM; the dashboard only reads pre-computed rows.">
    <text x="20" y="22" font-family="Inter, sans-serif" font-weight="700" font-size="12.5" fill="#a3e635">TIER 0-1 · at SYNC, on the USER'S machine (CLI, data-local)</text>
    <rect x="20" y="34" width="250" height="150" rx="9" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
    <text x="34" y="56" font-family="'JetBrains Mono', monospace" font-size="9.5" fill="#c8c8c8">1. select changed sessions (mtime+size)</text>
    <text x="34" y="76" font-family="'JetBrains Mono', monospace" font-size="9.5" fill="#c8c8c8">2. buildTrajectory + redact  (~7ms)</text>
    <text x="34" y="96" font-family="'JetBrains Mono', monospace" font-size="9.5" fill="#c8c8c8">3. T0 heuristic topic/cause (~1ms)</text>
    <text x="34" y="116" font-family="'JetBrains Mono', monospace" font-size="9.5" fill="#f4b942">4. T1 embed summary → 384-d vec</text>
    <text x="46" y="132" font-family="'JetBrains Mono', monospace" font-size="8.5" fill="#8a8a90">all-MiniLM-L6-v2 · 46MB · &lt;10ms CPU</text>
    <text x="34" y="152" font-family="'JetBrains Mono', monospace" font-size="9.5" fill="#f4b942">5. assign nearest task-cluster (cosine)</text>
    <text x="34" y="172" font-family="'JetBrains Mono', monospace" font-size="9.5" fill="#7c9a4e">6. project = git-remote(cwd)</text>
    <text x="34" y="200" font-family="Inter, sans-serif" font-size="9.5" fill="#8a8a90" font-style="italic">Raw transcript never leaves the box — only derived facets + the vector.</text>
    <line x1="270" y1="110" x2="330" y2="110" stroke="#f4b942" stroke-width="2.5" marker-end="url(#a1)"/>
    <defs><marker id="a1" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#f4b942"/></marker></defs>
    <text x="272" y="102" font-family="'JetBrains Mono', monospace" font-size="8" fill="#c9a24e">POST facets</text>
    <text x="345" y="22" font-family="Inter, sans-serif" font-weight="700" font-size="12.5" fill="#f4b942">api.prix.dev (extends /traces/link)</text>
    <rect x="345" y="34" width="215" height="96" rx="9" fill="#12100a" stroke="#f59e0b" stroke-width="1.6"/>
    <text x="452" y="56" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="9" fill="#c8c8c8">auth: Phoenix token → user_id</text>
    <text x="452" y="74" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="9" fill="#c8c8c8">upsert session_traces row</text>
    <text x="452" y="92" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="9" fill="#c8c8c8">upsert projects row</text>
    <text x="452" y="110" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="9" fill="#c8c8c8">detail_key → EXISTING R2 object (no new PUT)</text>
    <rect x="345" y="146" width="215" height="40" rx="8" fill="#0f0f12" stroke="#56b6e6" stroke-width="1.4"/>
    <text x="452" y="164" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="9" fill="#56b6e6">Supabase: session_traces · projects</text>
    <text x="452" y="178" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="8" fill="#8a8a90">+ cluster_centroids · pgvector</text>
    <line x1="452" y1="130" x2="452" y2="146" stroke="#3a3a3f" stroke-width="1.2"/>
    <text x="600" y="22" font-family="Inter, sans-serif" font-weight="700" font-size="12.5" fill="#b18aff">TIER 2 · NIGHTLY BATCH (server, rare)</text>
    <rect x="600" y="34" width="340" height="96" rx="9" fill="#140f1a" stroke="#b18aff" stroke-width="1.5"/>
    <text x="614" y="56" font-family="'JetBrains Mono', monospace" font-size="9" fill="#c8c8c8">re-cluster: k-means/HDBSCAN over new vectors</text>
    <text x="614" y="74" font-family="'JetBrains Mono', monospace" font-size="9" fill="#c8c8c8">detect emergent clusters not in taxonomy</text>
    <text x="614" y="92" font-family="'JetBrains Mono', monospace" font-size="9" fill="#f4b942">label ONLY new centroids w/ small LLM (Haiku)</text>
    <text x="614" y="110" font-family="'JetBrains Mono', monospace" font-size="8.5" fill="#8a8a90">~20–30 centroids/run, not per-session → cents, not $$</text>
    <line x1="600" y1="120" x2="560" y2="166" stroke="#b18aff" stroke-width="1.4" stroke-dasharray="4 3"/>
    <text x="345" y="230" font-family="Inter, sans-serif" font-weight="700" font-size="12.5" fill="#56b6e6">DASHBOARD — reads only, no compute</text>
    <rect x="345" y="242" width="595" height="66" rx="9" fill="#0f0f12" stroke="#56b6e6" stroke-width="1.4"/>
    <text x="360" y="264" font-family="'JetBrains Mono', monospace" font-size="9" fill="#c8c8c8">GET /traces      → SELECT ... GROUP BY task_cluster / project / severity  (indexed)</text>
    <text x="360" y="282" font-family="'JetBrains Mono', monospace" font-size="9" fill="#c8c8c8">GET /traces/:id  → stream detail from blob(detail_key)</text>
    <text x="360" y="300" font-family="Inter, sans-serif" font-size="9" fill="#7c9a4e" font-style="italic">Every panel is a pre-aggregated read. Opening the dashboard triggers zero model calls, zero parses.</text>
    <line x1="452" y1="186" x2="452" y2="242" stroke="#56b6e6" stroke-width="1.4"/>
    <text x="20" y="360" font-family="Inter, sans-serif" font-size="10" fill="#8a8a90">Cost ladder (measured / cited): T0 heuristic ~1 ms · T1 embed &lt;10 ms CPU (all-MiniLM-L6-v2) · T2 LLM only on ~30 centroids/night.</text>
    <text x="20" y="378" font-family="Inter, sans-serif" font-size="10" fill="#8a8a90">675-session backfill ≈ 6 s heuristic today; +embedding ≈ &lt;7 s more on CPU. Incremental after that: only the delta.</text>
  </svg>
  <figcaption><b>Figure 1.</b> Three tiers, three homes. <b>T0/T1 run in the CLI at sync</b> (heuristic + a 46 MB local embedding, data-local — only derived facets leave the box). <b>prix/api</b> persists to Supabase + blob. <b>T2 is a nightly batch</b> that re-clusters and labels only the ~30 centroids with a small LLM — never per session, never on open. The dashboard is pure pre-aggregated reads.<br/><em>Superseded: the T1 local-embedding tier and T2 nightly re-cluster batch shown here did not survive independent review — jump to <strong>§Verification</strong> (after §Clustering below) for the synthesized design that actually ships in v1 (rules-first classifier + async server-side LLM fallback, no client model, no clustering batch). This figure is kept as the record of the analysis, not the final proposal.</em></figcaption>
</figure>

**Why embedding in the CLI, not the server (Decision #1).** The raw transcript is the sensitive asset and it already lives on the user's machine; embedding there means only a 384-float vector + a label leave the box, never the text. It's also free compute we don't run: `all-MiniLM-L6-v2` is 46 MB and embeds in **&lt;10 ms on CPU** ([sources below]), so the whole 675-session fleet embeds in a few seconds at sync with no server GPU. The server only ever re-clusters the *vectors*.

## Task taxonomy — ~18 leaves, 6 groups (Decision #2)

Coarse enough to be stable and readable, fine enough to be useful — your "10–20, not too fine, not too coarse." Modeled on how **OpenRouter categorizes real usage by task** (coding / agentic / reasoning / debugging / refactoring — a use-case lens, not a model lens) [cited], adapted to coding *sessions*. Each session gets **one primary leaf + confidence**; a session can carry secondary leaves for mixed work.

| Group | Leaves (the ~18 clusters) |
|---|---|
| **Build** | Feature implementation · Bug fix · Refactor · Prototype / scaffold |
| **Understand** | Research / exploration · Debugging · Answer a question |
| **Review** | Code review · Address review feedback |
| **Quality** | Test authoring · Performance · Security |
| **Ops** | Deploy / release · CI / build fix · Dependency upgrade · Config / infra |
| **Data & Docs** | Migration / data · Documentation |

Two levels only: **group** powers the treemap (5–6 tiles, the mockup's shape); **leaf** powers filtering and per-cluster failure analysis. Emergent clusters (below) can *add* leaves over time without a schema change — a leaf is a row in `cluster_centroids`, not an enum.

**Migration from the shipped 5-group heuristic.** `classify.ts`'s `TraceTopicGroup` (`code | research
| review | content | ops`, `classify.ts:1`) already has real history in every device's 14-day
`bucketHistory` and `driftSignals` (`classify.ts:104-127`) — replacing it outright would reset every
user's drift baseline to zero. The 18-leaf taxonomy is additive: `code → Build` (split further by
leaf), `research → Understand`, `review → Review`, `ops → Ops`, `content` folds into `Data & Docs`
(most `content` hits were docs, not marketing copy, from the tool-mix evidence `classify.ts` already
keys on). `bucketHistory` keeps keying on the **group**, not the leaf, so the rolling drift signal
is unaffected by day one; only the new `task_leaf` column is genuinely new state.

## Clustering — anchored embedding, emergent discovery (Decisions #3, #4)

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg class="artifact-diagram" viewBox="0 0 960 300" role="img" aria-label="Each session's summary is embedded and assigned to its nearest taxonomy anchor by cosine similarity; a nightly batch runs unsupervised clustering to surface sessions that sit far from every anchor, which a small LLM labels into new leaves.">
    <rect x="20" y="40" width="200" height="70" rx="8" fill="#0f0f12" stroke="#5b5566" stroke-width="1.3"/>
    <text x="120" y="62" text-anchor="middle" font-family="Inter, sans-serif" font-size="10.5" fill="#c8c8c8">session summary</text>
    <text x="120" y="80" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="8" fill="#8a8a90">repo + tool-mix + label</text>
    <text x="120" y="95" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="8" fill="#8a8a90">+ first user message</text>
    <line x1="220" y1="75" x2="270" y2="75" stroke="#a3e635" stroke-width="2" marker-end="url(#a2)"/>
    <defs><marker id="a2" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#a3e635"/></marker></defs>
    <rect x="270" y="40" width="150" height="70" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.4"/>
    <text x="345" y="70" text-anchor="middle" font-family="Inter, sans-serif" font-size="10.5" fill="#a3e635">embed → 384-d</text>
    <text x="345" y="88" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="8" fill="#7c9a4e">MiniLM, local</text>
    <line x1="420" y1="75" x2="470" y2="75" stroke="#f4b942" stroke-width="2" marker-end="url(#a3)"/>
    <defs><marker id="a3" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#f4b942"/></marker></defs>
    <rect x="470" y="30" width="210" height="92" rx="8" fill="#12100a" stroke="#f4b942" stroke-width="1.5"/>
    <text x="575" y="52" text-anchor="middle" font-family="Inter, sans-serif" font-size="10.5" fill="#f4b942">nearest anchor (cosine)</text>
    <text x="575" y="72" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="8.5" fill="#c8c8c8">18 taxonomy centroids</text>
    <text x="575" y="90" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="8.5" fill="#c8c8c8">→ leaf + confidence</text>
    <text x="575" y="108" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="8" fill="#7c9a4e">if sim &lt; τ → "unclassified" bucket</text>
    <line x1="680" y1="75" x2="730" y2="75" stroke="#b18aff" stroke-width="2" marker-end="url(#a4)"/>
    <defs><marker id="a4" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#b18aff"/></marker></defs>
    <rect x="730" y="40" width="210" height="70" rx="8" fill="#140f1a" stroke="#b18aff" stroke-width="1.4"/>
    <text x="835" y="62" text-anchor="middle" font-family="Inter, sans-serif" font-size="10.5" fill="#b18aff">session_traces.task_leaf</text>
    <text x="835" y="80" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="8" fill="#9a7fd0">stored · indexed · read by dash</text>
    <text x="835" y="96" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="8" fill="#8a8a90">vector kept for re-cluster</text>
    <rect x="270" y="160" width="410" height="94" rx="9" fill="#160a0c" stroke="#f0616d" stroke-width="1.3" stroke-dasharray="5 3"/>
    <text x="475" y="182" text-anchor="middle" font-family="Inter, sans-serif" font-weight="700" font-size="11" fill="#f0616d">NIGHTLY — emergent discovery</text>
    <text x="475" y="202" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="8.5" fill="#c8c8c8">HDBSCAN over the "unclassified" + low-confidence vectors</text>
    <text x="475" y="220" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="8.5" fill="#c8c8c8">a dense new cluster → small LLM names it → new leaf row</text>
    <text x="475" y="240" text-anchor="middle" font-family="Inter, sans-serif" font-size="8.5" fill="#7c9a4e" font-style="italic">Taxonomy grows from real data; LLM touches ~1 label per new cluster, not sessions.</text>
    <line x1="575" y1="122" x2="475" y2="160" stroke="#f0616d" stroke-width="1.2" stroke-dasharray="4 3"/>
  </svg>
  <figcaption><b>Figure 2.</b> Anchored assignment gives stable, human-named buckets from day one (no cold-start blob problem); a nightly unsupervised pass over the *low-confidence* tail surfaces genuinely new task shapes, and the only LLM call names each new cluster once. Sessions are never sent to an LLM.<br/><em>Superseded, same as Figure 1: the embedding-anchored assignment and nightly HDBSCAN batch shown here did not survive independent review — jump to <strong>§Verification</strong> immediately below for the synthesized design that ships in v1 (fixed 18-leaf taxonomy + async LLM fallback only on low-confidence sessions, no vectors, no clustering batch). Kept as the record of the analysis, not the final proposal.</em></figcaption>
</figure>

- **Why anchored, not pure unsupervised (Decision #3):** unsupervised-only gives you numbered blobs a user can't read on day one and that renumber every run. Anchoring to the ~18 named leaves gives stable, legible buckets immediately; unsupervised is reserved for *growing* the taxonomy from the low-confidence tail.
- **Why no per-session LLM (Decision #4):** at 675 sessions and growing, an LLM label per session is real money and latency for a signal an embedding gives for free (`all-MiniLM` clustering is a solved, sub-10 ms task [cited]). The LLM earns its keep only on the **~20–30 centroids** — naming an emergent cluster — which is cents per night. If quality demands it later, `embeddinggemma` (622 MB, higher MTEB-Code) is the drop-in upgrade [cited].
- **The summary we embed** is derived, not raw: `repo · tool-mix · label · first user message (redacted, clipped)`. It never includes transcript body — same redaction path the trajectory already uses.

## Verification — an independent blind design overturned Decisions #1, #3, #4

Per the swarm-plan discipline: before finalizing, an independent agent (Grok, different provider,
**no exposure to this doc or its decisions**) was given the same first-principles brief — pre-compute
vs on-open, where a classifier model runs, an OpenRouter-inspired task taxonomy, project identity
from cwd, a fast read path — and asked to design its own answer from scratch.

**Where it converged with everything above** (high confidence — two independent designs landed on
the same thing): pre-compute at sync/ingest, never on open; reuse the existing R2 store for detail
instead of a new blob store; a new relational layer for rollups; project identity = git remote, not
cwd basename; Phoenix bearer reused for console auth; `agents traces open` should open the real
console, not the Worker URL.

**Where it diverged — the real decision, per file `plan-traces-hosted.md`'s own instruction to
evaluate divergence rather than default to the first draft:**

| | This doc's original Decisions #1/#3/#4 | Grok's independent design |
|---|---|---|
| Classifier tier 2 | Local embedding (all-MiniLM, every session) → cosine-anchored to 18 centroids | Rules-first (extended heuristic); **async server-side LLM only on low-confidence sessions** (`confidence < 0.8`), structured output against a fixed enum |
| Clustering | Anchored + **nightly unsupervised (HDBSCAN) emergent discovery** that grows the taxonomy | **None in v1** — fixed taxonomy + an `other` relief valve; unsupervised demoted to "a later diagnostic, not the product" |
| New infra | Local embedding model shipped in the CLI (46MB) + `pgvector`/ANN index in Supabase | No client model, no vectors, no `pgvector` |
| Data-quality loop | Emergent clustering re-labels the taxonomy over time | Explicit `user_relabels` table + `POST /relabel` — a human correction loop, gold for measurement, not a fine-tune |
| Rollup reads | `SELECT ... GROUP BY task_group` over an indexed column at read time | A materialized `rollups` table maintained incrementally on ingest — cheaper than a live `GROUP BY` even indexed, at scale |
| API shape | One `/api/v1/traces/*` namespace for both the CLI write and the console read | Split: `/v1/traces/*` (CLI write, existing shape) vs `/v1/evals/*` (console read) — cleaner separation of concerns |

**Final call: adopt Grok's classifier/clustering design, keep this doc's project-identity and
storage-reuse decisions (both were independently confirmed).** Three reasons the rules+async-LLM
path wins over my own draft:

1. **It answers a risk I flagged against myself.** This doc's own §Risks warned "we build anchoring
   and never wire emergent — then the taxonomy ossifies." Rules-first + LLM-on-low-confidence has no
   emergent-clustering half to forget to wire; the fixed taxonomy's `other` bucket is the same relief
   valve without a nightly HDBSCAN job that needs a second team to own.
2. **It ships with fewer new moving parts.** No 46MB model to lazy-download into the CLI (removing
   that entire §Risks entry), no `pgvector`/ANN index to run at fleet scale (removing that entry
   too). An async LLM call bounded to the *actually-ambiguous* tail is cents/day at current volume —
   cheaper in practice than "embed every session, always," and it runs server-side where it's easy to
   rate-limit and cost-cap centrally, rather than shipping model weight to every user's machine.
3. **The relabel loop is a real gap this doc didn't have.** Without it, a wrong classification is
   permanent until the whole taxonomy is revisited; with it, a user fixes their own data and that
   correction feeds future measurement (explicitly *not* a fine-tune target in v1 — scope discipline
   Grok stated outright and this doc adopts).

**What carries over unchanged from the original decisions:** the governing rule (pre-compute at
sync, dashboard never computes), the ~18-leaf taxonomy content itself (Grok's 16-tag table is
close enough in spirit that either enum works — the taxonomy's *shape* was never the disputed part),
project identity = git remote, and reusing the existing R2 store for detail. The Storage schema,
Public Interface, and Tasks sections below are updated to the synthesized design; the SQL/figures
above are kept as the record of the analysis, not deleted, per this doc's own "committed reference"
framing.

## Projects — cwd → git-remote (Decision #5)

A **project** groups a user's sessions by the codebase they ran in. Identity is the **git remote URL** of the session's `cwd` (canonical across machines and checkouts); the cwd **basename is only a fallback** — and it's exactly the fallback that produced the `repo="muqsit"` bug (a session whose cwd was a home dir). Derivation, at sync:

```
project_key = normalize(git-remote-of(cwd))        // e.g. github.com/phnx-labs/agents-cli
            ?? basename(cwd)                        // fallback, flagged low-confidence
```

Projects unlock the rollups the flat list can't: *this repo's* error-rate trend, top task clusters, and which agents/models struggle where — all pre-aggregated. `session_traces.project_id` + a `projects` table (below). Starting from `cwd` is correct because it's already in `sessions.db`; the only new work is resolving it to a remote.

## Storage schema & read paths (Decision #6, synthesized post-verification)

```sql
-- Supabase (api.prix.dev). Metadata queryable; detail stays in the R2 store that
-- already exists — this table indexes it, it does not duplicate it. No pgvector,
-- no embedding column — dropped per §Verification (rules + async LLM, not embeddings).
CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  project_key text NOT NULL,          -- normalized git remote (or basename fallback)
  name text, repo_url text,
  first_seen timestamptz, session_count int,
  UNIQUE (user_id, project_key)
);

CREATE TABLE session_traces (
  user_id uuid NOT NULL REFERENCES auth.users(id),
  session_id text NOT NULL, device text NOT NULL,
  project_id uuid REFERENCES projects(id),
  agent text, model text,
  taxonomy_version int NOT NULL,
  task_group text, task_leaf text, task_confidence real,     -- PRE-COMPUTED
  classified_by text NOT NULL,          -- 'rules' | 'llm' | 'user' (relabel)
  evidence jsonb,                       -- why: matched rule / LLM rationale — debuggable, not opaque
  cause_real int, cause_guard int, cause_hook int,            -- PRE-AGGREGATED failure split
  severity int, flags text[],
  span_ms bigint, error_count int, tool_count int, tokens bigint, cost_usd real, outcome text,
  synced_at timestamptz DEFAULT now(),
  -- Existing R2 key, unchanged: "{userId}/{device}/sessions/{session_id}.json"
  -- (sync.ts:653) — proxied through traces.agents-cli.sh, never re-uploaded here.
  detail_key text NOT NULL,
  PRIMARY KEY (user_id, session_id)
);
ALTER TABLE session_traces ENABLE ROW LEVEL SECURITY;
CREATE POLICY own ON session_traces USING (user_id = auth.uid());
CREATE INDEX ON session_traces (user_id, task_group);
CREATE INDEX ON session_traces (user_id, project_id);
CREATE INDEX ON session_traces (user_id, severity DESC);

-- The relabel loop (Grok's addition, not in the original draft): a user's correction
-- is gold for measurement — it is NOT a fine-tune signal in v1.
CREATE TABLE user_relabels (
  user_id uuid NOT NULL, session_id text NOT NULL,
  task_group text NOT NULL, task_leaf text NOT NULL,
  relabeled_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, session_id)
);

-- Maintained incrementally ON INGEST (upsert +1 to the right counters), not
-- recomputed by a live GROUP BY per page load — the dashboard home screen is one row read.
CREATE TABLE rollups (
  user_id uuid NOT NULL, window text NOT NULL,   -- '7d' | '30d' | 'all'
  computed_at timestamptz DEFAULT now(),
  sessions int, need_attention int, tool_error_rate real,
  median_ms bigint, p90_ms bigint,
  by_task jsonb, by_project jsonb, by_cause jsonb, top_failures jsonb,
  PRIMARY KEY (user_id, window)
);
```

**Every dashboard panel is a pre-aggregated read — no recompute:**

| Panel | Query |
|---|---|
| Stat strip / task bar / needs-attention / failure pie | `SELECT * FROM rollups WHERE user_id = auth.uid() AND window = ?` — one row |
| Project rollup | `by_project` column of the same row, or `... GROUP BY project_id` on the indexed column for a live drill-in |
| Session list (filtered, paged) | `SELECT ... FROM session_traces WHERE user_id = auth.uid() AND task_group = ? ORDER BY ... LIMIT ? OFFSET cursor` |
| Drill-down | proxies the existing R2 object at `detail_key`, unchanged |
| Relabel | `UPSERT user_relabels`, then update the affected `rollups` row's counters (not a full recompute) |

The classifier/rollup **never runs on open** — `rollups` is updated at ingest time, exactly like
`bucketHistory`/`driftSignals` already are today (`classify.ts:104`).

## Options considered & discarded

| Decision | Options | Chosen · why |
|---|---|---|
| When to compute | (a) on dashboard open (b) at sync, cached | **b** — your explicit ask; open must be O(read). (a) recomputes for every viewer, every load. Already the shipped pattern for `bucketHistory`/`driftSignals` (`classify.ts:104`) — this extends it, doesn't introduce it. |
| Classifier tier 2 — **superseded, see §Verification** | (a) client-side embedding + anchored clustering (original pick) (b) rules-first + async server LLM on low-confidence only | **b** — an independent blind design (Grok) argued this directly against a risk I flagged against my own draft (emergent clustering shipping unwired); no client model weight, no `pgvector`, cost bounded to the genuinely ambiguous tail. |
| Clustering — **superseded** | (a) anchored taxonomy + nightly unsupervised emergent discovery (original pick) (b) fixed taxonomy + `other` relief valve, no clustering in v1 | **b** — removes an entire subsystem (HDBSCAN batch, centroid table, re-cluster ANN index) that this doc's own §Risks worried would never get properly staffed. Revisit only if the `other` bucket grows past a real threshold (see §Risks). |
| Project identity | (a) cwd basename (b) git remote | **b** — canonical; (a) is the `repo="muqsit"` bug (`sync.ts:454`: `row.project ?? basename(cwd)`). Basename is a flagged fallback only. Confirmed independently by Grok's design. |
| Backend — detail storage | (a) new blob store (b) reuse the existing R2 store | **b** — `traces.agents-cli.sh` already holds every session's redacted detail, already owner-namespaced, already live (`backend.ts:33`). A new blob store would duplicate storage and create a second source of truth for the same bytes. Confirmed independently by Grok's design. |
| Rollup reads | (a) `GROUP BY` an indexed column at read time (b) a materialized `rollups` row maintained on ingest | **b** — Grok's addition: cheaper than a live aggregate even indexed, at real scale, and the home screen becomes one row read instead of four aggregate queries. |
| Backend — metadata index | (a) query R2/KV directly (b) add a Supabase index fed by `api.prix.dev` | **b** — R2 has no `GROUP BY`; a dashboard would recompute every rollup on open, which the governing rule forbids. `api.prix.dev` already receives a link call on every sync (`sync.ts:263`) — extending that call to carry facets, instead of inventing a second endpoint, is the smaller diff. |
| Embedding model — **deferred, not chosen for v1** | all-MiniLM-L6-v2 · gte-small · embeddinggemma · nomic | Not needed in v1 per §Verification. Kept here as the v2 shortlist if the `other` bucket ever grows past its threshold (see Risks): **all-MiniLM-L6-v2** (46 MB, &lt;10 ms CPU) to start; **embeddinggemma** (622 MB, higher MTEB-Code) as the quality drop-in. |

## Public Interface

```
# CLI (unchanged sync surface; sync.ts gains a richer rules classifier, no local model)
agents auth login
agents traces sync                 # unchanged PUTs to traces.agents-cli.sh, PLUS: extended rules
                                    # classifier (18-leaf, still regex/tool-mix, no embedding) folded
                                    # into the existing api.prix.dev link call (sync.ts:263)
agents traces sync --dry-run --out # local export (dev/verify) — kept, unchanged

# api.prix.dev — split per §Verification: CLI write stays on /v1/traces/*, console read
# moves to its own /v1/evals/* namespace (cleaner separation than one shared prefix).
PUT  /v1/traces/{userId}/{device}/sessions/{id}   # EXISTING shape, extended (PHNX-3257): body adds
                                                   # task_group/task_leaf/task_confidence/classified_by/
                                                   # evidence/project_key/severity/cause counts.
                                                   # Server upserts session_traces + projects + rollups,
                                                   # queues an async LLM classify job when confidence < 0.8.
GET  /v1/evals/summary?window=7d|30d|all          # NEW — one `rollups` row: stat strip, task bar,
                                                   # needs-attention, failure-cause pie
GET  /v1/evals/sessions?task=&project=&cursor=    # NEW — cursor page over session_traces
GET  /v1/evals/sessions/{id}                      # NEW — proxies the existing R2 object; no new blob write
POST /v1/evals/sessions/{id}/relabel {task_leaf}  # NEW — user correction; upserts user_relabels + rollups
# async (queued from the PUT above, not a cron): LLM classifies only confidence<0.8 sessions
```

## Tasks
- [ ] **1** Supabase (api.prix.dev's existing project): `projects`, `session_traces`, `user_relabels`, `rollups` migration (RLS + indexes; no `pgvector`)
- [ ] **2** api.prix.dev: extend the existing `PUT /v1/traces/.../sessions/{id}` handler to upsert `session_traces`/`projects`/`rollups`; add `GET /v1/evals/summary`, `GET /v1/evals/sessions{,/{id}}`, `POST /v1/evals/sessions/{id}/relabel`
- [ ] **3** CLI (`cli/src/lib/traces/sync.ts`): extend `classifyTopic` from 5 groups to the 18-leaf taxonomy (still rules-only — tool-mix + label + branch-name signals, no model); project = git-remote(cwd) resolved alongside the existing `rowToMeta`; widen the sync PUT body; keep `--dry-run` byte-identical
- [ ] **4** api.prix.dev: async low-confidence classifier — queue on ingest when `confidence < 0.8`, structured LLM output against the fixed 18-leaf enum, cost-capped and metered (sessions/day, $/day)
- [ ] **5** Console: point at the deployed `GET /v1/evals/*` instead of the `--dry-run` fixture; resolve (not assume) how the console's own session authenticates to api.prix.dev — this repo cannot see the console/prix/web source, so `mintPhoenixBearer`'s exact shape is unverified from here (see Risks)
- [ ] **6** Data quality: git-remote project derivation, model resolution, filter sub-second trivial sessions, surface parse-error rate
- [ ] **7** Taxonomy v1 freeze: document the 18-leaf enum as a versioned spec (`taxonomy_version`); changing a key is a version bump + reclassify job, never a silent rename
- [ ] **8** Deploy: the console at `traces.agents-cli.sh` (`commands/traces.ts:163` already points there); VERIFY the live seam (below) — everything else in this list is additive to already-deployed infra, so this is the only new deployment

## Validation

| Seam (UNVERIFIED today) | Exercise |
|---|---|
| CLI → api.prix.dev `/v1/traces/...` → Supabase | `agents traces sync` → rows land in `session_traces` for my `user_id`; `task_leaf`/`classified_by` populated; existing R2 PUTs still succeed unchanged |
| Pre-compute, not on-open | dashboard open issues only reads from `rollups` (no parse/model in the trace); p95 open &lt; 300 ms on 675 rows |
| Classifier quality | spot-check: N sessions' rules-assigned leaf matches a human read; a deliberately ambiguous session gets queued for LLM classification and resolves within the cost/latency budget |
| Relabel loop | `POST /relabel` updates `task_leaf` and the affected `rollups` row without a full recompute |
| Projects | my sessions group by real repo, not `muqsit`; project rollup error-rate matches the flat numbers |
| Drift continuity | `bucketHistory`/`driftSignals` for existing users show no discontinuity the day the group mapping ships |
| Identity | CLI Phoenix token and the console's own session resolve to the same `user_id` when both call api.prix.dev — needs confirming against the actual console auth code, not assumed |
| Owner isolation | a second user sees zero of my rows (RLS) |

Done = a user signs into the deployed console at `traces.agents-cli.sh` and sees their own real
sessions, **classified by task, grouped by project, pre-computed** — every panel a cheap read against
infra that was already mostly live before this doc, not a new backend stood up from scratch.

## Risks

- **This design cannot see the console/prix/web source.** Every claim above about the CLI→Worker→R2→api.prix.dev path is grounded in `cli/src/lib/traces/*.ts` in this repo. `mintPhoenixBearer` and the console's own auth flow live in a repo not checked out on this machine (no local `prix`/`prix-api`/`prix-web` checkout found under `~/src/github.com/{phnx-labs,muqsitnawaz}`) — task 5's exact shape needs a pass grounded in that repo before it is scheduled, not assumed from this doc alone.
- **The async LLM tail needs a real cost cap.** Bounded to low-confidence sessions only, but "low-confidence" is itself a threshold that needs tuning against real data — set `confidence < 0.8` as the starting point (task 4), measure the fraction of sessions it actually queues in the first week, and adjust before it becomes an uncapped per-session cost.
- **The `other` bucket is the taxonomy's pressure valve — watch it, don't ignore it.** If `other` grows past roughly 10-15% of sessions, the fixed 18-leaf taxonomy is missing real categories; that is the trigger to revisit embedding + clustering (the deferred v2 path, §Verification), not a silent permanent bucket.
- **Identity assumption.** Rests on CLI Phoenix == console Supabase user at api.prix.dev. Both already resolve through the same Phoenix ID service the CLI uses (`cli/src/lib/identity/client.ts`); if the console is on a genuinely separate session model, task 1 adds a real mapping table (still not a stub).
- **Trivial-session skew.** Median dragged to sub-second by probe sessions (measured). Filtering is a product call — exclude from stats, or show a "trivial" facet.
- **Taxonomy version drift.** A `taxonomy_version` bump without a reclassify job leaves old rows labeled against a stale enum — task 7 exists specifically so this is a versioned migration, not a silent rename.

## References

- OpenRouter — task/use-case usage categories (coding · agentic · reasoning · debugging · refactoring): [rankings](https://openrouter.ai/rankings), [programming collection](https://openrouter.ai/collections/programming).
- Embedding-model sizes/latency, kept for the deferred v2 path (all-MiniLM-L6-v2 46 MB, &lt;10 ms CPU, 384-d; embeddinggemma 622 MB higher MTEB-Code; gte-small clustering acc.): [MTEB embedding roundup](https://www.morphllm.com/ollama-embedding-models), [best embeddings 2026](https://www.premai.io/blog/best-embedding-models-for-rag-2026-ranked-by-mteb-score-cost-and-self-hosting/).
- MTEB benchmark — 7 task categories incl. **clustering**: [MTEB paper](https://arxiv.org/pdf/2210.07316).
- Prior in this session: heuristic classifier `classify.ts`, `buildSessionDetail` (#3041, merged), `session_topics` self-healing cache pattern (`db.ts:335`), backend seam `backend.ts` (Phoenix token → managed worker), sync ingest `sync.ts` (existing R2 + `api.prix.dev` link call).
- Independent blind design (§Verification): Grok, dispatched via `agents run grok --mode plan`, given the same first-principles brief with no exposure to this doc.
