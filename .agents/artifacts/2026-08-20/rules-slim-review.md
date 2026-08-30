---
kind: report
title: Rules & Hooks Simplification — Before / After Review
summary: The rules corpus drops from 25,735 to 10,338 words (−60%) with every hard rule, recipe, and guard kept; hook stop-gate messages shrink ~60% with identical logic. Drafted on slim-rules branches, nothing live until you approve.
---


## Summary

Nothing is live. The rule rewrites sit on `slim-rules` branches in both repos
(no PRs opened); the hook-message edits are drafted below and **not yet
applied**. This document is what you review before anything lands.

## The goal, in your words

Prevent agents from cutting corners; when assigned a task they finish it
end-to-end; they often don't realize they have tools — make them more agentic.
The rules already say this — the problem is that ~25,700 words and 40-line hook
lectures bury it.

## Findings

| | Before | After | Cut |
|---|---|---|---|
| System layer (20 subrules, ships to every agent) | 14,695 words (91 KB) | 6,242 words (40 KB) | −58% |
| User layer (21 → 18 subrules) | 11,040 words | 4,096 words | −63% |
| **Total injected into every session** | **25,735 words (~34k tokens)** | **10,338 words (~14k tokens)** | **−60%** |

## The editing rule applied to every file

**Kept, verbatim where it matters:** every hard rule and ban, every command
recipe (worktree recipe, teams pattern, probe commands), every guard/hook name,
every non-derivable gotcha (codex can't write on this fleet; `--device ps`
reconciliation; GraphQL vs REST budgets; `~`/`$HOME` remote expansion), and the
verbatim teammate-brief contract lines.

