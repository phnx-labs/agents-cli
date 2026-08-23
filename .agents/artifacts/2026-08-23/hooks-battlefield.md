---
kind: visual
title: Where the Agents Fight the Hooks
summary: >
  Across ~7,290 agent transcripts on 7 harnesses, hooks fire at five lifecycle
  moments — but the fighting is concentrated in exactly two: PreToolUse guards and
  the Stop gate. 1,599 hook fires, plus 1,401 permission-classifier denials —
  and the hooks that fire most are the ones agents obey least.
status: final
date: 2026-08-23
context: agents-cli hook system — activation map + agent/guard collisions mined from fleet transcripts
facts:
  - "13 guards fire real blocks; SessionStart + UserPromptSubmit hooks never block (inject/remind only)"
  - "Top collider: the Stop gate, 524 fires over just 47 sessions — 11 per session"
  - "The auto-mode permission classifier — not a hook — is the single biggest force at 1,401 denials"
  - "footer-guard: 0 blocks — the no-footer rule is fully internalized, the guard never has to fire"
  - "The owner-update reminder fires 811 times and is ignored 58% of the time — the loudest, least obeyed hook"
  - "main-branch-guard recovers 72% — its refusal pastes the worktree recipe instead of only stating the rule"
---

## Story


You asked where the agents fight with the hooks. Here is the map,
mined from **~7,290 real session transcripts** across 7 harnesses (claude, codex,
grok, kimi, cursor, droid, antigravity).

A hook can fire at **five lifecycle moments**. Four of them are peaceful: SessionStart
and UserPromptSubmit hooks only *inject* context or *remind* — they never stop an
agent. The battlefield is **PreToolUse** (guards that veto a tool call before it runs)
and **Stop** (the gate that refuses a premature "I'm done"). That is where every real
fight happens.

Two forces do the stopping. **Hooks** — 13 guards that fired 1,599 times. And a
non-hook, the **auto-mode permission classifier**, which denied 1,401 tool calls on
its own. The classifier is the single loudest antagonist, and for grok it is almost
the *only* one it meets.

One guard is worth naming for its silence: **footer-guard has fired zero times.** The
"no Generated-with-Claude-Code footer" rule is so internalized that no agent ever tries
it — the perfect guard is the one that never has to act.

## What each hook is for


Read this first — every table after it refers to these names.

Each hook is listed with its **event** (when it fires), its **kind** (what it does when it
fires), a one-line **purpose**, and a **verdict**. Kind is the thing to read first: `inject`
and `remind`/`nudge` never stop you; `block` and `gate` do. They are grouped by lifecycle
moment, so the two lanes that can actually stop an agent stand apart from the eleven hooks
that only ever add context.

**SessionStart — all `inject` / `side-effect`, never blocks**

| Hook | Purpose | Verdict |
|---|---|---|
| session-identity | Writes who-am-I (session id, transcript path, pid) so `sessions` / `--active` can join pid→session | KEEP |
| **linear-inject-tasks** | **READS Linear and shows your projects/milestones/tickets in context. It only displays — it does not create tickets** | KEEP |
| device-topology | Injects the fleet host list + live load | KEEP |
| repo-inflight | Injects open PRs + agents active on this repo | KEEP |
| autosync | Brings config / secrets / sessions current | KEEP |
| git-pull-forward | Fast-forwards the cwd repo when clean (ff-only) | KEEP |

**UserPromptSubmit — all `expand` / `remind`, never blocks**

| Hook | Purpose | Verdict |
|---|---|---|
| promptcuts | Expands `#name` shortcuts into full instructions | KEEP |
| bangcuts | Runs `` `!cmd` `` inline and injects the output | KEEP |
| vacation-recap | On a long gap, nudges a back-from-vacation recap | KEEP |
| verify-work-state (record) | Records a goal boundary the Stop gate reads later | KEEP |
| worktree-law-reminder | Injects the "every write via a worktree" line each prompt | KEEP |

**PreToolUse — the block lane**

