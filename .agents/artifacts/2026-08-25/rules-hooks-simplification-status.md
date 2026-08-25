---
kind: visual
title: The personal rulebook is distilled. The shared system is only partly there.
summary: >
  The 23-rule, roughly 1.5k-word distillation is live for Muqsit's fleet through user-layer overrides, not in the shared system repo. The system did land a 60% rules cleanup and a substantial hook-message/refinement wave, but the full 14-to-8 hook consolidation remains incomplete.
status: final
date: 2026-08-25
context: status of rules, subrules, and hook messaging across muqsitnawaz/.agents and phnx-labs/.agents-system
facts:
  - "Personal layer: 23 rules, 1,583 compiled words, merged in .agents PR #288"
  - "Shared system: 14,695 to 6,042 words, merged in .agents-system PR #348"
  - "Shared-system 23-rule distillation PR #381 was closed, not merged"
  - "Hook refinement: major message and guard improvements merged; full 14-to-8 target not complete"
---

## Story

The answer is **yes for your fleet, partly for the shared system, and partly for hooks**.

Your personal `muqsitnawaz/.agents` layer now shadows the shared rule corpus with the distilled version: **23 rules, 1,583 compiled words**, with no system-rule leaks. That is the strongest simplification and it is merged in [PR #288](https://github.com/muqsitnawaz/.agents/pull/288).

The same exact rewrite was proposed for everyone in `phnx-labs/.agents-system` as [PR #381](https://github.com/phnx-labs/.agents-system/pull/381), but it was **closed, not merged**. The recorded reason was scope: these were treated as Muqsit's personal operating instructions, so the user layer became their home. The shared system did independently receive a less aggressive but real cleanup in [PR #348](https://github.com/phnx-labs/.agents-system/pull/348): **14,695 → 6,042 words**, and its Stop-hook messages fell from roughly **30–40 lines to 6–12 lines**.

The hook cleanup is a program, not a single pending switch. The measurement artifact, [hooks battlefield](https://github.com/phnx-labs/agi-cli/pull/2919), proposed a **14→8 guard corpus**. Several high-value pieces landed, but not every proposed merge or deletion did.

<div class="artifact-callout"><strong>Bottom line:</strong> the fleet you use sees the distilled rules today. A fresh/shared system installation does not see that exact 23-rule corpus. Hook wording is substantially cleaner, while hook topology is still between the measured “before” and the proposed 8-guard end state.</div>

## Data

| Surface | Intended simplification | What is live now | Status |
|---|---|---|---|
| `muqsitnawaz/.agents` rules | Essence-only personal rulebook | 23 rules / 1,583 words via PR #288 | **Landed** |
| `phnx-labs/.agents-system` rules | Same 23-rule / ~1.5k corpus | Exact PR #381 closed; earlier 6,042-word cleanup from PR #348 is live | **Partial** |
| Stop-hook messaging | Replace 30–40-line lectures with direct instructions | 6–12-line messages via PR #348 | **Landed** |
| Low-value guards | Remove measured noise | `footer-guard` removed (#386); personal `user-message-guard` removed (#289) | **Landed** |
| Plan-mode overhead | Avoid irrelevant delivery checks while planning | Four delivery guards skip plan mode (#369) | **Landed** |
| Hook internals | Remove duplication and false states | shared JSON parser (#385), shared git parser (#387), orphan mq declaration removed (#388) | **Landed** |
| Stop escalation wording | Stop treating every completion as phone-worthy | plain feed post by default (#365) | **Landed** |
| Correctness follow-ups | Fix repeated/incorrect guard outcomes | RUSH-3032 follow-ups (#374), merge verdict fixes (#376/#382) | **Landed** |
| Proposed 14→8 topology | Merge four git guards; decide plan reminder; reduce guard count to eight | No single completion PR; several proposed merges/cuts remain | **Open gap** |

### What did not land as originally proposed

- The exact shared-system distillation in PR #381.
- The complete 14→8 hook topology from the battlefield verdict.
- A single closure artifact or ticket proving every battlefield recommendation was accepted, rejected, or shipped.

### Important nuance

The `plan-html-reminder` was initially treated as dangling in personal PR #291, then correctly restored in [PR #292](https://github.com/muqsitnawaz/.agents/pull/292) because the active script lives beside its system subrule. This is a useful warning: the cleanup is real, but one audit initially missed rule-adjacent hooks.

## Figure

<figure>
<figcaption><strong>Figure 1 — What an agent receives today.</strong> User rules shadow same-named system rules. The exact essence rewrite therefore reaches Muqsit's fleet without changing the shared default for everyone.</figcaption>
<svg viewBox="0 0 1120 470" role="img" aria-label="Layer diagram showing personal rules overriding shared system rules and hooks enforcing behavior">
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="#84cc16"/></marker>
  </defs>
  <rect x="40" y="40" width="300" height="150" rx="18" fill="#172554" stroke="#60a5fa" stroke-width="3"/>
  <text x="70" y="78" fill="#bfdbfe" font-size="24" font-weight="700">Shared system layer</text>
  <text x="70" y="112" fill="#e5e7eb" font-size="18">PR #348 live</text>
  <text x="70" y="140" fill="#e5e7eb" font-size="18">6,042 words</text>
  <text x="70" y="168" fill="#fca5a5" font-size="17">PR #381 closed</text>

  <rect x="40" y="250" width="300" height="150" rx="18" fill="#052e16" stroke="#84cc16" stroke-width="4"/>
  <text x="70" y="288" fill="#bef264" font-size="24" font-weight="700">Personal user layer</text>
  <text x="70" y="322" fill="#e5e7eb" font-size="18">PR #288 live</text>
  <text x="70" y="350" fill="#e5e7eb" font-size="18">23 rules · 1,583 words</text>
  <text x="70" y="378" fill="#bef264" font-size="17">shadows same-name rules ↑</text>

  <path d="M350 320 C430 320, 430 150, 515 150" fill="none" stroke="#84cc16" stroke-width="5" marker-end="url(#arrow)"/>
  <text x="380" y="250" fill="#bef264" font-size="17" transform="rotate(-55 380 250)">effective composition</text>

  <rect x="530" y="85" width="250" height="160" rx="22" fill="#18181b" stroke="#f4f4f5" stroke-width="3"/>
  <text x="560" y="125" fill="#ffffff" font-size="24" font-weight="700">Agent session</text>
  <text x="560" y="162" fill="#bef264" font-size="30" font-weight="800">ESSENCE</text>
  <text x="560" y="194" fill="#d4d4d8" font-size="17">personal corpus wins</text>
  <text x="560" y="220" fill="#d4d4d8" font-size="17">on Muqsit's fleet</text>

  <path d="M790 165 L860 165" fill="none" stroke="#84cc16" stroke-width="5" marker-end="url(#arrow)"/>
  <rect x="875" y="85" width="205" height="310" rx="22" fill="#3f0b0b" stroke="#fb7185" stroke-width="3"/>
  <text x="905" y="125" fill="#fecdd3" font-size="24" font-weight="700">Hooks</text>
  <text x="905" y="162" fill="#ffffff" font-size="17">messages: cleaner</text>
  <text x="905" y="192" fill="#ffffff" font-size="17">noise: reduced</text>
  <text x="905" y="222" fill="#ffffff" font-size="17">parsers: shared</text>
  <line x1="905" y1="246" x2="1050" y2="246" stroke="#fb7185" stroke-width="2"/>
  <text x="905" y="282" fill="#fda4af" font-size="17">14→8 topology:</text>
  <text x="905" y="312" fill="#fda4af" font-size="22" font-weight="800">PARTIAL</text>
  <text x="905" y="350" fill="#d4d4d8" font-size="15">behavior guards remain</text>
  <text x="905" y="374" fill="#d4d4d8" font-size="15">more numerous than target</text>
</svg>
</figure>

<figure>
<figcaption><strong>Figure 2 — Delivery ledger.</strong> Thematic groups, not chronological order: green items are demonstrably merged; amber is the explicit missing closure.</figcaption>
<svg viewBox="0 0 1120 390" role="img" aria-label="Thematic ledger of merged rule and hook improvements followed by the remaining closure gap">
  <line x1="90" y1="195" x2="1030" y2="195" stroke="#71717a" stroke-width="6"/>
  <g fill="#84cc16" stroke="#365314" stroke-width="3">
    <circle cx="150" cy="195" r="18"/><circle cx="330" cy="195" r="18"/><circle cx="510" cy="195" r="18"/><circle cx="690" cy="195" r="18"/><circle cx="870" cy="195" r="18"/>
  </g>
  <circle cx="990" cy="195" r="18" fill="#f59e0b" stroke="#78350f" stroke-width="3"/>
  <g fill="var(--text)" font-size="17" text-anchor="middle">
    <text x="150" y="140" font-weight="700">#348</text><text x="150" y="225">system rules +</text><text x="150" y="247">messages slimmed</text>
    <text x="330" y="140" font-weight="700">#288</text><text x="330" y="225">personal essence</text><text x="330" y="247">corpus live</text>
    <text x="510" y="140" font-weight="700">#386 / #289</text><text x="510" y="225">two noisy guards</text><text x="510" y="247">removed</text>
    <text x="690" y="140" font-weight="700">#365 / #369</text><text x="690" y="225">messaging + plan</text><text x="690" y="247">mode corrected</text>
    <text x="870" y="140" font-weight="700">#374–#388</text><text x="870" y="225">correctness +</text><text x="870" y="247">dedup landed</text>
    <text x="990" y="140" font-weight="700" fill="#fbbf24">remaining</text><text x="990" y="225" fill="#fbbf24">14→8 closure</text><text x="990" y="247" fill="#fbbf24">not landed</text>
  </g>
  <rect x="80" y="292" width="960" height="62" rx="14" fill="#18181b" stroke="#52525b"/>
  <text x="560" y="330" text-anchor="middle" fill="#ffffff" font-size="20"><tspan fill="#84cc16" font-weight="700">Outcome:</tspan> meaningful improvements are live; the original end-state is not fully closed.</text>
</svg>
</figure>

## Evidence

- [Personal distilled corpus, merged](https://github.com/muqsitnawaz/.agents/pull/288)
- [Shared distilled corpus, closed as superseded](https://github.com/phnx-labs/.agents-system/pull/381)
- [Shared 60% rules + hook-message cleanup, merged](https://github.com/phnx-labs/.agents-system/pull/348)
- [Measured hook battlefield artifact, merged](https://github.com/phnx-labs/agi-cli/pull/2919)
- [Stop reminder phone-escalation fix, merged](https://github.com/phnx-labs/.agents-system/pull/365)
- [Plan-mode hook overhead fix, merged](https://github.com/phnx-labs/.agents-system/pull/369)
- [RUSH-3032 hook correctness follow-ups, merged](https://github.com/phnx-labs/.agents-system/pull/374)
- [Footer guard removal, merged](https://github.com/phnx-labs/.agents-system/pull/386)
- [User-message guard removal, merged](https://github.com/muqsitnawaz/.agents/pull/289)
