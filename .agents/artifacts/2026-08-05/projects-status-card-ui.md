---
kind: visual
template: visual.v1
title: projects status card — UI prototypes
summary: Four mockups that fix host opacity, opaque focus counts, dead ticket IDs, and silent repo drift on the agents projects card.
header: agents projects status / view
footer: design prototypes · not shipped
project: agents-cli
context: status card readability
repository: phnx-labs/agents-cli
branch: projects-status-view-ui
tracking: ''
status: draft
harness: grok
agent: grok
human: Owner
host: worker-m2
session: session-id
date: '2026-08-05'
facts:
  - status and view share one body (runProjectCard); named form is the detail mode
  - focus numbers are raw git file-touches, not human units
  - host is already on ProjectMember but collapses away in the agents line
  - status --fleet already probes ahead/behind/dirty; default card never warns
assets: []
---

## Story

The progress card already carries the right signals. The problems are presentation:

1. **Hosts are invisible.** Twenty-seven live agents look like one machine. `ProjectMember.host` exists, but collapsed cells like `claude · running ×15` drop the host dimension when harness+status match across machines.
2. **Focus numbers are opaque.** `apps/cli/src 2329` is file-touches from `git log --name-only`. A reader cannot tell if that is commits, lines, files, or minutes.
3. **Tickets are not actionable.** `RUSH-2107 · #1944` is plain text — no URL, no OSC-8 hyperlink, no distinction between Linear and GitHub.
4. **Repo drift is silent unless `--fleet`.** An agent on a host that is 40 commits behind will conflict with peers on `main`. The probe already knows; the default card does not warn.

`status` and `view` are the same card body. The prototypes only change layout and labels.

## Data

| Signal | Source today | Reader problem |
| --- | --- | --- |
| live / dead / agents | session rollup | agents collapse across hosts |
| focus | local `git log --name-only` | bare integer, no unit |
| tickets | session ticket ids | not clickable |
| repos | def slug only | no per-host freshness |
| fleet | `status --fleet` opt-in | drift hidden by default |

## Figure

### 0 — Current card (baseline)

<div class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg viewBox="0 0 820 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Current agents projects status card baseline">
  <rect width="820" height="340" rx="12" fill="#0f1419"/>
  <text x="24" y="36" fill="#ffffff" font-family="ui-monospace, Menlo, monospace" font-size="14" font-weight="700">agents-cli</text>
  <text x="130" y="36" fill="#8b98a5" font-family="ui-monospace, Menlo, monospace" font-size="14">·</text>
  <text x="150" y="36" fill="#ffffff" font-family="ui-monospace, Menlo, monospace" font-size="14" font-weight="700">27 live</text>
  <g font-family="ui-monospace, Menlo, monospace" font-size="13">
    <text x="24" y="68" fill="#8b98a5">live</text>
    <text x="96" y="68" fill="#3dd68c">17 running</text>
    <text x="210" y="68" fill="#c5d0da">· 7 idle ·</text>
    <text x="300" y="68" fill="#f5c518">1 need-input</text>
    <text x="420" y="68" fill="#8b98a5">· +2 other</text>
    <text x="24" y="94" fill="#8b98a5">dead</text>
    <text x="96" y="94" fill="#f5c518">27 finished or lost</text>
    <text x="280" y="94" fill="#8b98a5">(27 crashed)</text>
    <text x="24" y="120" fill="#8b98a5">agents</text>
    <text x="96" y="120" fill="#c5d0da">claude · running ×15  ·  claude · running · RUSH-2107  ·  grok · running  · …</text>
    <text x="24" y="146" fill="#8b98a5">ships</text>
    <text x="96" y="146" fill="#3dd68c">100+ merged (7d)</text>
    <text x="250" y="146" fill="#c5d0da">· v1.22.4</text>
    <text x="24" y="172" fill="#8b98a5">linear</text>
    <text x="96" y="172" fill="#c5d0da">368/472 done · 13 in progress</text>
    <text x="24" y="198" fill="#8b98a5">next</text>
    <text x="96" y="198" fill="#c5d0da">Factory converts strategy to shipped outcomes  ·  due Sep 15</text>
    <text x="24" y="224" fill="#8b98a5">schedule</text>
    <text x="96" y="224" fill="#f5c518">3 milestones, no issues filed — progress is not measurable</text>
    <text x="24" y="250" fill="#8b98a5">focus</text>
    <text x="96" y="250" fill="#c5d0da">apps/cli/src</text>
    <text x="210" y="250" fill="#8b98a5">2329</text>
    <text x="260" y="250" fill="#8b98a5">·</text>
    <text x="280" y="250" fill="#c5d0da">apps/cli/docs</text>
    <text x="400" y="250" fill="#8b98a5">302</text>
    <text x="440" y="250" fill="#8b98a5">·</text>
    <text x="460" y="250" fill="#c5d0da">apps/factory/src</text>
    <text x="610" y="250" fill="#8b98a5">245</text>
    <text x="24" y="276" fill="#8b98a5">tickets</text>
    <text x="96" y="276" fill="#c5d0da">RUSH-2107 · #1944</text>
    <text x="24" y="302" fill="#8b98a5">repos</text>
    <text x="96" y="302" fill="#c5d0da">phnx-labs/agents-cli</text>
  </g>
  <text x="24" y="328" fill="#6b7785" font-family="ui-sans-serif, system-ui" font-size="11">Baseline pain: no hosts · bare focus counts · inert tickets · silent repo drift</text>
