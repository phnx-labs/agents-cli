---
kind: report
title: Linear triage delta — 364 open, 14 closed this pass
summary: The 2026-08-15 backlog triage classified 107 AGI tickets and closed none. Ten days later the board is ~352 open (214 AGI then, ~203 now). This pass closed 14 with proof and names the next keep/cancel wave.
header: Phoenix Labs / agents-cli
footer: Internal triage report
status: complete
date: "2026-08-25"
facts:
  - "Prior report: 107 open in Agents CLI"
  - "Board at start of this pass: 364 open"
  - "Board after this pass: ~352 open"
  - "This pass closed 14 (2 Done, 12 Canceled)"
links:
  - url: https://github.com/phnx-labs/agents-cli/blob/main/.agents/artifacts/2026-08-15/backlog-triage.md
    label: Aug 15 triage
  - url: https://linear.app/getrush/issue/RUSH-3116
    label: RUSH-3116
  - url: https://linear.app/getrush/issue/RUSH-3194
    label: RUSH-3194
  - url: https://github.com/phnx-labs/agi-cli/pull/2996
    label: PR #2996
---

## Summary

The previous triage artifact — `.agents/artifacts/2026-08-15/backlog-triage.md` — bucketed **107** open Agents CLI tickets into AUTO / DECISION / SPEC / STALE and **did not close any**. It was a plan.

Today the Linear team has **~352** open issues (was 364 at the start of this session). The old "Agents CLI" project is now **AGI**. Cycle 26 started today and already holds ~287 issues. ~60 remain in Backlog.

This pass closed 14 with proof, against the prior STALE list and tickets whose PRs already merged.

## Findings

<div class="artifact-grid artifact-grid-3">
  <article class="artifact-stat">
    <div class="artifact-stat-value">~352</div>
    <div class="artifact-stat-label">open now (364 at start)</div>
  </article>
  <article class="artifact-stat">
    <div class="artifact-stat-value">69 / 107</div>
    <div class="artifact-stat-label">Aug 15 tickets still open</div>
  </article>
  <article class="artifact-stat">
    <div class="artifact-stat-value">14</div>
    <div class="artifact-stat-label">closed this pass</div>
  </article>
</div>

### Board shape (after this pass)

| Slice | Count | Note |
| --- | --- | --- |
| All open | ~352 | Team-wide, every project |
| AGI (agents-cli) | ~203 | Was 107 on Aug 15 |
| No project | 87 | Prix/Rush/infra mixed in |
| Prix / SVAtlas / Rush | 28 / 25 / 11 | Out of AGI scope |
| Cycle 26 | 287 | Current week; too many to be a cycle |
| No cycle | 69 | Includes 62 Backlog |
| Todo / Doing / In Review | 243 / 33 / 15 | Doing is often a lie |
| Backlog | 62 | Banned landing state — still the graveyard |

### What happened to the Aug 15 107

38 of those 107 are already gone (someone closed them in the last 10 days). The 8 STALE tickets that report proposed closing:

