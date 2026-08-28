---
kind: report
title: CLI command-surface simplification — what landed, what's left
summary: Two plans drove the "simplify the agents CLI surface" work. The RUSH-2981 leftovers plan (apply / beta / feedback / harness) is fully merged and verified in the live 1.22.54 surface; the broader cli-surface-consolidate wave that preceded it also landed. This report reconciles both against the shipped code.
status: final
links:
  - https://linear.app/getrush/issue/RUSH-2981
  - https://linear.app/getrush/issue/RUSH-2965
---

## Summary

Two plans drove the "simplify the `agents` CLI surface" work you remember. The
**RUSH-2981 leftovers plan** (`apply` / `beta` / `feedback` / `harness`) is
**fully merged and live** in the `1.22.54` CLI you're running. It rode on top of
a larger, also-landed **cli-surface-consolidate** wave (~12 tickets) that nested
or removed the bulk of the non-noun root verbs. A third look-alike artifact is a
*different* track (perf/analytics), not surface work. The only open items are two
small follow-ups the leftovers plan itself flagged as out-of-scope. Below:
what each plan was, what shipped (with commit evidence), and why the approach is
sound.

## Findings

You had agents working on **simplifying the `agents` CLI command surface** and
they showed you plans. There were really two distinct threads, and one look-alike
that is a different track:

| Artifact | Ticket(s) | What it is | Status |
|---|---|---|---|
| `2026-08-20/plan-cli-surface-leftovers.md` | RUSH-2981 | The tail-end plan: four leftover top-level groups — `apply`, `beta`, `feedback`, `harness` | **Fully landed** (commit `2aaf8573a`, 2026-08-21) |
| `2026-08-03/agents-cli-surface.md` + the `cli-surface-consolidate` branch | RUSH-2579/2580/2581/2692/2864/2932/2984/2989/3001/3079 + 2965 | The survey that dumped all 76 top-level groups, then a wave of PRs that nested/retired the non-noun ones | **Landed** (merged across PR #2621 and follow-ons) |
| `2026-08-03/plan-agents-cli-review.html` | (12 tracks) | **Different track** — 12 perf / sync / session-analytics fixes from a review. Not command-surface work. | Out of scope here |

The load-bearing rule behind all of it (stated in `command-registry.ts`): **the
CLI navigates by noun then action.** A free-standing top-level *verb* (`apply`,
`set`, `share`, `login`) is a leftover, not a noun. Retiring it — and adding the
name to `RETIRED_TOP_LEVEL_COMMANDS` so the spellchecker returns *"unknown
command"* instead of silently auto-correcting `apply` → `add` — is the whole game.

## The surface, before and after

<figure class="artifact-figure artifact-figure-wide">
  <svg viewBox="0 0 900 220" role="img" aria-label="Top-level group count fell from 76 to 69 while total command count held flat">
    <text x="20" y="28" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="14">Top-level groups shrank; behavior did not — retired verbs moved under their noun, they were not deleted.</text>
    <rect x="40" y="60" width="360" height="52" rx="6" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
    <text x="56" y="92" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="16">76 groups · 564 commands</text>
    <text x="56" y="130" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="12">2026-08-20 — as measured in the leftovers plan</text>
    <text x="430" y="92" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="18">→</text>
    <rect x="470" y="60" width="360" height="52" rx="6" fill="#0e1a12" stroke="#22c55e" stroke-width="1.5"/>
    <text x="486" y="92" fill="#22c55e" font-family="JetBrains Mono, monospace" font-size="16">69 groups · 570 commands</text>
    <text x="486" y="130" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="12">2026-08-28 — live in installed 1.22.54</text>
    <text x="40" y="180" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="12">42 names now sit in RETIRED_TOP_LEVEL_COMMANDS. The command total is flat because a retired root</text>
    <text x="40" y="200" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="12">(e.g. `apply`) re-homes to a nested address (`devices apply`) — the sidebar shrinks, the capability stays.</text>
  </svg>
  <figcaption><b>Figure 1.</b> 7 groups off the root since the leftovers plan was written; the growing <code>RETIRED_TOP_LEVEL_COMMANDS</code> set is the accumulated result of the whole arc.</figcaption>
</figure>

## RUSH-2981 leftovers plan — four verdicts, all shipped

The plan asked for four decisions and then to land them. Every one is now live —
verified against the installed `1.22.54` surface (`agents … --help`) and the
source:

| Group | Plan verdict | Shipped state (verified) |
|---|---|---|
| `apply` | Retire the top-level ghost; keep `fleet apply` / `devices apply`. Do **not** rename to `onboard`. | `apply` ∈ `RETIRED_TOP_LEVEL_COMMANDS`; `devices apply` present (27-verb `devices` group). Top-level `agents apply` → unknown command. |
| `beta` | Nest under `setup` (not `config`, not `update`). | `agents setup beta {list,enable,disable}` — `beta.ts` registers under `setup`; `beta` retired at root. |
| `feedback` | Keep as a root leaf — cheap to find, not worth nesting. | Still a top-level 0-child leaf. Unchanged, as decided. |
| `harness` | Shrink: drop `login` / `logout` (credentials live on `accounts`). Do **not** invent a top-level `create`. | `harness` now has 7 verbs — `add edit fork list remove rename view`. `login`/`logout` gone. No `create` verb was added. |

All three code changes shipped in one squashed, breaking commit:

```text
2aaf8573a  feat(cli)!: nest beta under setup; retire apply; drop harness login/logout
           RUSH-2981 · merged to main 2026-08-21
           README, docs/command-reference, apply.ts, beta.ts, harness.ts,
           setup.ts, command-registry.ts, + tests + .changelog/next/RUSH-2981.md
```

<aside class="artifact-callout"><strong>Why this makes sense:</strong> the plan's
sharpest finding was that <code>apply</code> was never dead — it is
<code>fleet apply</code>, and it printed "No target devices" only because this
box's <code>fleet.devices</code> map is empty. So the fix was to delete the
duplicate <em>root</em> spelling and leave the working nested one, not to rename
or rebuild anything. That is the difference between a surface cleanup and a
behavior change.</aside>

## The wider wave that came first (cli-surface-consolidate)

Before the leftovers, a larger pass nested or removed the bulk of the non-noun
roots. These are all merged and reflected in the retired-set docblock:

| Change | Ticket | Result |
|---|---|---|
| `set` → `models` / `config` defaults | RUSH-2579 | root `set` retired |
| `share` → `artifacts share` | RUSH-2580 | root `share` retired |
| `auth` / `org` + plan-tier gates removed; `auth` returned against Phoenix ID | RUSH-2581 | Prix-coupled account layer gone |
| `timeline` (pure alias of `feed --filter updates`) | RUSH-2692 | removed |
| `status` → `sync status` | RUSH-2864 | root `status` retired |
| `tickets` removed → use `linear` | RUSH-2932 | removed |
| `alias` → `setup alias` | RUSH-2965 | the precedent the leftovers plan copied |
| `inbox` (alias of `feed`) | RUSH-2984 | removed |
| `unshare`/`audit`/`trends` nested | RUSH-2989 | `artifacts unshare`, `events audit`, `insights mix/trends` |
| `serve` (+ iOS Cockpit anchor) | RUSH-3001 | removed |
| `usage` → folded into `agents view` | RUSH-3079 | root `usage` retired |
| `lock`/`helper`/`wallet`/`hosts`/`publish`/`whoami`; `webhook`→`webhooks` | #2609 | consolidated |

## What's left

The **leftovers plan itself is 100% complete** — nothing is outstanding on
RUSH-2981. Two honest loose ends remain around it:

1. **The empty-`fleet.devices` no-op.** The plan explicitly deferred this as
   "separate from surface work": `agents fleet apply` still prints a quiet *"No
   target devices — nothing to apply"* when the roster is `{}`, rather than an
   actionable *"fleet.devices is empty — set devices: all or name boxes."* That
   is a UX follow-up, not part of the nesting.
2. **Companion `.agents-system` audit.** The same RUSH-2965 pattern requires
   checking that no hook/skill/rule in the companion repo still teaches
   `agents apply` or `agents beta`. Worth a quick grep-and-fix pass.

Beyond RUSH-2981, the root still carries a handful of verb-shaped groups a future
pass *could* revisit (`add`, `import`, `install`, `open`, `route`, `send`, `use`)
— but none of these were in scope for the plans you were shown, and several
(`add`, `run`, `view`, `list`, `search`) are legitimately top-level verbs by the
CLI's own rule. No committed follow-on plan proposes touching them, so treat this
as "surface is in the intended shape," not "work stalled."

## Evidence

Everything above is grounded in the shipped code and the live surface, not the
plan text:

- **Merged commit:** `git merge-base --is-ancestor 2aaf8573a main` → true.
  `2aaf8573a feat(cli)!: nest beta under setup; retire apply; drop harness
  login/logout` (RUSH-2981), authored 2026-08-21, touches `apply.ts`, `beta.ts`,
  `harness.ts`, `setup.ts`, `command-registry.ts`, docs, and tests.
- **Retired set:** `RETIRED_TOP_LEVEL_COMMANDS` in
  `cli/src/lib/startup/command-registry.ts` contains 42 names including `apply`,
  `beta`, `usage`, `org`, `login`, `logout`, `set`, `share`, `timeline`,
  `status`, `tickets`, `alias`, `inbox`, `unshare`, `audit`, `trends`, `serve`.
- **Live surface (installed 1.22.54):** `harness` = `add edit fork list remove
  rename view` (no login/logout); `setup` includes `beta` and `alias`;
  `feedback` is a 0-child leaf; `devices` includes `apply`. Top-level `apply` /
  `beta` resolve to unknown command.
- **Counts:** `cli/docs/command-index.json` → 69 groups / 570 commands (was
  76 / 564 in the 2026-08-20 plan).
- **Wave commits:** `9cb7eb25d` (RUSH-3079 usage), `0882c3644` (RUSH-2581
  org/auth), `c37348fa1` (RUSH-2580 share→artifacts), `06edef682` (RUSH-2579
  set), `a5c310e41` (RUSH-2692 timeline), `d784278ef` (RUSH-2989), merge
  `5a441d0da` (PR #2621 cli-surface-consolidate).

## Bottom line

- The plan you remember (`plan-cli-surface-leftovers`, RUSH-2981) **shipped in
  full** and is verifiable in the CLI you're running right now.
- It rode on top of a larger, also-landed consolidation wave — so the "two or
  three agents" you recall were working the same arc across ~12 tickets.
- The one look-alike (`plan-agents-cli-review`) is a **separate** perf/analytics
  review, not surface work.
- The only genuinely open items are two small follow-ups the leftovers plan
  itself flagged as out-of-scope, not unfinished surface work.
