---
kind: plan
template: plan.v1
surface: internal
title: Triage scoreboard — after the walk
summary: You walked keep-8, killed the router epic, split AGI UI, and put Fleet robustness on Wednesday windows. This page replaces the stale keep-8 / groups catalogs.
status: draft
date: "2026-08-25"
header: Phoenix Labs / agents-cli
footer: Live triage scoreboard — reopen this file, not groups.html
facts:
  - "Router epic canceled (9)"
  - "AGI UI project + 4 milestones"
  - "16 UI tickets due Wed 26"
links:
  - url: https://linear.app/getrush/project/agi-ui-4d6b7da2aeb2
    label: AGI UI
  - url: https://linear.app/getrush/issue/RUSH-2512
    label: RUSH-2512
  - url: https://linear.app/getrush/issue/RUSH-3182
    label: RUSH-3182
  - url: https://linear.app/getrush/issue/RUSH-3193
    label: RUSH-3193
---

## Purpose

This is the triage doc to keep reviewing. `linear-triage-groups.html` and the old keep-8 list are stale.

**Where work lives now**

| Bucket | What |
| --- | --- |
| **AGI UI · Wed AM** | Remote sessions as robust as local. Reconnect, resume-as-tab, no fake 0, no identity spawn storm. Due **tomorrow 26 Aug**. |
| **AGI UI · Wed midday** | Fleet never lies. Coalesce, empty/error, needs-you order, no reply without a channel, no acting poll timers. Due **26 Aug**. |
| **AGI UI · Wed PM** | Thin client + boot. Zero-duplication, New-agent boot, menu-bar children. Due **26 Aug**. |
| **AGI UI · Fri polish** | Favorites, virtualize feed, screenshot attach. Due **28 Aug**. Not fail-proof. |
| **AGI CLI still open** | [RUSH-2512](https://linear.app/getrush/issue/RUSH-2512) (cross-host preview, due Wed), [RUSH-3182](https://linear.app/getrush/issue/RUSH-3182) (setup-token vs balanced), [RUSH-3193](https://linear.app/getrush/issue/RUSH-3193) (daemon supervisor, already in flight), [RUSH-2526](https://linear.app/getrush/issue/RUSH-2526) (stale-usage routing — still undecided). |
| **AGI leftover** | ~170 open still in Cycle 26. Not walked. Parent epics still inflate the 164/182 counter. |

`AGI 164 / 182` was Linear counting every AGI issue stuffed into Cycle 26 (parents + children). Not 182 units of Wednesday work.

## Current architecture

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg class="artifact-diagram" viewBox="0 0 960 280" role="img" aria-label="After the walk: AGI UI on Wednesday windows, three CLI keeps, leftover AGI slop">
    <rect x="20" y="20" width="280" height="240" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
    <text x="36" y="48" font-family="JetBrains Mono, monospace" font-size="12" fill="#a3e635">AGI UI · tomorrow</text>
    <text x="36" y="76" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">Wed AM remote=local · 5</text>
    <text x="36" y="98" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">Wed midday never lies · 6</text>
    <text x="36" y="120" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">Wed PM thin client · 5</text>
    <text x="36" y="152" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#8a8a8a">Fri polish · 3 (not robustness)</text>
    <text x="36" y="200" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">16 due 26 Aug</text>
    <text x="36" y="222" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#8a8a8a">linear.app/getrush/project/agi-ui</text>

    <rect x="320" y="20" width="300" height="240" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
    <text x="336" y="48" font-family="JetBrains Mono, monospace" font-size="12" fill="#38bdf8">AGI CLI · keep</text>
    <text x="336" y="80" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">2512 preview · due Wed</text>
    <text x="336" y="102" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">3182 balanced setup-token</text>
    <text x="336" y="124" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">3193 daemon · in flight</text>
    <text x="336" y="146" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#8a8a8a">2526 stale usage · undecided</text>
    <text x="336" y="200" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#8a8a8a">Router epic 2555 + 2565-2572 canceled.</text>
    <text x="336" y="222" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#8a8a8a">Selectors already ship: run auto, --strategy, --device auto.</text>

    <rect x="640" y="20" width="300" height="240" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
    <text x="656" y="48" font-family="JetBrains Mono, monospace" font-size="12" fill="#f59e0b">not walked</text>
    <text x="656" y="80" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">AGI leftover ~170 open</text>
    <text x="656" y="102" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">Prix / Rush / SVAtlas</text>
    <text x="656" y="124" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">no-project mix</text>
    <text x="656" y="200" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#8a8a8a">Cycle 26 still holds the dump.</text>
    <text x="656" y="222" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#8a8a8a">164/182 was that dump, not Wed work.</text>
  </svg>
  <figcaption>After the walk. Lime is AGI UI tomorrow. Blue is remaining CLI keeps. Amber is unwalked slop.</figcaption>
</figure>

## Proposed Changes

```diff title=linear-after-walk.txt
@@ keep-8 (original proposal) @@
-RUSH-3182 3183 3100 3034 2477 3180 2526 2543
+RUSH-3182 (accounts)
+RUSH-3193 (daemon, in flight)
+RUSH-2512 (cross-host preview, due Wed)
+RUSH-2526 (stale usage — still your call)
@@ router epic @@
-9 open (2555, 2565-2572)
+all Canceled — selectors already ship
@@ AGI EXT @@
-parked on AGI project
+project AGI UI, 4 milestones, 16 due tomorrow
@@ sessions epic 2652 @@
-parent Todo in Cycle 26 showing 5/7
+parent off cycle; only 2512 remains in Cycle 26
```

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg class="artifact-diagram" viewBox="0 0 960 200" role="img" aria-label="Wednesday windows for AGI UI">
    <rect x="20" y="40" width="280" height="120" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
    <text x="40" y="72" font-family="JetBrains Mono, monospace" font-size="12" fill="#a3e635">Wed AM</text>
    <text x="40" y="98" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">Remote = local</text>
    <text x="40" y="122" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#8a8a8a">2783 3175 3184 2735 2553</text>
    <text x="40" y="142" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#8a8a8a">+ CLI 2512</text>
    <rect x="340" y="40" width="280" height="120" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
    <text x="360" y="72" font-family="JetBrains Mono, monospace" font-size="12" fill="#a3e635">Wed midday</text>
    <text x="360" y="98" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">Fleet never lies</text>
    <text x="360" y="122" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#8a8a8a">2978 2976 2975 2980 2973 2833</text>
    <rect x="660" y="40" width="280" height="120" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
    <text x="680" y="72" font-family="JetBrains Mono, monospace" font-size="12" fill="#a3e635">Wed PM</text>
    <text x="680" y="98" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">Thin client + boot</text>
    <text x="680" y="122" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#8a8a8a">2484 2511 2413 2092 2653</text>
  </svg>
  <figcaption>Three windows tomorrow, all due 2026-08-26. Friday polish is off this figure.</figcaption>
</figure>

### AGI UI · Wed AM — Remote = local (due 26 Aug)

| Ticket | Why this window |
| --- | --- |
| [RUSH-2783](https://linear.app/getrush/issue/RUSH-2783) | Resume as editor tab, not panel ssh |
| [RUSH-3175](https://linear.app/getrush/issue/RUSH-3175) | Reconnect must not dead-end at a shell |
| [RUSH-3184](https://linear.app/getrush/issue/RUSH-3184) | Stop unbounded `--device` identity fetches |
| [RUSH-2735](https://linear.app/getrush/issue/RUSH-2735) | Follower shows degraded, never `0 sessions` |
| [RUSH-2553](https://linear.app/getrush/issue/RUSH-2553) | New Agent must mint a session id |
| [RUSH-2512](https://linear.app/getrush/issue/RUSH-2512) | CLI picker preview for remote (stays on AGI) |

### AGI UI · Wed midday — Fleet never lies (due 26 Aug)

| Ticket | Why this window |
| --- | --- |
| [RUSH-2978](https://linear.app/getrush/issue/RUSH-2978) | Coalesce so idle does not stay `running` |
| [RUSH-2976](https://linear.app/getrush/issue/RUSH-2976) | Loading / empty / error |
| [RUSH-2975](https://linear.app/getrush/issue/RUSH-2975) | Needs-you actually reorders |
| [RUSH-2980](https://linear.app/getrush/issue/RUSH-2980) | No reply UI without a channel |
| [RUSH-2973](https://linear.app/getrush/issue/RUSH-2973) | Detail pane matches the sessions picker |
| [RUSH-2833](https://linear.app/getrush/issue/RUSH-2833) | Kill acting poll timers |

### AGI UI · Wed PM — Thin client (due 26 Aug)

| Ticket | Why this window |
| --- | --- |
| [RUSH-2484](https://linear.app/getrush/issue/RUSH-2484) | Zero-duplication CLI client (in flight `c69da5b4`) |
| [RUSH-2511](https://linear.app/getrush/issue/RUSH-2511) | New-agent boot |
| [RUSH-2413](https://linear.app/getrush/issue/RUSH-2413) | Menu-bar children stay tracked |
| [RUSH-2092](https://linear.app/getrush/issue/RUSH-2092) | Per-device auto-launch |
| [RUSH-2653](https://linear.app/getrush/issue/RUSH-2653) | Parent umbrella |

### Closed on the walk (do not reopen)

| Ticket | Result |
| --- | --- |
| [RUSH-2477](https://linear.app/getrush/issue/RUSH-2477) | Done — resume storms gone |
| [RUSH-3180](https://linear.app/getrush/issue/RUSH-3180) / [2507](https://linear.app/getrush/issue/RUSH-2507) | Canceled — daemon refactor / `--active` shipped |
| [RUSH-3100](https://linear.app/getrush/issue/RUSH-3100) / [3034](https://linear.app/getrush/issue/RUSH-3034) | Canceled — new release design, no extra producer |
| [RUSH-2527](https://linear.app/getrush/issue/RUSH-2527) | Canceled — account-core merged; leftover is 3182 |
| [RUSH-2555](https://linear.app/getrush/issue/RUSH-2555) + 2565–2572 | Canceled — `run auto` + `--strategy balanced` + `--device auto` already are the router |
| [RUSH-2543](https://linear.app/getrush/issue/RUSH-2543) / [2544](https://linear.app/getrush/issue/RUSH-2544) | Low — CI leak, not product |

Sessions parent [RUSH-2652](https://linear.app/getrush/issue/RUSH-2652) is **off Cycle 26**. Only 2512 stays in the cycle.

## Public Interface

```bash
# AGI UI project + Wednesday windows
linear tasks --project "AGI UI" --by-milestone
linear milestones list "AGI UI"

# Remaining CLI keeps
linear tasks RUSH-2512 RUSH-3182 RUSH-3193 RUSH-2526
```

Project: [AGI UI](https://linear.app/getrush/project/agi-ui-4d6b7da2aeb2)

## Validation

| Check | Expected |
| --- | --- |
| AGI UI open | 19, all milestoned |
| Due 26 Aug | 16 UI + CLI 2512 |
| Router epic | 2555, 2565–2572 Canceled |
| Cycle 26 sessions | 2512 only, not parent 2652 |

## Risks

| Risk | Mitigation |
| --- | --- |
| 16 Wednesday tickets is still a lot | Three windows; thin-client 2484 is already in flight |
| 2526 still open | Confirm fold into usage session or cancel |
| AGI leftover ~170 | Not this page. Walk another group when you want |

<aside class="artifact-callout"><strong>Review this file.</strong> Wednesday robustness is on AGI UI. CLI keep is 2512 + 3182 + 3193. 2526 is the only leftover question from keep-8.</aside>

## Checklist

- [x] Walk keep-8; close shipped / not-needed
- [x] Cancel router epic (selectors already ship)
- [x] Create AGI UI; move Fleet/menu-bar tickets
- [x] Wednesday AM/midday/PM + Friday polish milestones
- [x] Pull sessions parent off Cycle 26; keep 2512
- [x] Refresh this scoreboard and open on Zion
- [ ] Owner call on RUSH-2526
- [ ] Walk remaining AGI Cycle 26 slop when you want

## Tracking

- This file: `.agents/artifacts/2026-08-25/plan-linear-keep-8.md`
- Stale catalog (do not review): `.agents/artifacts/2026-08-25/linear-triage-groups.html`
- AGI UI: https://linear.app/getrush/project/agi-ui-4d6b7da2aeb2