</svg>
</div>

### A — Hosts first (recommended default)

Add a dedicated `hosts` line. Keep the agents roster for harness × status × ticket.

<div class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg viewBox="0 0 820 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Proposed card with hosts line focus units and ticket links">
  <rect width="820" height="300" rx="12" fill="#0f1419"/>
  <text x="24" y="36" fill="#ffffff" font-family="ui-monospace, Menlo, monospace" font-size="14" font-weight="700">agents-cli</text>
  <text x="130" y="36" fill="#8b98a5" font-family="ui-monospace, Menlo, monospace" font-size="14">·</text>
  <text x="150" y="36" fill="#ffffff" font-family="ui-monospace, Menlo, monospace" font-size="14" font-weight="700">27 live</text>
  <g font-family="ui-monospace, Menlo, monospace" font-size="13">
    <text x="24" y="68" fill="#8b98a5">live</text>
    <text x="96" y="68" fill="#3dd68c">17 running</text>
    <text x="210" y="68" fill="#c5d0da">· 7 idle ·</text>
    <text x="300" y="68" fill="#f5c518">1 need-input</text>
    <text x="24" y="94" fill="#8b98a5">dead</text>
    <text x="96" y="94" fill="#f5c518">27 finished or lost (27 crashed)</text>
    <text x="24" y="120" fill="#8b98a5">hosts</text>
    <text x="96" y="120" fill="#7aa2f7">workstation</text>
    <text x="140" y="120" fill="#c5d0da">×14</text>
    <text x="190" y="120" fill="#8b98a5">·</text>
    <text x="210" y="120" fill="#7aa2f7">worker-s0</text>
    <text x="320" y="120" fill="#c5d0da">×8</text>
    <text x="360" y="120" fill="#8b98a5">·</text>
    <text x="380" y="120" fill="#7aa2f7">release-host</text>
    <text x="460" y="120" fill="#c5d0da">×4</text>
    <text x="500" y="120" fill="#8b98a5">·</text>
    <text x="520" y="120" fill="#7aa2f7">worker-s1</text>
    <text x="630" y="120" fill="#c5d0da">×1</text>
    <text x="24" y="146" fill="#8b98a5">agents</text>
    <text x="96" y="146" fill="#c5d0da">claude · running ×15  ·  claude · running · RUSH-2107  ·  grok · running  · +12 more</text>
    <text x="24" y="172" fill="#8b98a5">ships</text>
    <text x="96" y="172" fill="#3dd68c">100+ merged (7d)</text>
    <text x="250" y="172" fill="#c5d0da">· v1.22.4</text>
    <text x="24" y="198" fill="#8b98a5">focus</text>
    <text x="96" y="198" fill="#c5d0da">apps/cli/src</text>
    <text x="210" y="198" fill="#8b98a5">2.3k file-touches (7d)</text>
    <text x="400" y="198" fill="#8b98a5">·</text>
    <text x="420" y="198" fill="#c5d0da">apps/cli/docs 302</text>
    <text x="580" y="198" fill="#8b98a5">·</text>
    <text x="600" y="198" fill="#c5d0da">apps/factory 245</text>
    <text x="24" y="224" fill="#8b98a5">tickets</text>
    <text x="96" y="224" fill="#7aa2f7" text-decoration="underline">RUSH-2107</text>
    <text x="190" y="224" fill="#8b98a5">·</text>
    <text x="210" y="224" fill="#7aa2f7" text-decoration="underline">#1944</text>
    <text x="24" y="250" fill="#8b98a5">repos</text>
    <text x="96" y="250" fill="#c5d0da">phnx-labs/agents-cli</text>
    <text x="24" y="276" fill="#f5c518">!</text>
    <text x="48" y="276" fill="#f5c518">worker-s0 is 40 commits behind origin/main</text>
  </g>
