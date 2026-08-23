---
kind: visual
title: Where the Agents Fight the Hooks
summary: >
  Across ~7,290 agent transcripts on 7 harnesses, hooks fire at five lifecycle
  moments — but the fighting is concentrated in exactly two: PreToolUse guards and
  the Stop gate. ~2,365 hard hook-blocks, plus 1,386 permission-classifier denials.
status: final
date: 2026-08-23
context: agents-cli hook system — activation map + agent/guard collisions mined from fleet transcripts
facts:
  - "13 guards fire real blocks; SessionStart + UserPromptSubmit hooks never block (inject/remind only)"
  - "Top colliders: git-guard 456, merge-guard 453, verify-work-complete 328, pr-reminder 326"
  - "The auto-mode permission classifier — not a hook — is the single biggest force at 1,386 denials"
  - "footer-guard: 0 blocks — the no-footer rule is fully internalized, the guard never has to fire"
  - "grok collides mostly with the permission classifier (419) + merge-guard; claude spreads across all 13"
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

Two forces do the stopping. **Hooks** — 13 guards that fired ~2,365 blocks. And a
non-hook, the **auto-mode permission classifier**, which denied 1,386 tool calls on
its own. The classifier is the single loudest antagonist, and for grok it is almost
the *only* one it meets.

One guard is worth naming for its silence: **footer-guard has fired zero times.** The
"no Generated-with-Claude-Code footer" rule is so internalized that no agent ever tries
it — the perfect guard is the one that never has to act.

## Data

**Guards ranked by block events (all harnesses, `.jsonl` transcripts only)**

| Guard | Event | Kind | Blocks | Sessions |
|---|---|---|---:|---:|
| git-guard | PreToolUse | hard · data-loss | 456 | 132 |
| merge-guard | PreToolUse | hard · workflow | 453 | 80 |
| verify-work-complete | Stop | hard · gate | 328 | 28 |
| pr-description-reminder | PreToolUse | soft · reminder | 326 | 102 |
| main-branch-guard | PreToolUse | hard · workflow | 186 | 61 |
| rm-guard | PreToolUse | hard · data-loss | 155 | 58 |
| artifacts-confidential-guard | PreToolUse | hard · data-loss | 121 | 4 |
| plan-html-reminder | PreToolUse | soft · reminder | 119 | 36 |
| large-file-add-guard | PreToolUse | hard · data-loss | 55 | 10 |
| git-require-clean-tree | PreToolUse | hard · data-loss | 46 | 9 |
| user-message-guard | PreToolUse | hard · workflow | 42 | 9 |
| secrets-guard | PreToolUse | hard · secret | 41 | 6 |
| teams-roster-guard | PreToolUse | hard · workflow | 37 | 3 |
| footer-guard | PreToolUse | hard · workflow | 0 | 0 |
| *auto-mode classifier (not a hook)* | permission | denial | 1,386 | 764 |

**Which agent collides, and how often** (hard hook-blocks vs permission denials)

