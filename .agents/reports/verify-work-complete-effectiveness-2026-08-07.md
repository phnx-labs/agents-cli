---
kind: report
title: verify-work-complete — seven-day effectiveness audit
summary: A transcript-grounded audit of observable blocking interventions, agent reactions, context mismatches, and installation state.
status: complete
tracking: RUSH-2113
project: agents-cli
repository: phnx-labs/agents-cli
harness: Codex
agent: GPT-5
host: yosemite-s0
session: 019fdf1d
date: 2026-08-07
facts:
  - 390 logical interventions after deduplication
  - 25 of 28 reviewed objections were context or ownership misfires
  - 53 duplicate feedback records
---

# The completion hook acts often, but cannot reliably tell a delivery from browser work

## Summary

From 2026-08-01 through 2026-08-08, the audit found **390 logical blocking interventions** across **167 sessions**. Agents ran a tool after 327 interventions (83.8%); their immediate response pushed back after 25 (6.4%).

<div class="artifact-callout"><strong>Primary finding.</strong> The deterministic scan found 22 delivery-gate interventions with no PR, commit, push, merge, edit, or patch activity in the active user-turn chain. A focused read of all 28 objection/unclear reactions confirmed that 25 were context or ownership misfires; three were useful ownership or self-audit prompts.</div>

<figure>
<svg viewBox="0 0 820 230" role="img" aria-labelledby="flow-title flow-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="flow-title">Observed stop-hook reaction flow</title>
  <desc id="flow-desc">A stop attempt reaches the hook, then either causes action, evidence-backed pushback, or repetition before the next user turn.</desc>
  <defs><marker id="arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="currentColor"/></marker></defs>
  <g fill="none" stroke="currentColor" stroke-width="2" opacity=".55" marker-end="url(#arrow)">
    <path d="M190 112 H300"/><path d="M470 112 H565"/><path d="M470 112 C515 112 515 38 565 38"/><path d="M470 112 C515 112 515 188 565 188"/>
  </g>
  <g font-family="Inter,system-ui,sans-serif" text-anchor="middle">
    <rect x="24" y="76" width="166" height="72" rx="14" fill="#a3e635" opacity=".18" stroke="#a3e635"/>
    <text x="107" y="106" font-size="16" font-weight="700">Agent stops</text><text x="107" y="129" font-size="13">completion wording</text>
    <rect x="300" y="76" width="170" height="72" rx="14" fill="#f59e0b" opacity=".16" stroke="#f59e0b"/>
    <text x="385" y="106" font-size="16" font-weight="700">Hook blocks</text><text x="385" y="129" font-size="13">390 logical events</text>
    <rect x="565" y="8" width="224" height="60" rx="14" fill="#22c55e" opacity=".15" stroke="#22c55e"/>
    <text x="677" y="34" font-size="15" font-weight="700">Acts with tools</text><text x="677" y="54" font-size="13">327</text>
    <rect x="565" y="82" width="224" height="60" rx="14" fill="#60a5fa" opacity=".15" stroke="#60a5fa"/>
    <text x="677" y="108" font-size="15" font-weight="700">Pushes back</text><text x="677" y="128" font-size="13">25</text>
    <rect x="565" y="158" width="224" height="60" rx="14" fill="#ef4444" opacity=".14" stroke="#ef4444"/>
    <text x="677" y="184" font-size="15" font-weight="700">Repeats before user</text><text x="677" y="204" font-size="13">99</text>
  </g>
</svg>
<figcaption>Observed response paths. Counts describe association after a gate, not proof that the gate caused the eventual action.</figcaption>
</figure>

## Findings

## Scorecard

| Measure | Result |
|---|---:|
| Raw feedback records | 443 |
| Logical interventions | 390 |
| Duplicate records removed | 53 |
| Sessions with an intervention | 167 |
| Repeated before the next genuine user turn | 99 |
| Automated delivery-context mismatch candidates | 22 |
| Manually confirmed misfires among objection/unclear reactions | 25 / 28 |

### Gate distribution

| Gate | Logical interventions |
|---|---:|
| open-pr | 220 |
| delivery | 101 |
| handback | 39 |
| self-audit | 28 |
| swarm | 2 |

### Agent reaction