</svg>
</div>

<div class="artifact-callout">
<strong>A is the recommended default.</strong> Hide the hosts line when every live agent is on one machine. Focus gets an explicit unit. Tickets use OSC-8 hyperlinks. Drift appears as a one-line warning without requiring the full --fleet table.
</div>

### B — Host-grouped agents (dense fleet alternative)

<div class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg viewBox="0 0 820 140" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Agents roster grouped by host">
  <rect width="820" height="140" rx="12" fill="#0f1419"/>
  <g font-family="ui-monospace, Menlo, monospace" font-size="13">
    <text x="24" y="36" fill="#8b98a5">agents</text>
    <text x="96" y="36" fill="#7aa2f7">@workstation</text>
    <text x="160" y="36" fill="#c5d0da">claude · running ×9  ·  claude · idle ×4  ·  grok · running</text>
    <text x="96" y="64" fill="#7aa2f7">@worker-s0</text>
    <text x="220" y="64" fill="#c5d0da">claude · running ×5  ·  claude · idle ×2  ·  claude · input_required</text>
    <text x="96" y="92" fill="#7aa2f7">@release-host</text>
    <text x="190" y="92" fill="#c5d0da">claude · running ×1  ·  claude · idle ×1  ·  claude · orphaned ×2</text>
    <text x="24" y="124" fill="#6b7785" font-family="ui-sans-serif, system-ui" font-size="11">B: better for “who is on yosemite?”; costs vertical space; only when live spans 2+ hosts</text>
  </g>
</svg>
</div>

### C — Focus that reads as engineering

Three label variants for the same data. Recommend **C1**.

<div class="artifact-grid artifact-grid-3">
  <article class="artifact-panel">
    <h3>C1 — unit suffix</h3>
    <p><span class="artifact-tag artifact-tag-accent">recommended</span></p>
    <p><code>focus apps/cli/src 2.3k file-touches (7d)</code></p>
    <p>Says what the number is. Compact. No new data.</p>
  </article>
  <article class="artifact-panel">
    <h3>C2 — share bar</h3>
    <p><code>apps/cli/src ████████░░ 72%</code></p>
    <p>Shows relative weight. Unicode bars are noisy in some terminals.</p>
  </article>
  <article class="artifact-panel">
    <h3>C3 — rank only</h3>
    <p><code>#1 apps/cli/src · #2 docs · #3 factory</code></p>
    <p>Drops magnitude. Cleanest scan, least precise.</p>
  </article>
</div>

### D — Tickets you can open