| Harness | Transcripts | Sessions w/ hard block | Rate | Permission denials |
|---|---:|---:|---:|---:|
| claude | 3,799 | 189 | 5.0% | 511 |
| codex | 303 | 20 | 6.6% | 450 |
| grok | 3,140 | 35 | 1.1% | 419 |
| kimi | 10 | 0 | 0% | 6 |
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
    <text x="689" y="112" text-anchor="middle" fill="#d97a86" font-size="11">13 guards · ~2,037 blocks</text>
    <!-- guard chips as mini rows with bar -->
    <g font-size="11">
      <!-- helper: name left, count-bar right -->
      <g transform="translate(492,140)">
        <!-- rows -->
        <g transform="translate(0,0)"><text fill="#ffd7dd">git-guard</text><rect x="150" y="-10" width="200" height="13" rx="3" fill="#ff5470"/><text x="356" y="0" fill="#ffb3bd">456</text></g>
        <g transform="translate(0,26)"><text fill="#ffd7dd">merge-guard</text><rect x="150" y="-10" width="199" height="13" rx="3" fill="#ff5470"/><text x="355" y="0" fill="#ffb3bd">453</text></g>
        <g transform="translate(0,52)"><text fill="#ffd7dd">pr-desc-reminder</text><rect x="150" y="-10" width="143" height="13" rx="3" fill="#f0a35a"/><text x="299" y="0" fill="#f0c79a">326</text></g>
        <g transform="translate(0,78)"><text fill="#ffd7dd">main-branch-guard</text><rect x="150" y="-10" width="82" height="13" rx="3" fill="#ff5470"/><text x="238" y="0" fill="#ffb3bd">186</text></g>
        <g transform="translate(0,104)"><text fill="#ffd7dd">rm-guard</text><rect x="150" y="-10" width="68" height="13" rx="3" fill="#ff5470"/><text x="224" y="0" fill="#ffb3bd">155</text></g>
        <g transform="translate(0,130)"><text fill="#ffd7dd">artifacts-conf.</text><rect x="150" y="-10" width="53" height="13" rx="3" fill="#ff5470"/><text x="209" y="0" fill="#ffb3bd">121</text></g>
        <g transform="translate(0,156)"><text fill="#ffd7dd">plan-html-reminder</text><rect x="150" y="-10" width="52" height="13" rx="3" fill="#f0a35a"/><text x="208" y="0" fill="#f0c79a">119</text></g>
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
    <text x="987" y="132" text-anchor="middle" fill="#d97a86" font-size="11">328 blocks</text>
    <g font-size="11">
      <text x="987" y="176" text-anchor="middle" fill="#ffd7dd">verify-work-</text>
      <text x="987" y="192" text-anchor="middle" fill="#ffd7dd">complete</text>
      <rect x="927" y="206" width="120" height="12" rx="3" fill="#ff5470"/>
      <text x="987" y="238" text-anchor="middle" fill="#ffb3bd" font-size="11">328 · 28 sess</text>
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
    <rect x="180" y="218" width="40" height="52" fill="#ff5470"><title>claude hard blocks: 189 sessions</title></rect>
    <rect x="224" y="130" width="40" height="140" fill="#f0a35a"><title>claude permission denials: 511</title></rect>
    <text x="222" y="288" text-anchor="middle" fill="#cfcfcf" font-size="13">claude</text>
    <text x="200" y="212" text-anchor="middle" fill="#ffb3bd" font-size="11">189</text>
    <text x="244" y="124" text-anchor="middle" fill="#f0c79a" font-size="11">511</text>
  </g>
  <!-- codex hardblock 20 -> 6 ; denials 450 -> 123 -->
  <g>
    <rect x="360" y="264" width="40" height="6" fill="#ff5470"><title>codex hard blocks: 20 sessions</title></rect>
    <rect x="404" y="147" width="40" height="123" fill="#f0a35a"><title>codex permission denials: 450</title></rect>
    <text x="402" y="288" text-anchor="middle" fill="#cfcfcf" font-size="13">codex</text>
    <text x="380" y="258" text-anchor="middle" fill="#ffb3bd" font-size="11">20</text>
    <text x="424" y="141" text-anchor="middle" fill="#f0c79a" font-size="11">450</text>
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
    <rect x="764" y="268" width="40" height="2" fill="#f0a35a"><title>kimi permission denials: 6</title></rect>
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
<figcaption><strong>Figure 3 — Anatomy of the biggest fight: git-guard.</strong> What agents actually try that git-guard vetoes. `git checkout`/`switch` (stranding the user's tree) and `reset --hard` lead — the exact history-destroying moves the worktree law exists to stop.</figcaption>

<svg viewBox="0 0 1000 360" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="git-guard blocked operations" width="100%" font-family="JetBrains Mono, ui-monospace, monospace">
  <!-- horizontal bars, max 92 -> 620px, 6.7 px/unit, x0=260 -->
  <g font-size="13">
    <g transform="translate(0,40)"><text x="248" y="4" text-anchor="end" fill="#cfcfcf">git.checkout</text><rect x="260" y="-11" width="617" height="22" rx="3" fill="#ff5470"/><text x="885" y="4" fill="#ffb3bd">92</text></g>
    <g transform="translate(0,72)"><text x="248" y="4" text-anchor="end" fill="#cfcfcf">git.reset --hard</text><rect x="260" y="-11" width="596" height="22" rx="3" fill="#ff5470"/><text x="864" y="4" fill="#ffb3bd">89</text></g>
    <g transform="translate(0,104)"><text x="248" y="4" text-anchor="end" fill="#cfcfcf">git.branch-delete</text><rect x="260" y="-11" width="449" height="22" rx="3" fill="#ff6f86"/><text x="717" y="4" fill="#ffb3bd">67</text></g>
    <g transform="translate(0,136)"><text x="248" y="4" text-anchor="end" fill="#cfcfcf">git.stash</text><rect x="260" y="-11" width="335" height="22" rx="3" fill="#ff6f86"/><text x="603" y="4" fill="#ffb3bd">50</text></g>
    <g transform="translate(0,168)"><text x="248" y="4" text-anchor="end" fill="#cfcfcf">git.worktree-rm-dirty</text><rect x="260" y="-11" width="275" height="22" rx="3" fill="#ff8a9c"/><text x="543" y="4" fill="#ffb3bd">41</text></g>
    <g transform="translate(0,200)"><text x="248" y="4" text-anchor="end" fill="#cfcfcf">git.push-delete</text><rect x="260" y="-11" width="147" height="22" rx="3" fill="#ffa3b2"/><text x="415" y="4" fill="#ffb3bd">22</text></g>
    <g transform="translate(0,232)"><text x="248" y="4" text-anchor="end" fill="#cfcfcf">git.config-write</text><rect x="260" y="-11" width="147" height="22" rx="3" fill="#ffa3b2"/><text x="415" y="4" fill="#ffb3bd">22</text></g>
    <g transform="translate(0,264)"><text x="248" y="4" text-anchor="end" fill="#cfcfcf">git.worktree-rm-unpushed</text><rect x="260" y="-11" width="134" height="22" rx="3" fill="#ffa3b2"/><text x="402" y="4" fill="#ffb3bd">20</text></g>
    <g transform="translate(0,296)"><text x="260" y="4" text-anchor="start" fill="#8a8a8a">+ force-remove 16 · rebase-outside-wt 9 · reflog 7 · push-force 4 · revert 4 · cherry-pick 4 …</text></g>
  </g>
</svg>
</figure>

## What each hook is for

Every hook, its **event** (when it fires), its **kind** (what it does when it fires), its
one-line **purpose**, and a **verdict**. Kind is the thing to read first: `inject` and
`remind`/`nudge` never stop you; `block` and `gate` do.

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
| artifacts-confidential-guard | block | Stops publishing a confidential artifact to a public share (this is the 121-block one — it's protecting you) | KEEP |
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

## Duplicates, tuning, and the Linear-pollution source

**git-guard vs main-branch-guard are NOT duplicates — they're two axes.** git-guard polices
*what operation* (destructive git verbs, anywhere); main-branch-guard polices *where* (never
the primary tree). `git commit` in your checkout → main-branch-guard. `reset --hard` in a
worktree → git-guard. Merging the policies would be wrong. **But they share ~200 lines of
identical command-parsing shell** (`extract_sh_c_inner`, `check_segment`,
`check_command_string`, `-C` resolution), and the `_json_field` JSON extractor is
copy-pasted into **10** guard scripts. That is the real consolidation win: lift one shared
git-command-parser into `hooks/lib/` (they already share `git-facts.sh`) — same behavior,
one place to fix.

**pr-description-reminder already does what you described** — it's the run-proof gate, not a
vague "write a description" nudge. Keep it. Only blind spot: a `--fill`/`--template`/editor
body it can't read (fails open there).

**plan-html-reminder leaks because it only fires on the formal plan-exit tool.** If an agent
writes the plan as an ordinary message (never entering/exiting Claude's plan mode), the hook
never sees it — which is why you still have to ask. Its render bar is also strict (specific
figure classes), so an agent that renders a non-matching plan gets re-blocked and falls back
to presenting inline. Fix: loosen the gate so any rendered plan HTML clears it, and let the
skill drive quality.

**Linear pollution is NOT caused by a hook — no hook creates tickets.** Agents create them
because two *rules* tell them to, and 100+ agents obey with no cross-session dedup:

- `conventions.md`: *"open one if missing (one per unit of delivery)"*
- your global close-session rule: *"File every follow-up you were about to suggest as a real ticket."*

The `verify-work-complete` Stop gate reinforces it at session end. The result is volume +
redundant tickets + misclassification (each agent guesses project/labels). `linear-inject`
only *reads* your board. Fixing this is a rules edit, not a hook edit.

## Insight

- **The map has two hot lanes, not five.** SessionStart (6 hooks) and UserPromptSubmit (5 hooks) never block — they inject Linear/topology/inflight context and expand promptcuts/bangcuts. All the friction is PreToolUse + Stop. If you are auditing "where agents fight hooks," you can ignore 60% of the hook surface.
- **git-guard and merge-guard are the two heavyweight referees** (456 and 453 blocks). git-guard's top vetoes — `checkout`, `reset --hard`, `branch-delete`, `stash` — are exactly the history-destroying moves the agentic-git workflow forbids. merge-guard's are admin-bypass and merging with no non-author verdict.
- **The loudest antagonist is not a hook.** The auto-mode permission classifier denied 1,386 tool calls — more than half of all hook-blocks combined. For grok it is nearly the *entire* experience of "being stopped" (419 denials vs 35 hook-block sessions).
- **codex fights hardest per session (6.6%), grok softest (1.1%).** claude sits at 5.0% but spreads across all 13 guards; grok concentrates on the classifier + merge-guard.
- **A guard firing zero times is a rule that won.** footer-guard: 0 blocks. Nobody tries the banned footer anymore — the guard is pure standing deterrent.
