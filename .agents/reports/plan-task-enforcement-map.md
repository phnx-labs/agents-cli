---
kind: report
title: "Plan · Task — What the Hooks & Skills Actually Enforce"
summary: "Every hook, skill, command, and rule in ~/.agents and ~/.agents/.system that governs plan mode, planning, and task-solving — hard-gate vs soft-nudge marked, evidence-backed, with the overlaps that are worth consolidating."
status: research
date: 2026-08-05
kicker: "~/.agents · ~/.agents/.system"
facts:
  - "Trees scanned: user layer + .system layer"
  - "Hard Stop gates: 2 hooks / 7 sub-gates"
  - "Plan-lifecycle hooks: 1 gate · 1 logger · 1 carve-out"
  - "Plan render recipe: stated 3× / referenced 4×"
---

## Summary

Enforcement for three concerns — **plan mode / planning**, **plan presentation**, and **task-solving / checklists** — is scattered across `hooks/*.sh`, `.system/hooks/*.sh`, `.system/rules/subrules/*`, `.system/skills/*`, `.system/plugins/*/skills/*`, and `.system/commands/*`. Some of it is a **hard `exit 2` gate**; most is **prose the model is expected to follow**. This report maps all of it in one place so the overlaps and gaps are visible.

Every behavior is one of two kinds. Telling them apart is the key to consolidating.

<figure>
<svg viewBox="0 0 860 340" role="img" aria-label="Enforcement layers: hard gates versus soft nudges" xmlns="http://www.w3.org/2000/svg" font-family="inherit">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="20" y="20" width="380" height="300" rx="14" fill="#ef444422" stroke="#ef4444" stroke-width="1.5"/>
  <text x="210" y="50" text-anchor="middle" font-size="19" font-weight="700" fill="#ef4444">HARD GATE · exit 2</text>
  <text x="210" y="72" text-anchor="middle" font-size="12.5" fill="#94a3b8">a hook blocks the tool call / the stop</text>
  <g font-size="13" fill="currentColor">
    <rect x="42" y="90" width="336" height="34" rx="8" fill="#0000000f" stroke="#ef444455"/>
    <text x="58" y="112">plan-html-reminder — blocks ExitPlanMode</text>
    <rect x="42" y="132" width="336" height="34" rx="8" fill="#0000000f" stroke="#ef444455"/>
    <text x="58" y="154">verify-work-complete — 5 sub-gates on Stop</text>
    <rect x="42" y="174" width="336" height="34" rx="8" fill="#0000000f" stroke="#ef444455"/>
    <text x="58" y="196">no-permission-stop-guard — prose ask on Stop</text>
    <rect x="42" y="216" width="336" height="34" rx="8" fill="#0000000f" stroke="#ef444455"/>
    <text x="58" y="238">ask-user-question-guard — 1st AskUserQuestion</text>
    <rect x="42" y="258" width="336" height="34" rx="8" fill="#0000000f" stroke="#ef444455"/>
    <text x="58" y="280">git-require-clean-tree — dirty pull/rebase</text>
  </g>
  <rect x="460" y="20" width="380" height="300" rx="14" fill="#22c55e22" stroke="#22c55e" stroke-width="1.5"/>
  <text x="650" y="50" text-anchor="middle" font-size="19" font-weight="700" fill="#22c55e">SOFT NUDGE · prose</text>
  <text x="650" y="72" text-anchor="middle" font-size="12.5" fill="#94a3b8">a rule/skill the model should follow</text>
  <g font-size="13" fill="currentColor">
    <rect x="482" y="90" width="336" height="34" rx="8" fill="#0000000f" stroke="#22c55e55"/>
    <text x="498" y="112">plan-presentation rule · plan-render skill</text>
    <rect x="482" y="132" width="336" height="34" rx="8" fill="#0000000f" stroke="#22c55e55"/>
    <text x="498" y="154">/plan · swarm:plan — entry points</text>
    <rect x="482" y="174" width="336" height="34" rx="8" fill="#0000000f" stroke="#22c55e55"/>
    <text x="498" y="196">task-checklists rule · code:loop skill</text>
    <rect x="482" y="216" width="336" height="34" rx="8" fill="#0000000f" stroke="#22c55e55"/>
    <text x="498" y="238">/tickets · /tasks — queue sources</text>
    <rect x="482" y="258" width="336" height="34" rx="8" fill="#0000000f" stroke="#22c55e55"/>
    <text x="498" y="280">swarm:orchestrate — integration checklist</text>
  </g>
  <line x1="400" y1="170" x2="460" y2="170" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="4 4" marker-end="url(#arrow)" marker-start="url(#arrow)"/>