<div class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg viewBox="0 0 820 110" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Clickable ticket IDs via OSC-8">
  <rect width="820" height="110" rx="12" fill="#0f1419"/>
  <g font-family="ui-monospace, Menlo, monospace" font-size="13">
    <text x="24" y="36" fill="#8b98a5">tickets</text>
    <text x="96" y="36" fill="#7aa2f7" text-decoration="underline">RUSH-2107</text>
    <text x="190" y="36" fill="#8b98a5">·</text>
    <text x="210" y="36" fill="#7aa2f7" text-decoration="underline">#1944</text>
    <text x="270" y="36" fill="#8b98a5">·</text>
    <text x="290" y="36" fill="#7aa2f7" text-decoration="underline">RUSH-2091</text>
    <text x="96" y="64" fill="#6b7785">linear.app/…/RUSH-2107   ·   github.com/phnx-labs/agents-cli/pull/1944</text>
    <text x="24" y="94" fill="#6b7785" font-family="ui-sans-serif, system-ui" font-size="11">D: OSC-8 on the id (iTerm2 / Ghostty / VS Code / WT). Dim full URLs only in view mode or non-link terms.</text>
  </g>
</svg>
</div>

### E — Repo freshness without requiring `--fleet`

<div class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg viewBox="0 0 820 120" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Repo drift warning on default card">
  <rect width="820" height="120" rx="12" fill="#0f1419"/>
  <g font-family="ui-monospace, Menlo, monospace" font-size="13">
    <text x="24" y="36" fill="#8b98a5">repos</text>
    <text x="96" y="36" fill="#c5d0da">phnx-labs/agents-cli</text>
    <text x="24" y="64" fill="#f5c518">!</text>
    <text x="48" y="64" fill="#f5c518">worker-s0 40 behind · release-host dirty (3)</text>
    <text x="48" y="90" fill="#6b7785">agents there will conflict with workstation · agents projects status agents-cli --fleet</text>
  </g>
</svg>
</div>

<div class="artifact-callout artifact-callout-warn">
<strong>E cost tradeoff.</strong> Local probe is free and should always run. Remote drift needs either a cached last-fleet sample or a light SSH fan-out. Do not claim “all hosts clean” without a probe.
</div>

### Combined recommendation (A + C1 + D + E)

<div class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg viewBox="0 0 820 360" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Combined recommended card layout">
  <rect width="820" height="360" rx="12" fill="#0f1419"/>
  <text x="24" y="32" fill="#ffffff" font-family="ui-monospace, Menlo, monospace" font-size="14" font-weight="700">agents-cli</text>
  <text x="130" y="32" fill="#8b98a5" font-family="ui-monospace, Menlo, monospace" font-size="14">·</text>
  <text x="150" y="32" fill="#ffffff" font-family="ui-monospace, Menlo, monospace" font-size="14" font-weight="700">27 live</text>
  <g font-family="ui-monospace, Menlo, monospace" font-size="13">
    <text x="24" y="60" fill="#8b98a5">live</text>
    <text x="96" y="60" fill="#3dd68c">17 running</text>
    <text x="210" y="60" fill="#c5d0da">· 7 idle ·</text>
    <text x="300" y="60" fill="#f5c518">1 need-input</text>
    <text x="24" y="86" fill="#8b98a5">dead</text>
    <text x="96" y="86" fill="#f5c518">27 finished or lost (27 crashed)</text>
    <text x="24" y="112" fill="#8b98a5">hosts</text>
    <text x="96" y="112" fill="#7aa2f7">workstation ×14 · worker-s0 ×8 · release-host ×4 · worker-s1 ×1</text>
    <text x="24" y="138" fill="#8b98a5">agents</text>
    <text x="96" y="138" fill="#c5d0da">claude · running ×15  ·  claude · running · RUSH-2107  ·  grok · running  · +12 more</text>
    <text x="24" y="164" fill="#8b98a5">ships</text>
    <text x="96" y="164" fill="#3dd68c">100+ merged (7d)</text>
    <text x="250" y="164" fill="#c5d0da">· v1.22.4</text>
    <text x="24" y="190" fill="#8b98a5">linear</text>
    <text x="96" y="190" fill="#c5d0da">368/472 done · 13 in progress</text>
    <text x="24" y="216" fill="#8b98a5">next</text>
    <text x="96" y="216" fill="#c5d0da">Factory converts strategy to shipped outcomes  ·  due Sep 15</text>
    <text x="24" y="242" fill="#8b98a5">schedule</text>
    <text x="96" y="242" fill="#f5c518">3 milestones, no issues filed — progress is not measurable</text>
    <text x="24" y="268" fill="#8b98a5">focus</text>
    <text x="96" y="268" fill="#c5d0da">apps/cli/src</text>
    <text x="210" y="268" fill="#8b98a5">2.3k file-touches (7d)</text>
    <text x="400" y="268" fill="#c5d0da">· apps/cli/docs 302 · apps/factory 245</text>
    <text x="24" y="294" fill="#8b98a5">tickets</text>
    <text x="96" y="294" fill="#7aa2f7" text-decoration="underline">RUSH-2107</text>
    <text x="190" y="294" fill="#8b98a5">·</text>
    <text x="210" y="294" fill="#7aa2f7" text-decoration="underline">#1944</text>
    <text x="24" y="320" fill="#8b98a5">repos</text>
    <text x="96" y="320" fill="#c5d0da">phnx-labs/agents-cli</text>
    <text x="300" y="320" fill="#f5c518">! worker-s0 40 behind · release-host dirty (3)</text>
  </g>
  <text x="24" y="348" fill="#6b7785" font-family="ui-sans-serif, system-ui" font-size="11">Ship for both status and view (shared body). Definition block still only on the named form.</text>
