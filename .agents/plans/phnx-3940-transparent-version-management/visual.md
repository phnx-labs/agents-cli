---
kind: visual
title: One account home, many releases
summary: The account is durable. The executable is replaceable. Migration keeps those two responsibilities separate.
project: agents-cli
repository: phnx-labs/agi-cli
branch: fix/phnx-3940-transparent-version-management
tracking: PHNX-3940
status: proposal
human: Project owner
host: local
session: ""
harness: codex
agent: Codex
date: "2026-09-05"
footer: Technical proposal · fictional account labels
links:
  - url: https://linear.app/getrush/issue/PHNX-3940/fleet-account-state-is-inconsistent-across-machines
    label: PHNX-3940
assets: []
---

## Story

Personal and work accounts should both run the latest Codex without sharing credentials or asking the user to install different release numbers. Each account keeps its current home. Agents maintains the executable that runs against it.

## Data

The current installation record already has a stable `id` and directory `label`, separate from `releaseVersion` (`cli/src/lib/installations/types.ts:41`). Its npm update strategy swaps only executable package files (`strategies.ts:112`). The proposal builds on that existing separation; it does not introduce a shared login store.

## Figure

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg class="artifact-diagram" viewBox="0 0 880 510" role="img" aria-label="Personal and work keep separate login homes while their executables update to the same release; duplicates remain preserved">
<text x="25" y="32" fill="#a3e635" font-family="monospace" font-size="17">WHAT YOU CHOOSE</text>
<text x="320" y="32" fill="#38bdf8" font-family="monospace" font-size="17">WHAT STAYS</text>
<text x="615" y="32" fill="#f59e0b" font-family="monospace" font-size="17">WHAT UPDATES</text>
<rect x="25" y="60" width="235" height="95" rx="8" fill="#0f160a" stroke="#a3e635"/>
<text x="45" y="97" fill="#a3e635" font-family="monospace" font-size="18">codex#personal</text>
<text x="45" y="128" fill="#c8c8c8" font-size="14">Same command after updates</text>
<path d="M260 107 H309" stroke="#38bdf8" stroke-width="2"/>
<path d="M299 101 L309 107 L299 113" stroke="#38bdf8" fill="none" stroke-width="2"/>
<rect x="320" y="60" width="235" height="95" rx="8" fill="#0e1418" stroke="#38bdf8"/>
<text x="340" y="97" fill="#38bdf8" font-family="monospace" font-size="18">Personal home</text>
<text x="340" y="128" fill="#c8c8c8" font-size="14">Login · settings · history</text>
<path d="M555 107 H604" stroke="#38bdf8" stroke-width="2"/>
<path d="M594 101 L604 107 L594 113" stroke="#38bdf8" fill="none" stroke-width="2"/>
<rect x="615" y="60" width="235" height="95" rx="8" fill="#16120a" stroke="#f59e0b"/>
<text x="635" y="97" fill="#f59e0b" font-family="monospace" font-size="18">Current release</text>
<text x="635" y="128" fill="#c8c8c8" font-size="14">Replace only when safe</text>
<rect x="25" y="205" width="235" height="95" rx="8" fill="#0f160a" stroke="#a3e635"/>
<text x="45" y="242" fill="#a3e635" font-family="monospace" font-size="18">codex#work</text>
<text x="45" y="273" fill="#c8c8c8" font-size="14">Independent account selection</text>
<path d="M260 252 H309" stroke="#38bdf8" stroke-width="2"/>
<path d="M299 246 L309 252 L299 258" stroke="#38bdf8" fill="none" stroke-width="2"/>
<rect x="320" y="205" width="235" height="95" rx="8" fill="#0e1418" stroke="#38bdf8"/>
<text x="340" y="242" fill="#38bdf8" font-family="monospace" font-size="18">Work home</text>
<text x="340" y="273" fill="#c8c8c8" font-size="14">Separate native credentials</text>
<path d="M555 252 H604" stroke="#38bdf8" stroke-width="2"/>
<path d="M594 246 L604 252 L594 258" stroke="#38bdf8" fill="none" stroke-width="2"/>
<rect x="615" y="205" width="235" height="95" rx="8" fill="#16120a" stroke="#f59e0b"/>
<text x="635" y="242" fill="#f59e0b" font-family="monospace" font-size="18">Same release</text>
<text x="635" y="273" fill="#c8c8c8" font-size="14">No version-as-account trick</text>
<path d="M25 338 H850" stroke="#333333"/>
<text x="25" y="375" fill="#c8c8c8" font-size="17">FIRST RUN AFTER UPGRADING AGENTS</text>
<text x="25" y="412" fill="#38bdf8" font-family="monospace" font-size="15">Discover old homes</text>
<path d="M210 407 H248" stroke="#38bdf8" stroke-width="2"/>
<text x="265" y="412" fill="#38bdf8" font-family="monospace" font-size="15">Match native identity</text>
<path d="M474 407 H518" stroke="#38bdf8" stroke-width="2"/>
<text x="535" y="412" fill="#a3e635" font-family="monospace" font-size="15">Show one row per account</text>
<text x="25" y="463" fill="#8a8a8a" font-size="15">No token copying. No directory moves. No duplicate-home deletion. Old references still resolve.</text>
</svg>
<figcaption>Illustrative proposal, not a screenshot of shipped behavior. Release numbers remain visible in diagnostics.</figcaption>
</figure>

<aside class="artifact-callout">Updates are automatic by default, not mandatory. Turn them off globally or per harness; pin a specific installation when reproducibility matters. Busy or unsupported installations must be reported honestly.</aside>

[Open the implementation plan and verification checklist](plan.html). [Tracking: PHNX-3940](https://linear.app/getrush/issue/PHNX-3940/fleet-account-state-is-inconsistent-across-machines).