| Hook | Kind | Purpose | Verdict |
|---|---|---|---|
| git-guard | block · **WHAT** | Vetoes destructive/irreversible git *verbs* (reset --hard, force-push, checkout/switch, stash, clean, branch -d, rewrite). Worktree-aware: allows rebase/force-with-lease inside a worktree | KEEP · share code w/ main-branch-guard |
| main-branch-guard | block · **WHERE** | Vetoes any write/commit to the PRIMARY worktree, on any branch | KEEP · share code w/ git-guard |
| artifacts-confidential-guard | block | Stops publishing a confidential artifact to a public share — 35 fires across only 4 sessions, so it is one repeated fight, not a broad one | KEEP |
| merge-guard | block | Stops admin-bypass merges and merges with no non-author verdict | KEEP |
| rm-guard | block | Stops destructive `rm` on protected paths | KEEP |
| secrets-guard | block | Stops secret-materializing one-liners (plaintext export, reveal) | KEEP |
| large-file-add-guard | block | Stops `git add` of a file > 5 MiB | KEEP |
| git-require-clean-tree | block | Stops pull/rebase on a dirty tree | KEEP |
| teams-roster-guard | block | Forces mixed rosters (blocks a 3rd same-harness teammate) | KEEP |
| user-message-guard | block | Bounces an over-long owner notification | KEEP |
| footer-guard | block | Stops the "Generated with Claude Code" footer — 0 fires, pure deterrent | KEEP |
| **pr-description-reminder** | nudge | **On `gh pr create/edit` with no run-proof → demands a screenshot/recording/test-output + ticket link. This IS the "attach mockups + test results" gate you wanted** | KEEP |
| **plan-html-reminder** | nudge | Render the plan as HTML before presenting. **Only fires on the formal plan-exit tool — an agent that presents a plan as a plain message bypasses it entirely** | TUNE |

**Stop — the `gate` lane**

| Hook | Purpose | Verdict |
|---|---|---|
| verify-work-complete | Blocks a premature "done" without verification / handoff; also reinforces closing Linear + posting one update | KEEP · but see ticketing note |
| no-permission-stop-guard | Blocks stopping on an unanswered permission prompt | KEEP |

## Data


Now the counts — every name below is defined in the table above.

**Guards ranked by fires (all harnesses, `.jsonl` transcripts only)**

| Guard | Event | Kind | Fires | Sessions | Per session |
|---|---|---|---:|---:|---:|
| verify-work-complete | Stop | hard · gate | 524 | 47 | **11.1** |
| git-guard | PreToolUse | hard · data-loss | 237 | 133 | 1.8 |
| merge-guard | PreToolUse | hard · workflow | 227 | 82 | 2.8 |
| pr-description-reminder | PreToolUse | soft · reminder | 168 | 102 | 1.6 |
| main-branch-guard | PreToolUse | hard · workflow | 122 | 63 | 1.9 |
| rm-guard | PreToolUse | hard · data-loss | 88 | 58 | 1.5 |
| plan-html-reminder | PreToolUse | soft · reminder | 66 | 36 | 1.8 |
| large-file-add-guard | PreToolUse | hard · data-loss | 36 | 11 | 3.3 |
| artifacts-confidential-guard | PreToolUse | hard · data-loss | 35 | 4 | 8.8 |
| git-require-clean-tree | PreToolUse | hard · data-loss | 33 | 10 | 3.3 |
| teams-roster-guard | PreToolUse | hard · workflow | 28 | 4 | 7.0 |
| user-message-guard | PreToolUse | hard · workflow | 21 | 9 | 2.3 |
| secrets-guard | PreToolUse | hard · secret | 14 | 7 | 2.0 |
| footer-guard | PreToolUse | hard · workflow | 0 | 0 | — |
| **total hook fires** | | | **1,599** | | |
| *auto-mode classifier (not a hook)* | permission | denial | 1,401 | 767 | 1.8 |

> **Counting note.** One fire is written into a transcript row twice — once under
> `message`, once under `toolUseResult`. Counting string occurrences therefore
> roughly doubles every guard. These are **row counts: one row, one fire.** An
> earlier revision of this page reported the occurrence counts (git-guard 456,
> merge-guard 453) and overstated every guard by ~2x.

**Which agent collides, and how often** (sessions hitting a hard block vs permission denials)

| Harness | Transcripts | Sessions w/ hard block | Rate | Permission denials |
|---|---:|---:|---:|---:|
| claude | 3,865 | 199 | 5.1% | 526 |
| codex | 304 | 20 | 6.6% | 454 |
| grok | 3,140 | 35 | 1.1% | 419 |
| kimi | 12 | 0 | 0% | 7 |
| cursor | 9 | 0 | 0% | 0 |
| droid | 60 | 0 | 0% | 0 |
| antigravity | 29 | 0 | 0% | 0 |

## Figure


<figure>
<figcaption><strong>Figure 1 — The lifecycle battlefield.</strong> Every hook, placed at the moment it fires. Green = peaceful (injects context or nudges, never blocks). Red = combat (can veto a tool call or a stop). The fighting lives in two lanes only.</figcaption>

