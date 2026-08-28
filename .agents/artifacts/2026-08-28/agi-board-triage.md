---
kind: report
title: AGI board triage — 95 open, 9 closed with proof, rule tightened
summary: Verified all 95 open AGI-project tickets against current code and merged PRs with 7 parallel agents. Closed 9 provably-done with proof. The board's real problem is inflation from noticed-in-passing filing (48 of 95 opened in 3 days), not literal duplicates — so the durable fix is the consolidate-over-create rule, not mass-cancellation.
header: Phoenix Labs / agents-cli
footer: AGI board triage — 2026-08-28
status: complete
date: "2026-08-28"
facts:
  - "95 open at start (48 opened in the last 3 days)"
  - "9 closed with hard proof"
  - "1 held for owner release call (PHNX-3392)"
  - "8 decisions surfaced (owner call)"
  - "Rule: consolidate-over-create (PR on .agents-system)"
links:
  - url: https://linear.app/getrush/project/AGI
    label: AGI project
---

## Summary

You asked me to check the board myself, close what's already done, and fix the rule
that lets agents keep minting tickets instead of consolidating. I did all three.

**The board is real and busy: 95 open, and 48 of them (half) were opened in the last
three days.** That growth rate — not literal duplicates — is the problem. I fanned 7
agents across the whole board, each verifying its slice against current code and merged
PRs at `file:line`. The honest result: most of the 95 are **distinct, genuinely-open
real bugs**, not spam-duplicates. So the right move was to close what's provably done
(9), surface what needs your decision (8), and fix the rule so the board stops inflating
— not to manufacture consolidations that aren't real.

## Findings

I fanned 7 agents across all 95 open tickets. Each verified its slice against
`origin/main` and merged PRs at `file:line`. Outcome: **9 provably done** (closed this
pass), **1 held for your release call**, **8 blocked on your decision**, and the rest —
~76 — **verified genuinely open, distinct real work**. Literal duplicates were rare;
the board inflates from noticed-in-passing filing, not copies of one problem.

## Evidence

**Closed this pass (9), each with proof:**

| Ticket | Was | Proof |
| --- | --- | --- |
| **PHNX-3405** | Todo | PR #3229 merged — `markFleetRemote` forwards actor across the ssh browser-drive seam |
| **PHNX-3288** | In Review | PR muqsitnawaz/agents#1836 merged — nanoid 3.3.18 across 12 lockfiles; CVE-2026-67213 cleared |
| **PHNX-2942** | Todo | `verify-delivery-chain.py:248-290` counts write-engagement only; landed .agents #374 |
| **PHNX-3188** | Todo | `isDirectoryDoc()` (resources.ts:160) stops treating dir READMEs/AGENTS.md as slash commands; landed 7a9f57fc0 |
| **PHNX-2148** | Doing | `release.sh:20-40` replaced the CI-wait-on-head-sha merge with exact-tree attestation — stale-head merge can't occur |
| **PHNX-2243** | Doing | `codex-policy.ts` implements the canonical safe-writable policy, consumed by exec.ts + codex adapter |
| **PHNX-2730** | Doing | `tests.yml` Windows job is now a scoped smoke + continue-on-error on push-to-main, not a full unsharded required suite |
| **PHNX-3240** | Todo | `test.sh` `die()`=exit 1 fixes the exit-0 fall-through; cli/AGENTS.md documents the `agents≥1.22.49` requirement |
| **PHNX-2496** | Todo | Flaky slot-release test removed — RUSH-2640 flipped semantics so a failed record releases the slot |

Board: **95 → 86 open.**

## Held — yours to close (1)

- **PHNX-3392** (device roles + per-account usage sync) — all three PRs (#3214, #3217,
  #3233) are **merged to main**; your own comment leaves it In Review pending a fleet
  **release** ("Release is the owner's decision"). Code is done; the release call is
  yours, so I left the state alone.

## Decisions surfaced — need your call (8, left open)

These are blocked on a product/owner decision, not on engineering. Each states the choice
in its body:

| Ticket | The decision |
| --- | --- |
| **PHNX-3322** | Which of the 4 product names wins (agents-cli / agi-cli / AGI CLI / the binary) |
| **PHNX-3342** | Distribute the OpenRouter/deepseek credential fleet-wide vs keep it zion-only |
| **PHNX-2847** | Go/no-go on splitting the 3 npm-postinstall mutations (plan committed, awaiting call) |
| **PHNX-3323** | Finish the `notify` deprecation vs keep the alias |
| **PHNX-2519** | Whether check-updates should gate on posture (ticket is "directions, not a design") |
| **PHNX-3374** | Turn on Cloudflare Browser-Rendering OG mode (product-gated) |
| **PHNX-3380** | Routines failure-backoff policy (curve / cap / which schedules) |
| **PHNX-3404** | Register `.agents-extras` as an opt-in extra repo (nothing consumes it yet) |

## The rule fix (the durable part)

The ticket-restraint rule already said *claim first, don't file what you merely noticed*
(landed #364). It didn't hold — hence 48 new tickets in 3 days. The gap: it never said
what to do when you **do** have real work that overlaps an existing ticket. Agents open a
parallel near-duplicate instead of improving the one that's there.

PR on `phnx-labs/.agents-system` (branch `ticket-consolidate`) adds the missing half:

- **conventions.md** — *claim first; **enrich before you create**; open one only for work
  you're delivering now.* "Default to NOT creating." Consolidate into the overlapping
  ticket (comment, sharpen, attach evidence); fold duplicates into one canonical ticket
  and cancel the rest.
- **tickets SKILL.md** — an explicit "Enrich before you create" lifecycle step (search
  wider than the exact title), and anti-patterns that name **near-duplicates**.

<div class="artifact-grid artifact-grid-3">
  <article class="artifact-stat">
    <div class="artifact-stat-value">86</div>
    <div class="artifact-stat-label">open after this pass (was 95)</div>
  </article>
  <article class="artifact-stat">
    <div class="artifact-stat-value">48 / 95</div>
    <div class="artifact-stat-label">opened in the last 3 days</div>
  </article>
  <article class="artifact-stat">
    <div class="artifact-stat-value">9</div>
    <div class="artifact-stat-label">closed with hard proof</div>
  </article>
</div>

## Honest notes

- **Duplicates were rare.** Each agent looked for overlap in its slice and found almost
  none — this board is distinct real bugs, not copies of one problem. Closing done work
  and stopping the inflow is the fix; cancelling real tickets to hit a number is not.
- **One stale-Doing left alone:** PHNX-3229 ("clean repo root") is Doing with nothing
  landed, but it's live owner-scoped work — reset it to Todo if it's abandoned.
- **Verification was against `origin/main` + merged PRs**, not this local checkout (which
  is a few merges behind). Every closed ticket cites a merged PR or a `file:line` on main.