</svg>
<figcaption>Left: mechanical hooks that <code>exit 2</code>. Right: prose the Stop gates re-audit after the fact. A hook script is dead code unless it has an entry in an <code>agents.yaml</code> — two register hooks: <code>~/.agents/agents.yaml</code> (user) and <code>~/.agents/.system/agents.yaml</code> (system).</figcaption>
</figure>

> **The one load-bearing takeaway:** there is one hard plan gate (`plan-html-reminder`) and two hard Stop gates (`verify-work-complete`, `no-permission-stop-guard`). Everything else — the whole render "look" and the checklist discipline — is prose that only the Stop gates re-audit after the fact.

---

## Findings

### F1 · Plan mode / planning lifecycle

| # | Name | Kind | Event / matcher | Behavior |
|---|------|------|-----------------|----------|
| 1 | `plan-html-reminder` | **HARD GATE** | PreToolUse · `ExitPlanMode` (+ Grok `exit_plan_mode`) | Blocks ExitPlanMode until **(A)** a fresh plan HTML render exists **AND (B)** a multi-step plan has a checklist. |
| 2 | `activity-log-intent` | logger | PreToolUse · `ExitPlanMode\|Task` | Emits a `plan.created` activity/feed event. Observes, never blocks. |
| 3 | `verify-work-complete` carve-out | carve-out | Stop | Lets a real plan-mode session ("plan mode" + a cannot/forbid/no-push cue) stop on an open PR instead of looping. |
| 4 | — | (none) | `EnterPlanMode` | **No hook gates entering plan mode.** Only exit is hooked. |

`plan-html-reminder` detail — **(A)** scans `<repo>/.agents/artifacts/plans` for `plan-*.html` modified in the last 90 min (`-mmin -90`); none → block. **(B)** counts step-like lines; `>= 3` requires a `TaskCreate` / `TodoWrite` / `update_plan` tool to have fired since the last human turn (fails open on a trivial plan). Passes only when both hold. Self-terminating: the re-call after rendering passes.

### F2 · Plan presentation — the HTML "look"

One rule + one skill + three entry points, all pointing at the same render recipe.

- **Rule `plan-presentation`** — soft, mechanically reminded by the hook. Mandates: Markdown source in `.agents/artifacts/plans/`, self-contained HTML, **fixed structure** (hero + provenance chips + TOC, numbered sections, ≥1 inline-SVG figure — never mermaid, callouts, tagged tables), product-brand theme, `◐` light/dark toggle defaulting to `prefers-color-scheme`, open on the user's macOS box every time. *"A plan the user can't see rendered is not presented."*
- **Skill `plan-render`** — THE canonical look: 7-step workflow, required Markdown sections (Purpose / Proposed Changes / Public Interface / Validation / Risks / Tracking), interactive inline-SVG figures, `artifacts render`, headless inspection in both themes, deliver via `scp`+`open` and copy to `~/Downloads`. 6-item completion contract.
- **Three entry points funnel here:** `/plan` (9-step grounded planning; **Step 9** is the canonical render recipe), `swarm:plan` (OpenSpec proposal → blind swarm verify → HTML review artifact reusing `plan-render` + Step 9), and native plan mode (the `ref-*.md` file, reminded by the hook).

### F3 · Task-solving · checklists · queue draining

- **Rule `task-checklists`** — a real task (3+ steps, or ticket-bound) earns a `TaskCreate`-per-step list walked `pending → in_progress → completed`. The checklist **is the acceptance rubric**. Stamp each item with `metadata.ticket`. Skip for trivial/single-step.
- **Skill `code:loop`** — the queue-draining engine: one verb for a queue (ticket / many / label / markdown checklist / repo TODOs) → plan → conflict graph → fan out via `agents teams` (cap 3) → verify → review → rebase → fix CI → merge. **"Done means merged."** Unattended mode never calls AskUserQuestion.
- **Commands** — `/tickets` (auto-detect Linear/GitHub/Jira: check first → open if missing → close with proof) and `/tasks` (Linear-specific sprint puller). `swarm:orchestrate` adds a post-merge integration checklist ("done" for a swarm).