**Cut:** re-derivations of F1–F5 inside tactic files, measured-incident essays
(session IDs, dates, quoted correction transcripts — each compressed to at most
one parenthetical), hook-implementation narration (the guard's behavior in two
lines instead of twenty), duplicate coverage (remote dispatch was explained in
5 files), and marketing-register emphasis (most bolding, "this is the single
most expensive failure…" framing).

**Untouched:** `feed-status-posts` + `ui-work-discipline` (system copies,
already lean), `stack.md`, all guard *scripts* and their tests.

**Added after your notes — `/tmp` is banned for agent output:** new
`operational` bullet — everything an agent produces lands in the repo's
`.agents/` workspace (`.agents/scratch/` for working files, screenshots,
one-shot scripts; `.agents/artifacts/yyyy-mm-dd/` for durable outputs), because
`/tmp` gets wiped and you go back to this data. Every `/tmp` example in the
rules (clip fetches, browser screenshots, handoff scripts) now points at
`.agents/scratch/`.

**Added after your notes — no metaphor vocabulary ("gate", "rails"):** gone from all
rule prose ("branch protection or review requirements", not "rails") ("design approval", "two checks", "hard denials", "never block one
on the other"), and the hook messages lose it in the hooks PR (above).

**Added after your notes — state obligations positively:** never name a
mechanism that doesn't exist ("there is no release train" plants the concept it
bans). Say what the agent owes — own the feature to live, steer your spawned
agents, finish the chain — and leave the failure modes unnamed. (Guard scripts
may still *detect* stand-down phrases; detection isn't teaching.)

## Consolidations (user layer)

| Merged away | Into | Why |
|---|---|---|
| `distributed-teams` (371 w) | `dispatch-ops` | Same topic: where teammates run; zion-is-interactive |
| `remote-dispatch-and-mutation-safety` (537 w) | `dispatch-ops` | Same topic: remote paths, `git -C`, escalations |
| `deployment-and-waiting` (76 w) | `demonstrate-on-ship` | One health-check rule, same F3 point |

The merged `dispatch-ops` (592 w) covers everything the three files did in a
third of the space. No dangling references remain in either repo.

## Evidence

One rule before / after, in full flavor:

**`release-to-fleet.md`, opening (before, 1,215 words total):**

> **There is no release train. Nothing ships your merge for you.** Do not wait
> for a scheduled releaser, do not tell the user "it ships on the next train",
> and do not treat a `release-train`-shaped routine as a reason to stop at
> merged. Every such mechanism tried on this fleet has been a **silent no-op**
> (defined, listed, and never fired) — worse than no mechanism at all, because
> it converts "nobody shipped this" into "someone else will."
>
> That leaves exactly two honest end states: … *(continues for ~900 more words,
> including the banned-phrases list, the 2026-08-15 sessions, the 2026-08-02
> collision, and a restatement of F1/F3)*

**After (revised per your note — positive framing, ~340 words total):**

> When you implement a feature you own it to live: **merge → publish → tag →
> upgrade every reachable host → verify the installed version carries it.**
> Report "merged; not released — \<who\> owns releasing" only when the user
> explicitly named someone else for the release.
>
> Spawning agents does not transfer this ownership. Check on agents you spawned
> on a bounded timer, steer them, resume ones that paused prematurely, resolve
> their conflicts — and when they don't finish the chain, finish it yourself.

No "release train" anywhere — a mechanism never mentioned can't be assumed to
exist. The same spawned-agents ownership line is added to F1 in foundations.

The 6-step chain, the lease mechanics, and the "status question ≠ go-signal"
rule all survive below that — just without the essays between them.

## Every subrule, traced to the goal

The goal: agents finish assigned work end-to-end, know they have tools, and
don't burn your time. Each rule below in one line — what it commands, and how
that makes agents more agentic. `sys`/`usr` = layer; numbers = words
before→after.

### Finish the task end-to-end (the core)

| Rule | What it commands → why it makes agents agentic |
|---|---|
| foundations F1+F3 `sys` (in 2,414→1,088) | Own the lifecycle through merge-ship-verify; four legitimate stops, everything else banned; done = the verified outcome. The spine — everything else is tactics for it. |
| truly-agentic-git-workflow `sys` 2,838→898 | Worktree → PR → drive CI + review → merge yourself. Kills "I opened the PR, you review and merge it". |
| gh-merge-guard `sys` 420→196 | Merge on green with a non-author review; never bypass branch protection. Lets agents merge *without you* while keeping review real. |
| release-to-fleet `usr` 1,215→~360 | Own the feature to live: publish → tag → fleet upgrade → verify installed. Kills "it'll go out in the next release". |
| parallel-teams `sys` 1,827→696 | You own what you spawn: confirm spawns, steer on a timer, verify the cross-track seam. Delegation without abandonment. |
| unattended-verification `sys` 1,046→382 | Exit 0 is not evidence — assert a checkable postcondition. Unwatched work still finishes or says it didn't. |
| demonstrate-on-ship `usr` 395→250 | Drive the deployed thing and show it. "Done" claims become demonstrations. |
| own-the-request-through-build `usr` 297→123 | A plan is a step; a sibling session is coordinate-and-continue. The request stays owned. |
| session-handoff-summary `usr` 1,077→~350 | Close tickets, file follow-ups, then a zero-context recap (no bare "#1709" — say what it was + link). The loop actually closes. |
| task-checklists `sys` 349→149 | The checklist is the acceptance rubric — done means every item. Keeps long work honest. |

### Know and use your tools

| Rule | What it commands → why |
|---|---|
| foundations F2 `sys` | Three real attempts before any blocker; orient yourself from prior sessions/repo/web instead of asking; third identical failure = change approach. |
| exhaust-self-serve `usr` 1,169→399 | The concrete probe playbook (secrets, profiles, capabilities, clipboard). Turns "I'm blocked" into one more probe. |
| tech-stack + context-query-mq `sys` 650→324 | The tool map (mq, tickets, browser, pty, teams, secrets) — agents can't reach for tools they don't know exist. |
| fleet-delegation `sys` 300→147 | Spread across harnesses/accounts; subagents from message one. The fleet is a tool too. |
| remote-fleet-dispatch `sys` 1,221→412 + dispatch-ops `usr` 1,987→592 | Dispatch to other boxes correctly (probe the real operation, bound every wait). Multiplies one agent into many, without silent failures. |
| clip-references `usr` 159→95 | `host:/path` tokens are real files — fetch them. Mechanics, small and necessary. |

### Don't burn the operator's time

| Rule | What it commands → why |
|---|---|
| foundations F4 `sys` | Land handoffs on your device; lead with the outcome; (proposed) execute the next step instead of describing it. |
| notify-owner + feed-status-posts `usr` 1,783→535 | Record milestones to the feed, phone only for delivery/blocked, 1–4 lines. Signal reaches you; noise doesn't. |
| no-telegram `usr` 340→148 | Absolute channel ban — honored without being re-litigated. |
| github-api-rate-limits `usr` 306→166 | Budget shared quotas so one agent's polling doesn't take down the fleet's GitHub access. |
| plan-presentation `sys` 1,276→371 + ui-work-discipline `usr` 697→289 | Plans and UI shown rendered, behavior-first — you review by looking, not by reading mechanism. |
| research-discipline `sys` 378→183 | Claims carry file:line proof; no human-time estimates. You can trust reports without re-checking them. |

### Protect what can't be undone

| Rule | What it commands → why |
|---|---|
| foundations F5 `sys` | Untouchable primary tree, no destructive git, no rail bypass, confidential transcripts, surface escalations first. Autonomy stays safe enough to grant. |
| operational `sys` 678→332 | The small bans (no env-var config, no stray .md files, persist permissions) that keep autonomy from making a mess. |
| watchdog-disabled + skill-authorship-restraint `usr` 742→341 | Don't rebuild the token-burning daemon; don't paper over competence with narrow skills. Guardrails on the meta-level. |
| code-quality + testing-strict `sys` 289→194 | No fallbacks, no mocks, tests that catch real bugs — autonomous code that doesn't rot. |
| no-pr-footer `sys` 84→68 | Cosmetic ban, mechanically enforced; two lines is all it needs. |

Housekeeping that traces weakly to the goal (kept because cheap, flagged for
your call): `conventions` 191→98, `agents-cli` 77→53, `stack` 84, `rush`
123→67, `plan-artifacts-and-tickets` 478→145, `automated-pr-review` (delete —
redundant).

## Hooks — proposed, not yet applied

The detection logic and fire-once semantics stay identical; the injected text
shrinks ~60%, and per your directive the word "gate" disappears from every
message an agent reads — these are instructions, not gates. Renaming the
"STOP GATE (…)" prefixes also means updating the marker substrings in
`gate-outcome-backfill.py` (it will match old and new markers so history still
scores), the `prior_fires` anchors, and the test fixtures — all in the same
hooks PR.

**The open-PR stop message (your first screenshot) — before, ~30 lines** of
four paragraph-length options plus a 7-line "NOTE" ramp on repeat fires.
**After, ~10 lines:**

```
STOP — this session created or worked pull request(s) that are still OPEN:

<urls>
An open PR is not done — merged-or-handed-off is. Do ONE of:
1. Keep driving: arm a durable watcher (ScheduleWakeup/Monitor, or
   `agents monitors enable pr-merge-on-green`) and merge on green. A backgrounded
   `gh pr checks --watch` dies with a headless agent. Don't hand the user the link.
2. Non-author review: wait for the configured bot if it's posting; otherwise
   spawn a non-author subagent review now.
3. Hand off EXPLICITLY: name who or what now owns the PR. "Needs you to merge"
   is not a handoff.
4. Genuinely blocked: "blocked on <what>" + the durable process or user-only
   action ("your Touch ID") that finishes it.
```

**Repeat-fire note — before 6 lines, after 3:**

```
NOTE — this is the Nth time this stop was blocked for <item>. The same
approach is not working: change tactics — unblock yourself, advance another
in-scope item, coordinate ownership, or escalate a genuinely human-only step.
```

Equivalent trims drafted for the swarm, handback, keep-moving, and done-claim
messages (each ~60% shorter, same clearing conditions), and for the advisory
nudges — the `mq` read nudge, the visual read-back nudge (whose own text still
points at `/tmp` and will point at `.agents/scratch/`), and the worktree-law
reminder.

## The rigidity finding (your second screenshot)

Agents write ritual sentences like *"Delivery loop is closed, with live
evidence probed just now"* because the delivery gate's message says "the loop
is not closed" and several gates clear on **exact phrases** ("will merge on
green", "needs your Touch ID", "blocked on X"). The incantation becomes the
goal instead of the evidence. Options:

1. **Reword messages to ask for evidence, keep phrase-matching as-is**
   (cheapest; drafted above — messages now name the evidence, not a slogan).
2. **Replace phrase-gated escapes with evidence-pattern checks** — clear the
   gate on a quoted URL / command output / live-probe pattern instead of magic
   words (the argue-past gate already works this way; medium effort, in the
   hook scripts).
3. **Both** — reword now, migrate the phrase gates to evidence patterns as a
   follow-up ticket.

Recommendation: **3** — apply the rewording in this pass, file the
evidence-pattern migration as its own ticket so the scripts change under tests.

## Overlap between the system and user layers

Post-slim, checked pair by pair:

| Pair | Kind | State after slim | Recommendation |
|---|---|---|---|
| `feed-status-posts` (user 241 w / system 384 w) | **Same-name shadow** — user copy fully replaces system's on your fleet; the system copy only renders on a box without your user repo | Two copies to maintain, one dead on your machines | Fold your fleet specifics (`--session` from orchestrator shells, blocked-post register) into the **system** copy and delete the user shadow — one source |
| `ui-work-discipline` (user 289 w / system 273 w) | Same-name shadow | Same situation | Same fold-down — the only personal line ("Muqsit reviews behavior, not implementation") moves to `stack.md` |
| `automated-pr-review` (user 109 w) | Topic overlap | The slim system `gh-merge-guard` + git-workflow now carry the same content **including** `.github/rush.yml`/`prix-cloud` | **Delete** — fully redundant |
| `dispatch-ops` (user) vs `remote-fleet-dispatch` + `unattended-verification` (system) | Topic overlap | Deliberate layering (system = mechanics, user = fleet ops); ~80 residual words of repeated probe/monitoring advice | Trim the residue from the user file |
| `exhaust-self-serve` (user) vs F2 | Deliberate | F2 states the principle in 6 lines and points here for the playbook | Keep |
| `release-to-fleet`, `demonstrate-on-ship` (user) vs F3 | Deliberate | F3 has one line each; user files carry the chains | Keep |
| `own-the-request-through-build` (user 123 w) | Partial | F1 covers "a plan is not a handoff"; this adds only the sibling-session rule | Optional: shrink to that one rule (~60 w) |

Applying the recommendations removes 3 more user files and ~700 words from
what your machines compose, and leaves exactly one home per rule.

## The chatting finding (your third screenshot) — applied

An agent wrote a multi-paragraph merge-policy essay plus a recap instead of
merging or asking the one-line question. The foundations opener now states the
role outright: *your job is to get the work done, not to discuss it — don't go
back and forth in the chat window; if the next step is executable, execute it
instead of describing it.* The lifecycle chain also now reads
"test → **verify end-to-end** → … → merge → ship → **verify the live artifact
again**" so verification is explicitly before merge AND after ship, not
after-ship only.

(Your screenshot also showed `/work:loop` itself telling agents to stop at "PR
open" — reported fixed in that session; I'll verify that skill's current text
before the PRs open.)

## Why the delivery gate surfaces the wrong tickets

`verify-delivery-chain.py` collects "this session's tickets" by regexing
`RUSH-\d+` out of the branch name, the **first user messages**, commit
messages, PR title/body/branch, and `linear update` commands. Harness noise is
filtered, but *mention* counts as *ownership*: a ticket named in passing in
your prompt, or a "Related: RUSH-XXXX" line in a PR body (it scans
`closes|fixes|related|relates to|blocked by|unblocks`), gets gated as "still
needs state + proof" — pre-existing backlog items the session never touched
(same class as RUSH-2942). Proposed fix for the hooks PR: tickets = **write
engagement only** — `linear update` commands, the branch name, and
`closes/fixes` in the session's own PRs; bare mentions in prompts, commits,
and "related" context lines stop counting.

## What the friction data says about emphasis

`agents insights --since 30d` (926 sessions, Friction + Dissatisfaction +
Automatable-repeats sections; `agents friction` doesn't exist as its own
command — it's this report's Friction block):

| Signal (30d) | Count | Rule it points at | Verdict |
|---|---|---|---|
| Silent stalls ≥5m (194 of them 1h+) | 781 | F1 self-drive + keep-moving stop gate | **Emphasize more** — the #1 cost. Gates keep full strength; only their text shrinks. |
| "continue / keep going" + resume nudges | 477 + 161 | F1 "never idle" | Same — foundations keeps this as its opening claim. |
| "did you merge?" + PR-babysitting repeats | 324 + 5,521 | PR-open-is-not-done, merge-on-green | **Emphasize more** — survives whole in the slim git-workflow file. |
| Approval repeated (same permission re-prompted) | 258 | operational "add permissions once" | **Emphasize more** — currently one buried bullet; promote to "when a prompt is granted, persist it to settings in the same session". |
| Failed Bash loops / Command Failed | 833 / 2,468 | exhaust-self-serve "change approach after 2–3 identical failures" | **Promote into F2** as one line — it's the observed thrash mode. |
| Ask-stall on release/ship/deploy | 101 | release-to-fleet | Kept emphatic in the rewrite. |
| Merge conflicts / CI red loops | 13 / 6 | the long reconcile + CI essays | **Emphasize less** — near-zero incidence; the slim versions already match reality. |
| Blocked guard fires | 208 | guard-narration prose | **Emphasize less** — the guards teach at block time; prose re-explaining them is redundant (already cut). |

Two findings that are product work, not rule prose: the top automatable repeats
(fleet file transfer 5,870 · PR babysitting 5,521 · git reconcile 1,576 ·
secrets unlock 1,351 · release recipe 956) map to CLI features
(RUSH-2298 `agents git reconcile`, the `pr-merge-on-green` monitor /
RUSH-2848), and `agents sessions stats` shows 85 installed commands never
invoked — a separate dead-weight cleanup.

**Emphasis edits I'd apply on your OK (on top of the slim drafts):** the F2
change-approach line, the strengthened persist-permissions bullet, and nothing
else — every other high-friction rule is already front and center in the
rewrite.

## What happens on your OK

1. Apply the drafted hook-message trims (same branch, `.agents-system`), run
   the hook test suites.
2. Open both PRs; non-author review; merge on green.
3. `agents sync` so every session composes the slim ruleset; verify the
   compiled `CLAUDE.md` lands at ~14k tokens.

Anything above you want cut differently — a file that should keep its long
form, a merge you don't want, harder cuts — say which and I'll adjust before
any PR opens.