</svg>
</div>

### Layout order

<div class="artifact-figure artifact-figure-diagram">
<svg viewBox="0 0 720 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Card layout reading order">
  <rect width="720" height="200" rx="12" fill="#0f1419"/>
  <g font-family="ui-sans-serif, system-ui" font-size="13">
    <rect x="20" y="24" width="150" height="44" rx="8" fill="#1a2332" stroke="#3dd68c"/>
    <text x="34" y="50" fill="#e7ecf1">1 live / dead</text>
    <rect x="190" y="24" width="150" height="44" rx="8" fill="#1a2332" stroke="#7aa2f7"/>
    <text x="204" y="50" fill="#e7ecf1">2 hosts (new)</text>
    <rect x="360" y="24" width="150" height="44" rx="8" fill="#1a2332" stroke="#8b98a5"/>
    <text x="374" y="50" fill="#e7ecf1">3 agents</text>
    <rect x="530" y="24" width="170" height="44" rx="8" fill="#1a2332" stroke="#8b98a5"/>
    <text x="544" y="50" fill="#e7ecf1">4 ships / linear</text>
    <rect x="20" y="88" width="220" height="44" rx="8" fill="#1a2332" stroke="#f5c518"/>
    <text x="34" y="114" fill="#e7ecf1">5 focus + unit label</text>
    <rect x="260" y="88" width="220" height="44" rx="8" fill="#1a2332" stroke="#7aa2f7"/>
    <text x="274" y="114" fill="#e7ecf1">6 tickets + OSC-8</text>
    <rect x="500" y="88" width="200" height="44" rx="8" fill="#1a2332" stroke="#f5c518"/>
    <text x="514" y="114" fill="#e7ecf1">7 repos + drift !</text>
    <text x="20" y="170" fill="#6b7785" font-size="12">Hosts sit next to live/dead so machine distribution is the second thing you see.</text>
  </g>
</svg>
</div>

## Decision table

| Idea | Cost | Default? | Notes |
| --- | --- | --- | --- |
| A hosts line | free when `session.machine` is set | **yes** | hide when single-host |
| B host-grouped agents | free | no | later if A is not enough |
| C1 focus unit label | free | **yes** | `file-touches (7d)` |
| C2 share bar | free | no | terminal-noisy |
| D OSC-8 tickets | small URL builder | **yes** | |
| E drift warning | local free; remote medium | **local yes** | never claim all-clean without probe |

## Already landed in this branch

`status` / `view` / `show` are one implementation (`runProjectCard`). Named form = full milestones + definition footer. Unnamed = multi-project compact card. No duplicate render path.

## Open choice for you

1. Ship **A + C1 + D + E** as drawn?
2. Prefer **B** host-grouped agents instead of a separate hosts line?
3. For **E**, warn only from the local checkout, or also sample fleet peers on every status (adds SSH cost)?