### F4 · Stop / completion gates — where "done" is enforced

Two registered Stop hooks — the hard backstop behind every "done" rule.

`verify-work-complete` (`.system/hooks/00-agent-verify-work-complete.sh` + `verify-delivery-chain.py`) fires at most once per stop, with five independent `exit 2` sub-gates:

| Sub-gate | Trigger | What it demands |
|---|---|---|
| **(i) Open-PR abandonment** | Session created / babysat a PR still `OPEN` (live `gh pr view`) | Keep driving, hand off by naming an owner, or name an external blocker. "Awaiting your review" does **not** pass. |
| **(ii) Swarm integration** | Ran an edit-mode swarm and claims done | Trigger the composed cross-track flow against the running binary and quote real output, or name the hop UNVERIFIED. |
| **(iii) Command handback** | Wrote a runnable script to `/tmp` and told the user to run it | Run it yourself, or name a genuine user-only gate. |
| **(iv) Delivery-chain** | A delivery stop → `verify-delivery-chain.py` | Linear ticket ids closed **and** docs / CHANGELOG / release artifacts exist. |
| **(v) Done-claim re-audit** | A done / parking / stand-down phrase | Re-read every original goal, mark each DONE-TESTED / DONE-UNTESTED / NOT-DONE, `agents feed post` before stopping. |

`no-permission-stop-guard` (`~/.agents/hooks/no-permission-stop-guard.sh`) catches prose permission-asks — only if the final line ends in `?`. Verdict `act` ("should I", "want me to", "what's next") → hard block; `file` (genuine ask) → blocks only in `headless|teams|cloud|dispatch|remote` runtime (→ `agents feed post --blocked`); `allow` → pass. The PreToolUse sibling `ask-user-question-guard` blocks a first-time AskUserQuestion once with an "answer it yourself" nudge.

---

## Evidence

Canonical paths for each finding (all verified against the actual scripts / `SKILL.md` / `rule.md`):

- **Plan gate:** `.system/rules/subrules/plan-presentation/plan-html-reminder.sh` (+ its `hooks.yaml`, `rule.md`)
- **Plan logger:** `~/.agents/hooks/11-activity-log.py` (registered `~/.agents/agents.yaml`)
- **Plan look:** `.system/skills/plan-render/SKILL.md` · `.system/commands/plan.md` (Step 9) · `.system/plugins/swarm/skills/plan/SKILL.md`
- **Checklists / queue:** `.system/rules/subrules/task-checklists.md` · `.system/plugins/code/skills/loop/SKILL.md` · `.system/commands/tickets.md` · `~/.agents/commands/tasks.md`
- **Stop gates:** `.system/hooks/00-agent-verify-work-complete.sh` + `verify-delivery-chain.py` (registered `.system/agents.yaml`) · `~/.agents/hooks/no-permission-stop-guard.sh` (registered `~/.agents/agents.yaml`) · `~/.agents/hooks/ask-user-question-guard.sh`

---

## Recommendations

Five places where the same concept is enforced in more than one location — the consolidation targets.

1. **The plan-render recipe is stated 3× and referenced 4×** (`plan-render` skill, `/plan` Step 9, `plan-presentation` rule; reused by `swarm:plan`). Collapse to one canonical source (the skill); have the rule + commands link, not restate.
2. **"Done" is defined four different ways** — `task-checklists` (all items completed), `code:loop` (merged), `swarm:orchestrate` (integration checklist), and the Stop gates (PR merged/handed-off + delivery chain). One shared definition-of-done, referenced everywhere, removes drift.
3. **The fixed plan structure list is duplicated** between the `plan-presentation` rule and the `plan-render` skill. Keep it in the skill only.
4. **Checklist enforcement is split across three touchpoints** — the `plan-html-reminder` hook (at ExitPlanMode), the `task-checklists` rule (all modes), and the Stop re-audit. One concept, three enforcers.
5. **No `EnterPlanMode` hook** — all plan enforcement is at exit; the entry slot is empty if you want to shape planning up front.

This document itself was produced with the same render path it describes:

```bash
artifacts render .agents/reports/plan-task-enforcement-map.md
# → plan-task-enforcement-map.html (self-contained, light/dark toggle)
```