| ID | Aug 15 call | Now |
| --- | --- | --- |
| [RUSH-2400](https://linear.app/getrush/issue/RUSH-2400) | STALE, PR #2372 merged | Closed |
| [RUSH-2436](https://linear.app/getrush/issue/RUSH-2436) | STALE, 3 PRs merged | Closed |
| [RUSH-2439](https://linear.app/getrush/issue/RUSH-2439) | STALE, daemon emit live | Closed |
| [RUSH-2452](https://linear.app/getrush/issue/RUSH-2452) | STALE, path.isAbsolute fixed | Closed |
| [RUSH-2521](https://linear.app/getrush/issue/RUSH-2521) | STALE, 4 PRs merged | Closed |
| [RUSH-2591](https://linear.app/getrush/issue/RUSH-2591) | STALE, opposite decision landed | Closed |
| [RUSH-2008](https://linear.app/getrush/issue/RUSH-2008) | STALE parent design | **Canceled this pass** |
| [RUSH-2504](https://linear.app/getrush/issue/RUSH-2504) | STALE alias blocker | **Kept** — owner comment: alias shipped, agi-plugin *move* still real |

Cheap wins the Aug 15 report named also landed: [RUSH-2494](https://linear.app/getrush/issue/RUSH-2494) (`--host` removed, PR #2620), [RUSH-2536](https://linear.app/getrush/issue/RUSH-2536) (`projects pull`, PR #2656), [RUSH-2622](https://linear.app/getrush/issue/RUSH-2622) (browser tab hygiene, PR #2655).

## Figure

<figure class="artifact-figure artifact-figure-diagram">
<svg viewBox="0 0 920 280" role="img" aria-label="Open-ticket counts from Aug 15 to Aug 25, split by AGI versus the rest of the team, with this pass's 12 closures.">
  <rect x="0" y="0" width="920" height="280" fill="#0a0a0a"/>
  <text x="24" y="32" font-family="Inter, system-ui, sans-serif" font-size="14" fill="#c8c8c8">Open tickets — Aug 15 classification vs Aug 25 board</text>
  <text x="24" y="52" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#8a8a8a">AGI lime · rest of team amber · this-pass closures as the down-tick</text>

  <!-- Aug 15 AGI -->
  <rect x="40" y="90" width="107" height="70" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="52" y="118" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">Aug 15 AGI</text>
  <text x="52" y="144" font-family="Inter, system-ui, sans-serif" font-size="22" fill="#c8c8c8">107</text>

  <!-- Aug 25 AGI -->
  <rect x="180" y="80" width="205" height="90" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="192" y="108" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">Aug 25 AGI</text>
  <text x="192" y="140" font-family="Inter, system-ui, sans-serif" font-size="22" fill="#c8c8c8">205</text>
  <text x="192" y="158" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">+98 in 10 days</text>

  <!-- rest -->
  <rect x="420" y="90" width="151" height="70" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="432" y="118" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">not AGI</text>
  <text x="432" y="144" font-family="Inter, system-ui, sans-serif" font-size="22" fill="#c8c8c8">151</text>

  <!-- total -->
  <rect x="620" y="70" width="260" height="110" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="636" y="98" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">team open after this pass</text>
  <text x="636" y="136" font-family="Inter, system-ui, sans-serif" font-size="28" fill="#c8c8c8">~352</text>
  <text x="636" y="160" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#8a8a8a">364 at start  →  −14 this pass</text>

  <line x1="147" y1="125" x2="180" y2="125" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.7"/>
  <line x1="385" y1="125" x2="420" y2="125" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.7"/>
  <line x1="571" y1="125" x2="620" y2="125" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.7"/>

  <text x="24" y="250" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#8a8a8a">Source: linear tasks --cycle all --status open --json, 2026-08-25. Prior: backlog-triage.md (107 in Agents CLI, now AGI).</text>
</svg>
<figcaption>AGI open tickets nearly doubled in 10 days. This pass only nicked the total. Cycle 26 already holds most of the board.</figcaption>
</figure>

<div class="artifact-callout artifact-callout-warn">
<p>Cycle 26 is not a cycle. Hundreds of issues were dumped into the week that started today. Status Doing is also a lie: most AGI Doing tickets have no open PR (the Aug 15 report already called this out for the same IDs).</p>
</div>

## Evidence

### Closed this pass (2 Done, 12 Canceled)

| ID | Action | Proof |
| --- | --- | --- |
| [RUSH-3116](https://linear.app/getrush/issue/RUSH-3116) | Done | [PR #2996](https://github.com/phnx-labs/agi-cli/pull/2996) merged 2026-08-24. `permission_mode_not` implemented in the Python gate. |
| [RUSH-3194](https://linear.app/getrush/issue/RUSH-3194) | Done | Native status-line ingestion on HEAD: `de81321ed`, `a4ddc6d7c`, `e66791cda`, `24ea3af02`. Also [PR #3035](https://github.com/phnx-labs/agi-cli/pull/3035). |
| [RUSH-2008](https://linear.app/getrush/issue/RUSH-2008) | Canceled | Parent design; work is [RUSH-2009](https://linear.app/getrush/issue/RUSH-2009) / [2010](https://linear.app/getrush/issue/RUSH-2010) / [2011](https://linear.app/getrush/issue/RUSH-2011). Hygiene overlap already shipped as RUSH-2622. |
| [RUSH-2547](https://linear.app/getrush/issue/RUSH-2547) | Canceled | Title: "safe to cancel". Webhook demo; round-trip already proven. |
| [RUSH-1935](https://linear.app/getrush/issue/RUSH-1935) | Canceled | Growth epic, zero shipped sub-work since 2026-07-29. Child [RUSH-1937](https://linear.app/getrush/issue/RUSH-1937) remains. |
| [RUSH-2361](https://linear.app/getrush/issue/RUSH-2361) | Canceled | Wallet half shipped; hook-attribution half has no acceptance bar. |
| [RUSH-2532](https://linear.app/getrush/issue/RUSH-2532) | Canceled | "Design the new wallet shape" with no shape. |
| [RUSH-2554](https://linear.app/getrush/issue/RUSH-2554) | Canceled | Subsumed by [RUSH-3193](https://linear.app/getrush/issue/RUSH-3193) remaining health-surface work. |
| [RUSH-2480](https://linear.app/getrush/issue/RUSH-2480) / [2481](https://linear.app/getrush/issue/RUSH-2481) / [2482](https://linear.app/getrush/issue/RUSH-2482) | Canceled | Fast-hooks epic blocked on unmade architecture decisions, Low, not this milestone. |
| [RUSH-2795](https://linear.app/getrush/issue/RUSH-2795) | Canceled | Explicitly `[HELD]` Cloudflare Phase 4. |
| [RUSH-2573](https://linear.app/getrush/issue/RUSH-2573) / [2574](https://linear.app/getrush/issue/RUSH-2574) | Canceled | Router last slice: ticket text is "the main unknown; pick one." |

### Shipped on main, ticket still open (do not close yet)

These have merged code but the ticket itself states remaining scope, or a companion PR, or a live-verification bar:

| ID | On main | Why it stays open |
| --- | --- | --- |
| [RUSH-3193](https://linear.app/getrush/issue/RUSH-3193) | PRs [#3037](https://github.com/phnx-labs/agi-cli/pull/3037), [#3034](https://github.com/phnx-labs/agi-cli/pull/3034) | P1 supervisor landed; ~12 interval services still inline. |
| [RUSH-3100](https://linear.app/getrush/issue/RUSH-3100) | PRs [#2978](https://github.com/phnx-labs/agi-cli/pull/2978), [#2979](https://github.com/phnx-labs/agi-cli/pull/2979) | Download-on-demand landed; `.app` eviction + independent helper version still open. |
| [RUSH-3036](https://linear.app/getrush/issue/RUSH-3036) | `01aed3147` | Code merged; close when the 4 starved Claude accounts render bars on the released binary. |
| [RUSH-2848](https://linear.app/getrush/issue/RUSH-2848) | agi-cli #2850 merged | Companion [`.agents-system` #347](https://github.com/phnx-labs/.agents-system/pull/347) still open (unsigned commit / required signatures). |
| [RUSH-2507](https://linear.app/getrush/issue/RUSH-2507) | `251bcd080` | Degraded-empty reporting landed; fleet-wide `--active` + reaper unproven. |
| [RUSH-2477](https://linear.app/getrush/issue/RUSH-2477) | branch `agents/rush-2477-crash-recovery` | Resume-by-id + stagger exist on a branch, **not** on HEAD. |
| [RUSH-3113](https://linear.app/getrush/issue/RUSH-3113) | PR #3013 | That PR is a helper-download cycle break. Ticket is drift-sync + self-heal test failures. Mis-tagged, still red. |

### AGI "Doing" with no merged work (status is stale)

Same pattern the Aug 15 report called `abandoned-with-nothing`. Still Doing today:

| ID | Title | Git / PR |
| --- | --- | --- |
| [RUSH-1937](https://linear.app/getrush/issue/RUSH-1937) | Repo-surface conversion gap | none |
| [RUSH-1941](https://linear.app/getrush/issue/RUSH-1941) | Repair rush-blog-engine | none |
| [RUSH-2113](https://linear.app/getrush/issue/RUSH-2113) | verify-work-complete keep-moving | none |
| [RUSH-2376](https://linear.app/getrush/issue/RUSH-2376) | Menubar favorite devices | snapshot plumbing only (`1a6996b3c`); UI never built |
| [RUSH-2385](https://linear.app/getrush/issue/RUSH-2385) | Commander bootstrap 11–13ms | benchmark PR merged, fix unapplied |
| [RUSH-2406](https://linear.app/getrush/issue/RUSH-2406) | view usage/auth semantics | none |
| [RUSH-2474](https://linear.app/getrush/issue/RUSH-2474) | win-mini .system mirror dirty | none (wrong repo) |
| [RUSH-2484](https://linear.app/getrush/issue/RUSH-2484) | VS Codium zero-duplication client | ext moved to `phnx-labs/agi-ext` today (RUSH-3189 / PR #3028) |
| [RUSH-2526](https://linear.app/getrush/issue/RUSH-2526) | never auto-pick from stale usage | none |
| [RUSH-2527](https://linear.app/getrush/issue/RUSH-2527) | Unify native + provider accounts | PRs #2563/#2573 merged; remaining runtime tracks still claimed |

```bash
# how this pass pulled the board
linear tasks --cycle all --status open --json
linear tasks --cycle all --status open --project AGI --json
linear cycles --json
linear projects --json
```

## Recommendations

Next keep/cancel wave, in this order. Do not re-classify; close or schedule.

1. **Reset lying Doing.** Move the no-PR AGI Doing rows above back to Todo *or* cancel them. Doing with no branch for 10+ days is how the board got to 356.
2. **Refile AGI EXT tickets.** After PR #3028 the extension is `phnx-labs/agi-ext`. Tickets that only touch the ext ([RUSH-2458](https://linear.app/getrush/issue/RUSH-2458), [RUSH-2484](https://linear.app/getrush/issue/RUSH-2484), [RUSH-2511](https://linear.app/getrush/issue/RUSH-2511), [RUSH-2783](https://linear.app/getrush/issue/RUSH-2783), [RUSH-2973](https://linear.app/getrush/issue/RUSH-2973)–[2980](https://linear.app/getrush/issue/RUSH-2980), [RUSH-3184](https://linear.app/getrush/issue/RUSH-3184), [RUSH-2553](https://linear.app/getrush/issue/RUSH-2553)) should be worked there, not in this repo. Cancel-and-refile, don't leave them rotting on AGI.
3. **Cancel remaining Low backlog nits** (2699, 2457, 2524, 2675, …) unless someone is picking them *this week*. Backlog is not a decision. Router last-slice 2573/2574 already canceled this pass.
4. **Shrink Cycle 26.** 287 items is not a week. Keep only work that moves the current AGI milestone (Factory converts strategy to shipped outcomes, target 2026-08-28). Everything else: cancel, or it isn't this cycle.
5. **Don't dispatch the router epic twice.** [RUSH-2555](https://linear.app/getrush/issue/RUSH-2555) parent is still open; tier-1 2556–2561 were closed; tier-2 2565–2572 remain. Dispatch children only.

Current AGI milestone (soonest incomplete target): **Factory converts strategy to shipped outcomes**, target 2026-08-28. Means-metric is autonomous merged PRs that advance a Rush/Prix milestone, not factory GA.

## Tracking

- Prior classification (no closes): `.agents/artifacts/2026-08-15/backlog-triage.md`
- This delta: `.agents/artifacts/2026-08-25/linear-triage-delta.md`
- Closed this pass: [RUSH-3116](https://linear.app/getrush/issue/RUSH-3116), [RUSH-3194](https://linear.app/getrush/issue/RUSH-3194), [RUSH-2008](https://linear.app/getrush/issue/RUSH-2008), [RUSH-2547](https://linear.app/getrush/issue/RUSH-2547), [RUSH-1935](https://linear.app/getrush/issue/RUSH-1935), [RUSH-2361](https://linear.app/getrush/issue/RUSH-2361), [RUSH-2532](https://linear.app/getrush/issue/RUSH-2532), [RUSH-2554](https://linear.app/getrush/issue/RUSH-2554), [RUSH-2480](https://linear.app/getrush/issue/RUSH-2480), [RUSH-2481](https://linear.app/getrush/issue/RUSH-2481), [RUSH-2482](https://linear.app/getrush/issue/RUSH-2482), [RUSH-2795](https://linear.app/getrush/issue/RUSH-2795), [RUSH-2573](https://linear.app/getrush/issue/RUSH-2573), [RUSH-2574](https://linear.app/getrush/issue/RUSH-2574)