| Reaction | Logical interventions |
|---|---:|
| productive-action | 318 |
| blocker-or-handoff | 29 |
| substantiated-pushback | 13 |
| unsupported-pushback | 12 |
| verbal-compliance | 12 |
| no-assistant-reaction | 3 |
| other | 3 |

“Productive action” means at least one tool call followed the intervention before the next genuine user message. “Substantiated pushback” means the agent disputed the gate and cited a URL, screenshot, metric, test, or verification result. Tool activity and immediate reaction are independent: an agent can object first and then keep working.

## What the objections showed

The 25 confirmed misfires clustered into five concrete patterns:

| Pattern | What the hook got wrong |
|---|---|
| Browser/external-app work | Completion wording inside a Git cwd became a supposed code delivery with a missing PR, docs, and CHANGELOG. |
| Diagnostic or research answers | A verified read-only finding was treated as a shipped change. |
| Ticket/spec creation | Open implementation tickets were the requested deliverable, but the gate demanded that they be closed. |
| Review-only sessions | Reading or commenting on another author's PR was treated as ownership of its merge. |
| Unrelated ticket mentions | Ticket IDs cited as context were treated as this session's unfinished delivery. |

The three useful prompts asked for an explicit PR owner or a complete goal-by-goal audit. They did not rely on the false assumption that a browser or research task had produced code.

## The browser-only failure

The delivery chain is entered whenever the final message matches a generic completion phrase. It does not require a PR or Git delivery command. Once entered, the helper falls back to the terminal's current Git repository and classifies the original request with broad words such as “new,” “feature,” “API,” or “behavior.” A browser task can therefore become a supposed code delivery solely because the shell was opened inside a repository.

The supplied Lovable session demonstrates the full failure **three times**. The agent first submitted the prompt, then verified the finished app with a live screenshot and concrete imported-record counts, and later completed another browser-only submission. Each stop produced the same demand for docs and a CHANGELOG “in the PR,” even though the session changed no files and opened no PR.

## Evidence

## Harness coverage

| Harness | Sessions inspected | Observable blocking interventions |
|---|---:|---:|
| antigravity | 5 | 0 |
| claude | 1,242 | 390 |
| codex | 82 | 0 |
| cursor | 48 | 0 |
| droid | 20 | 0 |
| grok | 18 | 0 |
| kimi | 49 | 0 |
| muse | 1 | 0 |
| opencode | 1 | 0 |

<div class="artifact-callout"><strong>Coverage limit.</strong> Claude persists blocking Stop-hook feedback in transcripts. Codex and most other harnesses currently do not persist equivalent hook-firing records, so zero observable interventions is not evidence that the hook never ran.</div>

## Installation audit

The canonical source is **gh:phnx-labs/.agents-system**. Manifest registration and the central script are present.

| Harness | Active copy | Native registrations | Managed copies matching central source |
|---|---|---:|---:|
| claude | present | 1 | 10 / 10 |
| codex | present | 1 | 2 / 2 |

This separates “installed” from “observable”: Codex has a native Stop registration, but its transcript format does not retain the feedback needed to reconstruct reactions.

## Recommendations

1. Require delivery evidence before running code-delivery checks: a responsible PR, repository mutation, or explicit ship/release request. Generic “done” wording alone is insufficient.
2. Keep outcome-evidence coaching separate from docs/CHANGELOG enforcement. Browser and external-app work can require screenshots or live verification without inventing a PR.
3. Stop treating any mentioned ticket or reviewed PR as owned work. Attribute responsibility from write/author actions and the active goal.
4. Emit structured hook telemetry with hook name, gate, goal key, attempt number, and result for every harness. Transcript prose should not be the only measurement source.
5. Treat repeated substantiated pushback as a classifier defect signal. Re-running the same instruction after the agent proves the gate is out of context adds cost without improving completion.

## Reproduce

```bash
bun .agents/reports/analyze-verify-work-complete.ts \
  --since 7d \
  --json-out /tmp/verify-work-complete-events-2026-08-07.json \
  --markdown-out /tmp/verify-work-complete-effectiveness-2026-08-07.md
```

The detailed JSON is local and redacted. It contains bounded context windows for review and must not be committed or published because session transcripts are confidential.