<svg viewBox="0 0 1180 560" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Hook lifecycle battlefield map" width="100%" font-family="JetBrains Mono, ui-monospace, monospace">
  <defs>
    <linearGradient id="combat" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3a1418"/><stop offset="1" stop-color="#2a0e12"/>
    </linearGradient>
    <linearGradient id="peace" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#12261a"/><stop offset="1" stop-color="#0e1f16"/>
    </linearGradient>
  </defs>

  <!-- timeline arrow -->
  <line x1="40" y1="52" x2="1140" y2="52" stroke="#3a3a3a" stroke-width="2"/>
  <polygon points="1140,52 1128,46 1128,58" fill="#3a3a3a"/>
  <text x="40" y="30" fill="#8a8a8a" font-size="15">agent lifecycle</text>
  <text x="1050" y="30" fill="#8a8a8a" font-size="13">time →</text>

  <!-- five lanes -->
  <!-- SessionStart -->
  <g>
    <rect x="34" y="66" width="212" height="462" rx="10" fill="url(#peace)" stroke="#1f3a2a"/>
    <circle cx="140" cy="52" r="7" fill="#a3e635"/>
    <text x="140" y="92" text-anchor="middle" fill="#a3e635" font-size="15" font-weight="700">SessionStart</text>
    <text x="140" y="112" text-anchor="middle" fill="#6f9e5a" font-size="11">6 hooks · 0 blocks</text>
    <text x="140" y="132" text-anchor="middle" fill="#5f7a52" font-size="10">inject / side-effect</text>
    <g fill="#9fd67f" font-size="11">
      <text x="140" y="168" text-anchor="middle">session-identity</text>
      <text x="140" y="196" text-anchor="middle">linear-inject-tasks</text>
      <text x="140" y="224" text-anchor="middle">device-topology</text>
      <text x="140" y="252" text-anchor="middle">repo-inflight</text>
      <text x="140" y="280" text-anchor="middle">autosync</text>
      <text x="140" y="308" text-anchor="middle">git-pull-forward</text>
    </g>
  </g>

  <!-- UserPromptSubmit -->
  <g>
    <rect x="254" y="66" width="212" height="462" rx="10" fill="url(#peace)" stroke="#1f3a2a"/>
    <circle cx="360" cy="52" r="7" fill="#a3e635"/>
    <text x="360" y="92" text-anchor="middle" fill="#a3e635" font-size="15" font-weight="700">UserPromptSubmit</text>
    <text x="360" y="112" text-anchor="middle" fill="#6f9e5a" font-size="11">5 hooks · 0 blocks</text>
    <text x="360" y="132" text-anchor="middle" fill="#5f7a52" font-size="10">expand / remind</text>
    <g fill="#9fd67f" font-size="11">
      <text x="360" y="168" text-anchor="middle">promptcuts (#)</text>
      <text x="360" y="196" text-anchor="middle">bangcuts (!)</text>
      <text x="360" y="224" text-anchor="middle">vacation-recap</text>
      <text x="360" y="252" text-anchor="middle">verify-work-state (rec)</text>
      <text x="360" y="280" text-anchor="middle">worktree-law-reminder</text>
    </g>
  </g>

  <!-- PreToolUse (COMBAT) -->
  <g>
    <rect x="474" y="66" width="430" height="462" rx="10" fill="url(#combat)" stroke="#5a2028" stroke-width="1.5"/>
    <circle cx="689" cy="52" r="7" fill="#ff5470"/>
    <text x="689" y="92" text-anchor="middle" fill="#ff8a9c" font-size="15" font-weight="700">PreToolUse — the front line</text>
    <text x="689" y="112" text-anchor="middle" fill="#d97a86" font-size="11">13 guards · 1,075 fires</text>
    <!-- guard chips as mini rows with bar -->
    <g font-size="11">
      <!-- helper: name left, count-bar right -->
      <g transform="translate(492,140)">
        <!-- rows -->
        <g transform="translate(0,0)"><text fill="#ffd7dd">git-guard</text><rect x="150" y="-10" width="200" height="13" rx="3" fill="#ff5470"/><text x="356" y="0" fill="#ffb3bd">237</text></g>
        <g transform="translate(0,26)"><text fill="#ffd7dd">merge-guard</text><rect x="150" y="-10" width="192" height="13" rx="3" fill="#ff5470"/><text x="348" y="0" fill="#ffb3bd">227</text></g>
        <g transform="translate(0,52)"><text fill="#ffd7dd">pr-desc-reminder</text><rect x="150" y="-10" width="142" height="13" rx="3" fill="#f0a35a"/><text x="298" y="0" fill="#f0c79a">168</text></g>
        <g transform="translate(0,78)"><text fill="#ffd7dd">main-branch-guard</text><rect x="150" y="-10" width="103" height="13" rx="3" fill="#ff5470"/><text x="259" y="0" fill="#ffb3bd">122</text></g>
        <g transform="translate(0,104)"><text fill="#ffd7dd">rm-guard</text><rect x="150" y="-10" width="74" height="13" rx="3" fill="#ff5470"/><text x="230" y="0" fill="#ffb3bd">88</text></g>
        <g transform="translate(0,130)"><text fill="#ffd7dd">plan-html-reminder</text><rect x="150" y="-10" width="56" height="13" rx="3" fill="#f0a35a"/><text x="212" y="0" fill="#f0c79a">66</text></g>
        <g transform="translate(0,156)"><text fill="#ffd7dd">artifacts-conf.</text><rect x="150" y="-10" width="30" height="13" rx="3" fill="#ff5470"/><text x="186" y="0" fill="#ffb3bd">35</text></g>
        <g transform="translate(0,182)"><text fill="#ffd7dd">large-file-add</text><rect x="150" y="-10" width="24" height="13" rx="3" fill="#ff5470"/><text x="180" y="0" fill="#ffb3bd">55</text></g>
        <g transform="translate(0,208)"><text fill="#ffd7dd">clean-tree</text><rect x="150" y="-10" width="20" height="13" rx="3" fill="#ff5470"/><text x="176" y="0" fill="#ffb3bd">46</text></g>
        <g transform="translate(0,234)"><text fill="#ffd7dd">user-msg-guard</text><rect x="150" y="-10" width="18" height="13" rx="3" fill="#ff5470"/><text x="174" y="0" fill="#ffb3bd">42</text></g>
        <g transform="translate(0,260)"><text fill="#ffd7dd">secrets-guard</text><rect x="150" y="-10" width="18" height="13" rx="3" fill="#ff5470"/><text x="174" y="0" fill="#ffb3bd">41</text></g>
        <g transform="translate(0,286)"><text fill="#ffd7dd">teams-roster</text><rect x="150" y="-10" width="16" height="13" rx="3" fill="#ff5470"/><text x="172" y="0" fill="#ffb3bd">37</text></g>
        <g transform="translate(0,312)"><text fill="#8a8a8a">footer-guard</text><rect x="150" y="-10" width="4" height="13" rx="3" fill="#3a5a3a"/><text x="160" y="0" fill="#7fae5f">0 · never fires</text></g>
      </g>
    </g>
  </g>

  <!-- Stop (COMBAT) -->
  <g>
    <rect x="912" y="66" width="150" height="462" rx="10" fill="url(#combat)" stroke="#5a2028" stroke-width="1.5"/>
    <circle cx="987" cy="52" r="7" fill="#ff5470"/>
    <text x="987" y="92" text-anchor="middle" fill="#ff8a9c" font-size="15" font-weight="700">Stop</text>
    <text x="987" y="112" text-anchor="middle" fill="#d97a86" font-size="11">the "done?" gate</text>
    <text x="987" y="132" text-anchor="middle" fill="#d97a86" font-size="11">524 fires</text>
    <g font-size="11">
      <text x="987" y="176" text-anchor="middle" fill="#ffd7dd">verify-work-</text>
      <text x="987" y="192" text-anchor="middle" fill="#ffd7dd">complete</text>
      <rect x="927" y="206" width="120" height="12" rx="3" fill="#ff5470"/>
      <text x="987" y="238" text-anchor="middle" fill="#ffb3bd" font-size="11">524 · 47 sess</text>
      <text x="987" y="286" text-anchor="middle" fill="#ffd7dd">no-permission-</text>
      <text x="987" y="302" text-anchor="middle" fill="#ffd7dd">stop-guard</text>
      <text x="987" y="330" text-anchor="middle" fill="#d97a86" font-size="10">blocks premature</text>
      <text x="987" y="344" text-anchor="middle" fill="#d97a86" font-size="10">stand-down</text>
    </g>
  </g>

  <!-- Notification lane note -->
  <g>
    <rect x="1070" y="66" width="72" height="462" rx="10" fill="url(#peace)" stroke="#1f3a2a"/>
    <text x="1106" y="300" text-anchor="middle" fill="#9fd67f" font-size="11" transform="rotate(90,1106,300)">Notification · attention-sentinel · 0 blocks</text>
  </g>
</svg>
</figure>

<figure>
<figcaption><strong>Figure 2 — Who collides.</strong> Hard hook-blocks (red) versus auto-mode permission denials (amber) per harness. grok almost never trips a hook — its whole fight is with the permission classifier.</figcaption>

<svg viewBox="0 0 1000 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Collisions per harness" width="100%" font-family="JetBrains Mono, ui-monospace, monospace">
  <!-- axes -->
  <line x1="120" y1="30" x2="120" y2="270" stroke="#3a3a3a"/>
  <line x1="120" y1="270" x2="960" y2="270" stroke="#3a3a3a"/>
  <!-- scale: max 511 -> 800px. px per unit = 1.37 -->
  <g font-size="12" fill="#8a8a8a">
    <text x="112" y="274" text-anchor="end">0</text>
    <line x1="120" y1="215" x2="960" y2="215" stroke="#242424"/><text x="112" y="219" text-anchor="end">200</text>
    <line x1="120" y1="160" x2="960" y2="160" stroke="#242424"/><text x="112" y="164" text-anchor="end">400</text>
    <line x1="120" y1="105" x2="960" y2="105" stroke="#242424"/><text x="112" y="109" text-anchor="end">600</text>
  </g>
  <!-- groups: claude, codex, grok, kimi. two bars each -->
  <!-- claude hardblock 189 -> 52px ; denials 511 -> 140px -->
  <g>
    <rect x="180" y="218" width="40" height="52" fill="#ff5470"><title>claude hard blocks: 199 sessions</title></rect>
    <rect x="224" y="130" width="40" height="140" fill="#f0a35a"><title>claude permission denials: 526</title></rect>
    <text x="222" y="288" text-anchor="middle" fill="#cfcfcf" font-size="13">claude</text>
    <text x="200" y="212" text-anchor="middle" fill="#ffb3bd" font-size="11">199</text>
    <text x="244" y="124" text-anchor="middle" fill="#f0c79a" font-size="11">526</text>
  </g>
  <!-- codex hardblock 20 -> 6 ; denials 450 -> 123 -->
  <g>
    <rect x="360" y="264" width="40" height="6" fill="#ff5470"><title>codex hard blocks: 20 sessions</title></rect>
    <rect x="404" y="147" width="40" height="123" fill="#f0a35a"><title>codex permission denials: 454</title></rect>
    <text x="402" y="288" text-anchor="middle" fill="#cfcfcf" font-size="13">codex</text>
    <text x="380" y="258" text-anchor="middle" fill="#ffb3bd" font-size="11">20</text>
    <text x="424" y="141" text-anchor="middle" fill="#f0c79a" font-size="11">454</text>
  </g>
  <!-- grok hardblock 35 -> 10 ; denials 419 -> 115 -->
  <g>
    <rect x="540" y="260" width="40" height="10" fill="#ff5470"><title>grok hard blocks: 35 sessions</title></rect>
    <rect x="584" y="155" width="40" height="115" fill="#f0a35a"><title>grok permission denials: 419</title></rect>
    <text x="582" y="288" text-anchor="middle" fill="#cfcfcf" font-size="13">grok</text>
    <text x="560" y="254" text-anchor="middle" fill="#ffb3bd" font-size="11">35</text>
    <text x="604" y="149" text-anchor="middle" fill="#f0c79a" font-size="11">419</text>
  </g>
  <!-- kimi hardblock 0 ; denials 6 -->
  <g>
    <rect x="720" y="268" width="40" height="2" fill="#ff5470"><title>kimi hard blocks: 0</title></rect>
    <rect x="764" y="268" width="40" height="2" fill="#f0a35a"><title>kimi permission denials: 7</title></rect>
    <text x="762" y="288" text-anchor="middle" fill="#cfcfcf" font-size="13">kimi</text>
    <text x="742" y="262" text-anchor="middle" fill="#8a8a8a" font-size="11">0</text>
    <text x="786" y="262" text-anchor="middle" fill="#8a8a8a" font-size="11">6</text>
  </g>
  <text x="850" y="288" text-anchor="middle" fill="#5f5f5f" font-size="11">cursor/droid/</text>
  <text x="850" y="304" text-anchor="middle" fill="#5f5f5f" font-size="11">antigravity: 0</text>
  <!-- legend -->
  <g font-size="12">
    <rect x="600" y="34" width="14" height="14" fill="#ff5470"/><text x="620" y="46" fill="#cfcfcf">hard hook-block (sessions)</text>
    <rect x="600" y="56" width="14" height="14" fill="#f0a35a"/><text x="620" y="68" fill="#cfcfcf">permission-classifier denials (events)</text>
  </g>
</svg>
</figure>

<figure>
<figcaption><strong>Figure 3 — Anatomy of the biggest fight: git-guard.</strong> What agents actually try that git-guard vetoes. `reset --hard` and `git checkout` (stranding the user's tree) lead — the exact history-destroying moves the worktree law exists to stop. 235 fires total.</figcaption>

<svg viewBox="0 0 1000 360" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="git-guard blocked operations" width="100%" font-family="JetBrains Mono, ui-monospace, monospace">
  <!-- horizontal bars, max 92 -> 620px, 6.7 px/unit, x0=260 -->
  <g font-size="13">
    <g transform="translate(0,40)"><text x="248" y="4" text-anchor="end" fill="#cfcfcf">git.reset --hard</text><rect x="260" y="-11" width="617" height="22" rx="3" fill="#ff5470"/><text x="885" y="4" fill="#ffb3bd">53</text></g>
    <g transform="translate(0,72)"><text x="248" y="4" text-anchor="end" fill="#cfcfcf">git.checkout</text><rect x="260" y="-11" width="570" height="22" rx="3" fill="#ff5470"/><text x="838" y="4" fill="#ffb3bd">49</text></g>
    <g transform="translate(0,104)"><text x="248" y="4" text-anchor="end" fill="#cfcfcf">git.branch-delete</text><rect x="260" y="-11" width="396" height="22" rx="3" fill="#ff6f86"/><text x="664" y="4" fill="#ffb3bd">34</text></g>
    <g transform="translate(0,136)"><text x="248" y="4" text-anchor="end" fill="#cfcfcf">git.stash</text><rect x="260" y="-11" width="279" height="22" rx="3" fill="#ff6f86"/><text x="547" y="4" fill="#ffb3bd">24</text></g>
    <g transform="translate(0,168)"><text x="248" y="4" text-anchor="end" fill="#cfcfcf">git.worktree-rm-dirty</text><rect x="260" y="-11" width="256" height="22" rx="3" fill="#ff8a9c"/><text x="524" y="4" fill="#ffb3bd">22</text></g>
    <g transform="translate(0,200)"><text x="248" y="4" text-anchor="end" fill="#cfcfcf">git.config-write</text><rect x="260" y="-11" width="140" height="22" rx="3" fill="#ffa3b2"/><text x="408" y="4" fill="#ffb3bd">12</text></g>
    <g transform="translate(0,232)"><text x="248" y="4" text-anchor="end" fill="#cfcfcf">git.worktree-rm-unpushed</text><rect x="260" y="-11" width="128" height="22" rx="3" fill="#ffa3b2"/><text x="396" y="4" fill="#ffb3bd">11</text></g>
    <g transform="translate(0,264)"><text x="248" y="4" text-anchor="end" fill="#cfcfcf">git.push-delete</text><rect x="260" y="-11" width="116" height="22" rx="3" fill="#ffa3b2"/><text x="384" y="4" fill="#ffb3bd">10</text></g>
    <g transform="translate(0,296)"><text x="260" y="4" text-anchor="start" fill="#8a8a8a">+ worktree-rm-force 7 · rebase-outside-wt 4 · reflog 3 · cherry-pick, push-force, revert, switch 1 each</text></g>
  </g>
</svg>
</figure>

## Did the hook actually work?


A block count says a hook fired. It does not say the agent then did the right
thing. So for every fire that could be located in the message stream, the next
40 messages were searched for the action the hook demanded — `artifacts render`
after the plan nudge, `worktree add` after a primary-tree block, `agents feed
post` after the owner-update line. Two numbers come out of it, and the second
one matters more.

| Hook | Fires | Sessions | Complied | **Refired** | Verdict |
|---|---:|---:|---:|---:|---|
| feed-owner-update | 811 | 272 | **42%** | 539 | **CUT THE PING** |
| git-guard | 164 | 110 | 61% | 54 | working |
| verify-work-complete | 148 | 35 | *97%* | 113 | unmeasured |
| pr-description-reminder | 136 | 87 | 65% | 49 | working |
| main-branch-guard | 80 | 51 | 72% | 29 | working |
| plan-html-reminder | 57 | 32 | 53% | 25 | TUNE (see below) |
| teams-roster-guard | 17 | 4 | 71% | 13 | working |
| user-message-guard | 10 | 7 | 60% | 3 | working |

**Refired is the real signal.** A hook that has to say the same thing twice in one
session did not teach the first time. Compliance can be faked by an agent that
happens to do the right thing anyway; a re-fire cannot.

**Every compliance number here is a lower bound.** It is only as good as the
pattern used to recognise the demanded action, and a too-narrow pattern
manufactures a false defect. main-branch-guard is the worked example: scored
against `worktree add` alone it reads **29%** and looks broken. But an agent
that already *has* a worktree and merely aimed a write at the wrong path does
not need a new one — it needs to re-aim, and 36 of its 61 recoveries did exactly
that. Scored against both recoveries it is **72%**, and the guard is fine.
Treat a low number as a question, not a verdict.

<figure>
<figcaption><strong>Figure 4 — Obeyed vs ignored.</strong> Each hook's fires split by whether the demanded action appeared in the following 40 messages. One bar is the outlier that matters: the owner-update reminder, ignored more often than obeyed and wider than every guard combined.</figcaption>

<svg viewBox="0 0 1000 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Hook compliance" width="100%" font-family="JetBrains Mono, ui-monospace, monospace">
  <g font-size="13">
    <rect x="600" y="14" width="14" height="14" fill="#7fae5f"/><text x="620" y="26" fill="#cfcfcf">complied</text>
    <rect x="740" y="14" width="14" height="14" fill="#ff5470"/><text x="760" y="26" fill="#cfcfcf">ignored</text>
  </g>
  <g font-size="13">
    <g transform="translate(0,70)"><text x="238" y="4" text-anchor="end" fill="#cfcfcf">feed-owner-update</text><rect x="250" y="-11" width="277" height="22" fill="#7fae5f"/><rect x="527" y="-11" width="385" height="22" fill="#ff5470"/><text x="920" y="4" fill="#ffb3bd" font-size="12">42%</text></g>
    <g transform="translate(0,104)"><text x="238" y="4" text-anchor="end" fill="#cfcfcf">git-guard</text><rect x="250" y="-11" width="82" height="22" fill="#7fae5f"/><rect x="332" y="-11" width="52" height="22" fill="#ff5470"/><text x="392" y="4" fill="#8a8a8a" font-size="12">61%</text></g>
    <g transform="translate(0,138)"><text x="238" y="4" text-anchor="end" fill="#cfcfcf">pr-desc-reminder</text><rect x="250" y="-11" width="73" height="22" fill="#7fae5f"/><rect x="323" y="-11" width="39" height="22" fill="#ff5470"/><text x="370" y="4" fill="#8a8a8a" font-size="12">65%</text></g>
    <g transform="translate(0,172)"><text x="238" y="4" text-anchor="end" fill="#cfcfcf">main-branch-guard</text><rect x="250" y="-11" width="48" height="22" fill="#7fae5f"/><rect x="298" y="-11" width="18" height="22" fill="#ff5470"/><text x="324" y="4" fill="#8a8a8a" font-size="12">72%</text></g>
    <g transform="translate(0,206)"><text x="238" y="4" text-anchor="end" fill="#cfcfcf">plan-html-reminder</text><rect x="250" y="-11" width="25" height="22" fill="#7fae5f"/><rect x="275" y="-11" width="22" height="22" fill="#ff5470"/><text x="305" y="4" fill="#8a8a8a" font-size="12">53%</text></g>
    <g transform="translate(0,240)"><text x="238" y="4" text-anchor="end" fill="#cfcfcf">teams-roster-guard</text><rect x="250" y="-11" width="10" height="22" fill="#7fae5f"/><rect x="260" y="-11" width="4" height="22" fill="#ff5470"/><text x="272" y="4" fill="#8a8a8a" font-size="12">71%</text></g>
    <g transform="translate(0,274)"><text x="238" y="4" text-anchor="end" fill="#cfcfcf">user-message-guard</text><rect x="250" y="-11" width="5" height="22" fill="#7fae5f"/><rect x="255" y="-11" width="3" height="22" fill="#ff5470"/><text x="266" y="4" fill="#8a8a8a" font-size="12">60%</text></g>
  </g>
  <text x="250" y="316" fill="#5f5f5f" font-size="11">bar width = fires, to scale — the owner-update reminder dwarfs every guard in the system</text>
</svg>
</figure>

**The owner-update reminder is the worst hook in the system.** 811 fires across 272
sessions — three per session, more than every PreToolUse guard combined — and 58%
of them are ignored. Worse, the 42% that *are* obeyed are obeyed by running
`agents feed post … --level important`, and `feed.broadcast.owner` forwards an
important post to iMessage. So the reminder's only successful outcome is a phone
buzz, fired without regard to whether the session shipped anything worth one. It
hardcodes the escalation level instead of letting the outcome pick it.

**main-branch-guard is healthy, and its refusal is the model to copy.** 72% of
blocked agents recover within 40 messages — 25 open a fresh worktree, 36 re-aim
into one they already had. The reason is visible in the refusal text itself
(`main-branch-guard.sh:198-203`): it does not just say *no*, it pastes the
four-line worktree recipe with `$REPO` already filled in. A guard that hands over
the fix outperforms one that only states the rule. The 24 non-recoveries are
mostly sessions that changed direction entirely, not agents left stuck.

**The Stop gate's 97% is not a real number.** For a gate whose demand is "keep
working," the only measurable compliance is "did any tool call follow," which is
true almost by construction. What *is* real: 524 fires across 47 sessions, **11
per session**. Whatever it is teaching, it is teaching it eleven times.

## Duplicates, tuning, and the Linear-pollution source


> Source claims in this section were re-verified against `.agents-system` at
> `origin/main` (`011b7e0`) with a clean tree — not a stale local checkout. That
> commit already includes PR #362, which changed this very hook set today.


**git-guard vs main-branch-guard are NOT duplicates — they're two axes.** git-guard polices
*what operation* (destructive git verbs, anywhere); main-branch-guard polices *where* (never
the primary tree). `git commit` in your checkout → main-branch-guard. `reset --hard` in a
worktree → git-guard. Merging the policies would be wrong. **But they share ~200 lines of
identical command-parsing shell** (`extract_sh_c_inner`, `check_segment`,
`check_command_string`, `-C` resolution), and the `_json_field` JSON extractor is
copy-pasted into **11** scripts — `git-guard`, `main-branch-guard`, `merge-guard`,
`rm-guard`, `secrets-guard`, `footer-guard`, `large-file-add-guard`,
`teams-roster-guard`, `pr-description-reminder`, `01-git-require-clean-tree`, and
`09-git-pull-forward` (counted with `git grep -l _json_field origin/main`, so it is
the shipped tree, not a working copy). That is the real consolidation win: lift one
shared git-command-parser into `hooks/lib/` (they already share `git-facts.sh`) —
same behavior, one place to fix.

**pr-description-reminder already does what you described** — it's the run-proof gate, not a
vague "write a description" nudge. Keep it. Only blind spot: a `--fill`/`--template`/editor
body it can't read (fails open there).

**plan-html-reminder — the earlier diagnosis here was wrong, and the measurement says so.**
It is *not* true that the hook only fires on the formal plan-exit tool: `hooks.yaml` registers
the same script twice, once on `PreToolUse`/`ExitPlanMode` and once on `Stop`, precisely to
cover harnesses (Codex, Grok) whose plan mode is collaboration state rather than a tool call.

The measured failure mode is different. Of 57 blocks:

| what the agent did next | count |
|---|---:|
| never attempted a render — ignored the block | **34 (60%)** |
| rendered, and cleared | 19 |
| rendered, and was re-blocked anyway | **4 (7%)** |

So "the render bar is too strict" explains **4 cases**, not the bulk. Loosening it — the fix
an earlier revision of this page recommended — would address 7% of the problem. The bulk is
agents that read the block and simply did not render.

The remaining true gap is narrower: a plan presented as an ordinary message in **default**
mode is invisible to both entries. `PreToolUse` needs an `ExitPlanMode` call, and the `Stop`
backstop exits early when `permission_mode` is present and not `plan` — which is exactly what
PR #362 landed today, deliberately, to stop false-positives on answers that merely *discuss*
a plan. Widening it back re-breaks what #362 just fixed. That is a genuine tradeoff (missed
plans vs. false blocks), not an obvious fix, so it is flagged rather than patched.

**Linear pollution is NOT caused by a hook — no hook creates tickets.** Agents create them
because two *rules* tell them to, and 100+ agents obey with no cross-session dedup:

- `conventions.md`: *"open one if missing (one per unit of delivery)"*
- your global close-session rule: *"File every follow-up you were about to suggest as a real ticket."*

The `verify-work-complete` Stop gate reinforces it at session end. The result is volume +
redundant tickets + misclassification (each agent guesses project/labels). `linear-inject`
only *reads* your board. Fixing this is a rules edit, not a hook edit.

## Insight


- **The map has two hot lanes, not five.** SessionStart (6 hooks) and UserPromptSubmit (5 hooks) never block — they inject Linear/topology/inflight context and expand promptcuts/bangcuts. All the friction is PreToolUse + Stop. If you are auditing "where agents fight hooks," you can ignore 60% of the hook surface.
- **The Stop gate is the heaviest hook in the system** — 524 fires, 11 per session it touches, more than git-guard and merge-guard put together. Among PreToolUse guards those two lead (237 and 227): git-guard's top vetoes are `reset --hard`, `checkout`, `branch-delete`, `stash` — exactly the history-destroying moves the agentic-git workflow forbids; merge-guard's are admin-bypass and merging with no non-author verdict.
- **The loudest antagonist is not a hook.** The auto-mode permission classifier denied 1,401 tool calls — nearly as many as all 13 guards combined (1,599). For grok it is almost the *entire* experience of "being stopped".
- **codex fights hardest per session (6.6%), grok softest (1.1%).** claude sits at 5.1% but spreads across all 13 guards; grok concentrates on the classifier + merge-guard.
- **A guard firing zero times is a rule that won.** footer-guard: 0 fires. Nobody tries the banned footer anymore — the guard is pure standing deterrent. The inverse also holds: a hook that fires three times a session and is ignored 58% of the time is a rule nobody internalized, and the fix is the message, not more volume.
