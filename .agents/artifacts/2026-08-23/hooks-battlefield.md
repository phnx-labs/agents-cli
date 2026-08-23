---
kind: visual
title: Where the Agents Fight the Hooks
summary: >
  Across 7,493 agent transcripts on 7 harnesses, hooks fire at five lifecycle
  moments — but the fighting is concentrated in exactly two: PreToolUse guards and
  the Stop gate. 1,696 hook fires, plus 1,450 permission-classifier denials —
  and the hooks that fire most are the ones agents obey least.
status: final
date: 2026-08-23
context: agents-cli hook system — activation map + agent/guard collisions mined from fleet transcripts
facts:
  - "13 guards fire real blocks; SessionStart + UserPromptSubmit hooks never block (inject/remind only)"
  - "Top collider: the Stop gate, 561 fires over just 51 sessions — 11 per session"
  - "The auto-mode permission classifier — not a hook — is the single biggest force at 1,450 denials"
  - "footer-guard: 0 blocks — the no-footer rule is fully internalized, the guard never has to fire"
  - "The owner-update reminder fires 811 times and is ignored 58% of the time — the loudest, least obeyed hook"
  - "main-branch-guard recovers 72% — its refusal pastes the worktree recipe instead of only stating the rule"
---

## Story


You asked where the agents fight with the hooks. Here is the map,
mined from **7,493 real session transcripts** across 7 harnesses (claude, codex,
grok, kimi, cursor, droid, antigravity). Every number on this page comes from one
snapshot of that corpus — it is live and still growing, so a re-run moves the
counts by a few.

A hook can fire at **five lifecycle moments**. Four of them are peaceful: SessionStart
and UserPromptSubmit hooks only *inject* context or *remind* — they never stop an
agent. The battlefield is **PreToolUse** (guards that veto a tool call before it runs)
and **Stop** (the gate that refuses a premature "I'm done"). That is where every real
fight happens.

Two forces do the stopping. **Hooks** — 13 guards that fired 1,696 times. And a
non-hook, the **auto-mode permission classifier**, which denied 1,450 tool calls on
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
| git-guard | block · **WHAT** | Vetoes destructive git verbs anywhere: `reset --hard`, force-push, `checkout`/`switch`, `stash`, `clean`, `branch -d`. Worktree-aware | **MERGE** with main-branch-guard |
| main-branch-guard | block · **WHERE** | Vetoes the file **tools** (Write/Edit/…) and `git add`/`commit` in the PRIMARY worktree. **Not raw shell writes** — see below | **MERGE** into git-guard |
| artifacts-confidential-guard | block | Stops publishing a confidential artifact to a public share. **91% delivery** | KEEP |
| merge-guard | block | Stops admin-bypass merges and merges with no non-author verdict. **85% delivery** | KEEP |
| rm-guard | block | Stops destructive `rm` on protected paths | KEEP |
| secrets-guard | block | Stops secret-materializing one-liners (plaintext export, reveal) | KEEP |
| large-file-add-guard | block | Stops `git add` of a file > 5 MiB | **MERGE** into git-guard |
| git-require-clean-tree | block | Stops pull/rebase on a dirty tree | **MERGE** into git-guard |
| teams-roster-guard | block | Forces mixed rosters (blocks a 3rd same-harness teammate) | KEEP |
| user-message-guard | block | Bounces an over-long owner notification | **CUT** — 10 fires, 30% delivery |
| footer-guard | block | Stops the promo footer in PR/commit bodies | **CUT** — 0 fires in 7,493 transcripts |
| **pr-description-reminder** | nudge | On `gh pr create/edit` with no run-proof, demands a screenshot/recording/test output + ticket link. **89% delivery** | KEEP |
| **plan-html-reminder** | nudge | Render the plan as HTML before presenting. Fires on `ExitPlanMode` *and* at Stop. **11% delivery, 60% never render** | **CUT** |

**Stop — the `gate` lane**

| Hook | Purpose | Verdict |
|---|---|---|
| verify-work-complete | Blocks a premature "done" without verification / handoff; also reinforces closing Linear + posting one update | KEEP · but see ticketing note |
| no-permission-stop-guard | Blocks stopping on an unanswered permission prompt | KEEP |

## What each hook actually prints

Not paraphrased — these are real outputs, either captured from fleet transcripts or
produced by running the hook against a crafted payload. Two shapes dominate.

**Shape 1 — the `blocked_op:` triple.** The Bash guards emit three machine-parseable
lines: what was blocked, why, and the alternative. This is the format worth copying,
because the third line is the one that makes an agent recover.

```
blocked_op: git.reset
reason: git reset is denied (rewrites history or destroys work).
do_this_instead: reconcile with `git rebase origin/<default>` (or `git pull --rebase`);
  never `reset --hard`. Commit instead of stashing; resolve obstacles at the source.
```

```
blocked_op: rm.protected-path
reason: rm -r on protected path denied: ~/.agents. Protected paths: /, $HOME, ~/.agents,
  ~/.ssh, ~/.config, … Variable-expansion targets ($VAR) are also denied because their
  value is unknown at hook time.
do_this_instead: use `trash` (or move to /tmp), or scope the path to a non-protected dir.
```

```
blocked_op: secrets.export-plaintext
reason: secrets export --plaintext prints a whole bundle to stdout — inside an agent
  session that lands in the model context and the session transcript (RUSH-2774).
do_this_instead: run the consuming command under `agents secrets exec <bundle> -- …`.
```

**Shape 2 — prose block, prefixed by the harness.** The rule-bundled guards return a
paragraph. The harness wraps it with the hook's own path, which is how you tell which
file to go edit:

```
PreToolUse:Bash hook error: [~/.agents/.cache/shims/hooks/gh-merge-guard__merge-guard.sh]:
Blocked: no non-author review verdict found ON this PR (phnx-labs/agents-cli#2921).
A GitHub APPROVED review or an APPROVE verdict comment must be posted on the PR being
merged — a verdict 'carried from' another PR satisfies nothing (the #2736 laundering
pattern). Get the automated reviewer's verdict or spawn a non-author subagent review…
```

**`main-branch-guard` — the one that hands over the fix.** This is why it recovers 72%
while others don't: `$REPO` is already filled in, so the agent can paste and continue.

```
Blocked: editing '/…/agents-cli/README.md' in the PRIMARY working tree of
/…/agents-cli (branch 'main').

No agent may modify the user's primary working tree — on ANY branch. …

Create a worktree off the freshly-fetched default branch, then work there:
  REPO=/…/agents-cli
  git -C "$REPO" fetch origin
  BASE=$(git -C "$REPO" symbolic-ref --short refs/remotes/origin/HEAD | sed 's#^origin/##')
  git -C "$REPO" worktree add -b <slug> "$REPO/.agents/worktrees/<slug>" "origin/$BASE"
then edit under $REPO/.agents/worktrees/<slug>/, commit there, push, and open a PR.
```

**`user-message-guard` — 770 chars of message, 380 chars of scolding about it.**

```
[concise-message-guard] This update is 1 lines / 770 chars — too long for a phone text.
The owner reads these like texts from a worker, not a report. Rewrite as 1-4 short lines:
lead with the one thing you need him to do (or 'FYI, no action'), plainest language, and
put any detail behind a link (PR/ticket) or a file path he can open — the text is the
pointer, not the payload. Then resend with agents notify --text "…".
```

**The silent majority print nothing at all.** A guard that allows exits `0` with empty
output — 284,387 of 285,667 fires looked exactly like this:

```
$ echo '{"tool_name":"Bash","tool_input":{"command":"git status"}}' | git-guard.sh
$ echo $?
0
```

**SessionStart hooks inject markdown into the context instead.** They never block; their
entire product is text prepended to the session. Real injections from this session:

```
## In-flight in this repo (auto-injected)
Open PRs:
- #2914 fix: sync remote editor tab titles (RUSH-3011) (fix-session-tab-title-sync…)
- #2909 fix(session): sync remote editor tab titles (fix-session-tab-title-sync-current)
```

```
## Host & Fleet
You are running on **worker-a** (linux).
- builder-1 — macos — offline
- worker-b — linux — online — 6% load / 66% mem / busy
…
Fleet capacity: 190 cores · 418G free / 602G RAM (70% free) across 12 reachable devices.
```

`linear-inject-tasks` uses the same shape but is by far the largest — roughly **90 lines**
of board state per session, which is the real SessionStart context cost. `autosync`, by
contrast, deliberately prints **nothing**: its own header says stdout stays empty because
SessionStart stdout is injected into the model context.

**The verdict this section supports:** the `blocked_op:` triple is the right format —
short, parseable, and it names the alternative. The prose guards should adopt it. And
the length of a refusal is not what makes it work: `main-branch-guard` is long but
recovers 72% because it ends in a runnable command, while `user-message-guard` spends
380 characters and changes almost nothing.

## Data


Now the counts — every name below is defined in the table above.

**Guards ranked by fires (all harnesses, `.jsonl` transcripts only)**

| Guard | Event | Kind | Fires | Sessions | Per session |
|---|---|---|---:|---:|---:|
| verify-work-complete | Stop | hard · gate | 561 | 51 | **11.0** |
| git-guard | PreToolUse | hard · data-loss | 245 | 138 | 1.8 |
| merge-guard | PreToolUse | hard · workflow | 240 | 85 | 2.8 |
| pr-description-reminder | PreToolUse | soft · reminder | 174 | 106 | 1.6 |
| main-branch-guard | PreToolUse | hard · workflow | 131 | 63 | 2.1 |
| rm-guard | PreToolUse | hard · data-loss | 90 | 60 | 1.5 |
| plan-html-reminder | PreToolUse | soft · reminder | 76 | 39 | 1.9 |
| large-file-add-guard | PreToolUse | hard · data-loss | 38 | 11 | 3.5 |
| git-require-clean-tree | PreToolUse | hard · data-loss | 38 | 10 | 3.8 |
| artifacts-confidential-guard | PreToolUse | hard · data-loss | 35 | 4 | **8.8** |
| teams-roster-guard | PreToolUse | hard · workflow | 33 | 4 | **8.2** |
| user-message-guard | PreToolUse | hard · workflow | 21 | 9 | 2.3 |
| secrets-guard | PreToolUse | hard · secret | 14 | 7 | 2.0 |
| footer-guard | PreToolUse | hard · workflow | 0 | 0 | — |
| **total hook fires** | | | **1,696** | | |
| *auto-mode classifier (not a hook)* | permission | denial | 1,450 | | |

> **Counting note.** One fire is written into a transcript row twice — once under
> `message`, once under `toolUseResult`. Counting string occurrences therefore
> roughly doubles every guard. These are **row counts: one row, one fire.** An
> earlier revision of this page reported the occurrence counts (git-guard 456,
> merge-guard 453) and overstated every guard by ~2x.

**Which agent collides, and how often** (sessions hitting a hard block vs permission denials)

| Harness | Transcripts | Sessions w/ hard block | Rate | Permission denials |
|---|---:|---:|---:|---:|
| claude | 3,923 | 269 | 6.9% | 542 |
| codex | 315 | 39 | 12.4% | 481 |
| grok | 3,145 | 38 | 1.2% | 420 |
| kimi | 12 | 0 | 0.0% | 7 |
| cursor | 9 | 0 | 0.0% | 0 |
| droid | 60 | 0 | 0.0% | 0 |
| antigravity | 29 | 0 | 0.0% | 0 |

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
    <text x="689" y="112" text-anchor="middle" fill="#d97a86" font-size="11">13 guards · 1,135 fires</text>
    <!-- guard chips as mini rows with bar -->
    <g font-size="11">
      <!-- helper: name left, count-bar right -->
      <g transform="translate(492,140)">
        <!-- rows -->
        <g transform="translate(0,0)"><text fill="#ffd7dd">git-guard</text><rect x="150" y="-10" width="200" height="13" rx="3" fill="#ff5470"/><text x="356" y="0" fill="#ffb3bd">245</text></g>
        <g transform="translate(0,26)"><text fill="#ffd7dd">merge-guard</text><rect x="150" y="-10" width="196" height="13" rx="3" fill="#ff5470"/><text x="352" y="0" fill="#ffb3bd">240</text></g>
        <g transform="translate(0,52)"><text fill="#ffd7dd">pr-desc-reminder</text><rect x="150" y="-10" width="142" height="13" rx="3" fill="#f0a35a"/><text x="298" y="0" fill="#f0c79a">174</text></g>
        <g transform="translate(0,78)"><text fill="#ffd7dd">main-branch-guard</text><rect x="150" y="-10" width="107" height="13" rx="3" fill="#ff5470"/><text x="263" y="0" fill="#ffb3bd">131</text></g>
        <g transform="translate(0,104)"><text fill="#ffd7dd">rm-guard</text><rect x="150" y="-10" width="73" height="13" rx="3" fill="#ff5470"/><text x="229" y="0" fill="#ffb3bd">90</text></g>
        <g transform="translate(0,130)"><text fill="#ffd7dd">plan-html-reminder</text><rect x="150" y="-10" width="62" height="13" rx="3" fill="#f0a35a"/><text x="218" y="0" fill="#f0c79a">76</text></g>
        <g transform="translate(0,156)"><text fill="#ffd7dd">large-file-add</text><rect x="150" y="-10" width="31" height="13" rx="3" fill="#ff5470"/><text x="187" y="0" fill="#ffb3bd">38</text></g>
        <g transform="translate(0,182)"><text fill="#ffd7dd">clean-tree</text><rect x="150" y="-10" width="31" height="13" rx="3" fill="#ff5470"/><text x="187" y="0" fill="#ffb3bd">38</text></g>
        <g transform="translate(0,208)"><text fill="#ffd7dd">artifacts-conf.</text><rect x="150" y="-10" width="29" height="13" rx="3" fill="#ff5470"/><text x="185" y="0" fill="#ffb3bd">35</text></g>
        <g transform="translate(0,234)"><text fill="#ffd7dd">teams-roster</text><rect x="150" y="-10" width="27" height="13" rx="3" fill="#ff5470"/><text x="183" y="0" fill="#ffb3bd">33</text></g>
        <g transform="translate(0,260)"><text fill="#ffd7dd">user-msg-guard</text><rect x="150" y="-10" width="17" height="13" rx="3" fill="#ff5470"/><text x="173" y="0" fill="#ffb3bd">21</text></g>
        <g transform="translate(0,286)"><text fill="#ffd7dd">secrets-guard</text><rect x="150" y="-10" width="11" height="13" rx="3" fill="#ff5470"/><text x="167" y="0" fill="#ffb3bd">14</text></g>
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
    <text x="987" y="132" text-anchor="middle" fill="#d97a86" font-size="11">561 fires</text>
    <g font-size="11">
      <text x="987" y="176" text-anchor="middle" fill="#ffd7dd">verify-work-</text>
      <text x="987" y="192" text-anchor="middle" fill="#ffd7dd">complete</text>
      <rect x="927" y="206" width="120" height="12" rx="3" fill="#ff5470"/>
      <text x="987" y="238" text-anchor="middle" fill="#ffb3bd" font-size="11">561 · 51 sess</text>
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
  <!-- scale: max 542 -> 240px -->
  <g font-size="12" fill="#8a8a8a">
    <text x="112" y="274" text-anchor="end">0</text>
    <line x1="120" y1="181" x2="960" y2="181" stroke="#242424"/><text x="112" y="185" text-anchor="end">200</text>
    <line x1="120" y1="93" x2="960" y2="93" stroke="#242424"/><text x="112" y="97" text-anchor="end">400</text>
    <line x1="120" y1="4" x2="960" y2="4" stroke="#242424"/><text x="112" y="8" text-anchor="end">600</text>
  </g>
  <g>
    <rect x="180" y="151" width="40" height="119" fill="#ff5470"><title>claude hard blocks: 269 sessions</title></rect>
    <rect x="224" y="30" width="40" height="240" fill="#f0a35a"><title>claude permission denials: 542</title></rect>
    <text x="222" y="288" text-anchor="middle" fill="#cfcfcf" font-size="13">claude</text>
    <text x="200" y="145" text-anchor="middle" fill="#ffb3bd" font-size="11">269</text>
    <text x="244" y="24" text-anchor="middle" fill="#f0c79a" font-size="11">542</text>
  </g>
  <g>
    <rect x="360" y="253" width="40" height="17" fill="#ff5470"><title>codex hard blocks: 39 sessions</title></rect>
    <rect x="404" y="57" width="40" height="213" fill="#f0a35a"><title>codex permission denials: 481</title></rect>
    <text x="402" y="288" text-anchor="middle" fill="#cfcfcf" font-size="13">codex</text>
    <text x="380" y="247" text-anchor="middle" fill="#ffb3bd" font-size="11">39</text>
    <text x="424" y="51" text-anchor="middle" fill="#f0c79a" font-size="11">481</text>
  </g>
  <g>
    <rect x="540" y="253" width="40" height="17" fill="#ff5470"><title>grok hard blocks: 38 sessions</title></rect>
    <rect x="584" y="84" width="40" height="186" fill="#f0a35a"><title>grok permission denials: 420</title></rect>
    <text x="582" y="288" text-anchor="middle" fill="#cfcfcf" font-size="13">grok</text>
    <text x="560" y="247" text-anchor="middle" fill="#ffb3bd" font-size="11">38</text>
    <text x="604" y="78" text-anchor="middle" fill="#f0c79a" font-size="11">420</text>
  </g>
  <g>
    <rect x="720" y="268" width="40" height="2" fill="#ff5470"><title>kimi hard blocks: 0 sessions</title></rect>
    <rect x="764" y="267" width="40" height="3" fill="#f0a35a"><title>kimi permission denials: 7</title></rect>
    <text x="762" y="288" text-anchor="middle" fill="#cfcfcf" font-size="13">kimi</text>
    <text x="740" y="262" text-anchor="middle" fill="#8a8a8a" font-size="11">0</text>
    <text x="784" y="261" text-anchor="middle" fill="#8a8a8a" font-size="11">7</text>
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
<figcaption><strong>Figure 3 — Anatomy of the biggest fight: git-guard.</strong> What agents actually try that git-guard vetoes. `reset --hard` and `git checkout` (stranding the user's tree) lead — the exact history-destroying moves the worktree law exists to stop. 243 of git-guard's 245 fires carry a parseable verb.</figcaption>

<svg viewBox="0 0 1000 360" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="git-guard blocked operations" width="100%" font-family="JetBrains Mono, ui-monospace, monospace">
  <!-- horizontal bars, max 92 -> 620px, 6.7 px/unit, x0=260 -->
  <g font-size="13">
    <g transform="translate(0,40)"><text x="248" y="4" text-anchor="end" fill="#cfcfcf">git.reset --hard</text><rect x="260" y="-11" width="617" height="22" rx="3" fill="#ff5470"/><text x="885" y="4" fill="#ffb3bd">53</text></g>
    <g transform="translate(0,72)"><text x="248" y="4" text-anchor="end" fill="#cfcfcf">git.checkout</text><rect x="260" y="-11" width="605" height="22" rx="3" fill="#ff5470"/><text x="873" y="4" fill="#ffb3bd">52</text></g>
    <g transform="translate(0,104)"><text x="248" y="4" text-anchor="end" fill="#cfcfcf">git.branch-delete</text><rect x="260" y="-11" width="419" height="22" rx="3" fill="#ff6f86"/><text x="687" y="4" fill="#ffb3bd">36</text></g>
    <g transform="translate(0,136)"><text x="248" y="4" text-anchor="end" fill="#cfcfcf">git.stash</text><rect x="260" y="-11" width="291" height="22" rx="3" fill="#ff6f86"/><text x="559" y="4" fill="#ffb3bd">25</text></g>
    <g transform="translate(0,168)"><text x="248" y="4" text-anchor="end" fill="#cfcfcf">git.worktree-rm-dirty</text><rect x="260" y="-11" width="268" height="22" rx="3" fill="#ff8a9c"/><text x="536" y="4" fill="#ffb3bd">23</text></g>
    <g transform="translate(0,200)"><text x="248" y="4" text-anchor="end" fill="#cfcfcf">git.config-write</text><rect x="260" y="-11" width="140" height="22" rx="3" fill="#ffa3b2"/><text x="408" y="4" fill="#ffb3bd">12</text></g>
    <g transform="translate(0,232)"><text x="248" y="4" text-anchor="end" fill="#cfcfcf">git.worktree-rm-unpushed</text><rect x="260" y="-11" width="128" height="22" rx="3" fill="#ffa3b2"/><text x="396" y="4" fill="#ffb3bd">11</text></g>
    <g transform="translate(0,264)"><text x="248" y="4" text-anchor="end" fill="#cfcfcf">git.push-delete</text><rect x="260" y="-11" width="116" height="22" rx="3" fill="#ffa3b2"/><text x="384" y="4" fill="#ffb3bd">10</text></g>
    <g transform="translate(0,296)"><text x="260" y="4" text-anchor="start" fill="#8a8a8a">+ 21 more across 9 rarer verbs</text></g>
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

**The primary tree is not actually protected from writes — only from commits.**
Probed against a real repo, all four file tools are vetoed and all eleven raw-shell
writes are not:

| probe | result |
|---|---|
| `Write` · `Edit` · `MultiEdit` · `NotebookEdit` | **blocked** (4/4) |
| `echo >` · `>>` · `sed -i` · `tee` · `cp` · `mv` · `: >` · `touch` · `mkdir` · `rm` · `python3 -c open(...,'w')` | **allowed (11/11)** |
| `git add` · `git commit` | blocked |

So the real guarantee is *"an agent cannot **commit** to your checkout"*, not *"an
agent cannot modify it"*. These are not evasions — `echo x > file` and `sed -i` are
ordinary commands an agent writes without any intent to circumvent. The commit choke
point still prevents anything from landing, but a dirtied working tree is a real cost
the earlier wording hid.

**main-branch-guard is healthy, and its refusal is the model to copy.** 72% of
blocked agents recover within 40 messages — 25 open a fresh worktree, 36 re-aim
into one they already had. The reason is visible in the refusal text itself
(`main-branch-guard.sh:198-203`): it does not just say *no*, it pastes the
four-line worktree recipe with `$REPO` already filled in. A guard that hands over
the fix outperforms one that only states the rule. The 24 non-recoveries are
mostly sessions that changed direction entirely, not agents left stuck.

**The Stop gate's 97% is not a real number.** For a gate whose demand is "keep
working," the only measurable compliance is "did any tool call follow," which is
true almost by construction. What *is* real: 561 fires across 51 sessions, **11
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

## Proposal — 14 guards down to 8

The criterion is not "does the agent obey." It is **does the hook push the agent to
finish the work end to end, without excuses.** Scored that way — what the session
actually did in the 40 messages after each fire — the portfolio splits cleanly.

| | hook | fires | **delivered after** | why |
|---|---|---:|---:|---|
| **merge → 1** | git-guard | 245 | 39% | all four parse git commands on `Bash` |
| | main-branch-guard | 131 | 59% | matcher is a superset of git-guard's |
| | git-require-clean-tree | 38 | 59% | same parser again |
| | large-file-add-guard | 38 | — | inspects `git add` — same parser again |
| **keep** | pr-description-reminder | 174 | **89%** | the evidence gate; blocks without derailing |
| | merge-guard | 240 | **85%** | blocks the bypass, agent still ships |
| | artifacts-confidential-guard | 35 | **91%** | prevents a leak at near-zero drag |
| | verify-work-complete + verify-work-state | 561 | 21% | the *only* anti-excuse mechanism |
| | rm-guard · secrets-guard | 90 · 14 | 39% · 54% | data loss, credentials |
| | teams-roster-guard | 33 | 60% | cheap, rarely fires |
| **cut** | **plan-html-reminder** | 76 | **11%** | worst in the system |
| | footer-guard | **0** | — | never fired once in 7,493 transcripts |
| | user-message-guard | 21 | 30% | marginal at any volume |

**Merge the four git guards into one.** `main-branch-guard`'s matcher
(`Bash|Write|Edit|MultiEdit|NotebookEdit`) is a **superset** of `git-guard`'s (`Bash`),
so every Bash tool call today spawns both scripts and parses the same command string
twice with near-identical code — that is where the ~200 duplicated lines live. Two
axes (*what operation* vs *where*) are two **functions**, not two hooks. Folding
`git-require-clean-tree` and `large-file-add-guard` in costs nothing: both already
parse git commands. One spawn, one parser, one place to fix.

**`plan-html-reminder` is the least helpful hook you have.** 11% delivery — the lowest
of anything measured — and it interrupts at exactly the moment the agent is about to
hand over a plan. 60% of the time the agent does not even attempt the render it asks
for. It is ceremony charged at the delivery moment.

**`footer-guard` has never fired — and its first fire was a false positive.** Zero
blocks across 7,493 transcripts; the rule text alone fully internalized the behavior.
Then, while this page was being written, it fired for the first time — on an edit that
merely *quoted the banned string inside documentation about the guard itself*. It
matches the literal text anywhere in a `Bash` command, so writing about it trips it.
A guard whose only recorded fire is a false positive is not a deterrent, it is a tax.

**What actually forces delivery is thin.** Eleven of thirteen guards prevent *damage*;
essentially one hook — the Stop gate, plus the `verify-work-state` record that gives it
a goal boundary — prevents *quitting*. If the goal is agents that finish without
excuses, the leverage is not in tuning guards. It is that the entire anti-excuse job
rests on one hook firing 11 times per session.

**Compact the messages.** `rules/README.md:57` already states the principle — *"Every
line costs context on every agent, on every machine, forever."* The guard refusals and
these very descriptions violate it. `main-branch-guard`'s refusal is the model worth
copying, though: it pastes the four-line worktree recipe with `$REPO` filled in, and
it recovers 72%. Short, and it hands over the fix.

## The latency bill, and what to gate off in plan mode

The hook shims write timings to `~/.agents/.cache/perf/perf.db`. **285,667 recorded
fires. 284 of them changed the outcome.**

> **Window.** That table covers **2026-08-03 → 08-08 only** — 4.2 days, ~67,700 hook
> fires a day. Timing collection has not written a row since 2026-08-08, so these are
> a five-day sample from earlier this month, not an all-time or current total. The
> per-call latencies and the hit rate are what that window measured; the block counts
> elsewhere on this page come from the transcript corpus and are current.

<figure>
<figcaption><strong>Figure 5 — What every Bash call pays.</strong> Nine guards fire on every single <code>Bash</code> tool call, serially, before the command runs. Bar width is measured average latency; the number on the right is how often that guard actually blocked anything.</figcaption>

<svg viewBox="0 0 1000 360" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Per-Bash-call guard latency" width="100%" font-family="JetBrains Mono, ui-monospace, monospace">
  <g font-size="13">
    <g transform="translate(0,40)"><text x="228" y="4" text-anchor="end" fill="#cfcfcf">git-guard</text><rect x="240" y="-11" width="520" height="22" rx="3" fill="#ff5470"/><text x="770" y="4" fill="#ffb3bd">63 ms</text><text x="850" y="4" fill="#8a8a8a">0.89%</text></g>
    <g transform="translate(0,72)"><text x="228" y="4" text-anchor="end" fill="#cfcfcf">rm-guard</text><rect x="240" y="-11" width="495" height="22" rx="3" fill="#ff5470"/><text x="745" y="4" fill="#ffb3bd">60 ms</text><text x="850" y="4" fill="#8a8a8a">0.33%</text></g>
    <g transform="translate(0,104)"><text x="228" y="4" text-anchor="end" fill="#cfcfcf">main-branch-guard</text><rect x="240" y="-11" width="446" height="22" rx="3" fill="#ff6f86"/><text x="696" y="4" fill="#ffb3bd">54 ms</text><text x="850" y="4" fill="#8a8a8a">0.44%</text></g>
    <g transform="translate(0,136)"><text x="228" y="4" text-anchor="end" fill="#cfcfcf">large-file-add-guard</text><rect x="240" y="-11" width="206" height="22" rx="3" fill="#ff8a9c"/><text x="456" y="4" fill="#ffb3bd">25 ms</text><text x="850" y="4" fill="#8a8a8a">0.14%</text></g>
    <g transform="translate(0,168)"><text x="228" y="4" text-anchor="end" fill="#cfcfcf">merge-guard</text><rect x="240" y="-11" width="157" height="22" rx="3" fill="#ffa3b2"/><text x="407" y="4" fill="#ffb3bd">19 ms</text><text x="850" y="4" fill="#8a8a8a">0.87%</text></g>
    <g transform="translate(0,200)"><text x="228" y="4" text-anchor="end" fill="#cfcfcf">pr-description-reminder</text><rect x="240" y="-11" width="149" height="22" rx="3" fill="#ffa3b2"/><text x="399" y="4" fill="#ffb3bd">18 ms</text><text x="850" y="4" fill="#8a8a8a">0.63%</text></g>
    <g transform="translate(0,232)"><text x="228" y="4" text-anchor="end" fill="#cfcfcf">git-require-clean-tree</text><rect x="240" y="-11" width="149" height="22" rx="3" fill="#ffa3b2"/><text x="399" y="4" fill="#ffb3bd">18 ms</text><text x="850" y="4" fill="#8a8a8a">0.14%</text></g>
    <g transform="translate(0,264)"><text x="228" y="4" text-anchor="end" fill="#cfcfcf">user-message-guard</text><rect x="240" y="-11" width="149" height="22" rx="3" fill="#ffa3b2"/><text x="399" y="4" fill="#ffb3bd">18 ms</text><text x="850" y="4" fill="#8a8a8a">0.08%</text></g>
    <g transform="translate(0,296)"><text x="228" y="4" text-anchor="end" fill="#cfcfcf">footer-guard</text><rect x="240" y="-11" width="149" height="22" rx="3" fill="#6a6a6a"/><text x="399" y="4" fill="#8a8a8a">18 ms</text><text x="850" y="4" fill="#8a8a8a">0.00%</text></g>
  </g>
  <line x1="240" y1="318" x2="760" y2="318" stroke="#3a3a3a"/>
  <text x="240" y="340" fill="#ff8a9c" font-size="14" font-weight="700">292 ms added to every Bash call</text>
  <text x="850" y="340" fill="#8a8a8a" font-size="12">hit rate</text>
</svg>
</figure>

**Every `Bash` tool call pays 292 ms** before the command starts, across nine guards.
Total recorded hook wall-clock: **2.66 hours**. The hit rate that buys is **0.099%**.

That is not an argument for deleting the guards — `git-guard`'s 131 blocks are 131
prevented `reset --hard`es, and its cost is worth paying. It *is* an argument for not
running a guard in a mode where it cannot possibly fire.

### The mode matrix

`matches.permission_mode` already exists and is merged
(`apps/cli/src/lib/hooks/match.ts:145`), so this is a **config change in `hooks.yaml`,
not new code**.

| Hook | plan | edit / auto | why |
|---|:--:|:--:|---|
| git-guard | **on** | **on** | Bash still runs in plan mode; `reset --hard` is still reachable |
| rm-guard | **on** | **on** | same — data loss is mode-independent |
| secrets-guard | **on** | **on** | a credential can leak from a read-only session |
| main-branch-guard | *bash only* | **on** | its Write/Edit arm is already dead in plan mode |
| merge-guard | **off** | **on** | nothing merges from a planning turn |
| pr-description-reminder | **off** | **on** | nothing opens a PR from a planning turn |
| large-file-add-guard | **off** | **on** | no `git add` in plan mode |
| git-require-clean-tree | **off** | **on** | no pull/rebase in plan mode |
| footer-guard | **off** | **off** | cut entirely — 0 real blocks |
| user-message-guard | **off** | **off** | cut entirely — 0.08% |
| verify-work-complete | **plan-aware** | **on** | "done" in plan mode means *the plan is delivered*, not *the PR is merged* — it should audit against the plan, not the delivery chain |

Gating those five off in plan mode drops the per-Bash tax from **292 ms → 176 ms**.
Combined with merging the four git guards into one script, a planning turn pays
**~123 ms** instead of 292 — a **2.4x** cut on every command the agent runs while
thinking.

### A hook broke for 18 hours and nothing said so

`activity-log-result` exited **127 — command not found — 983 times**, while still
costing 40 ms per call. Worth stating precisely, because the raw count reads worse
than the truth: every one of those failures falls inside a single **18-hour window on
2026-08-03 22:14 → 08-04 16:11**, and there are none after it. Running the hook today
exits 0. So this was a bounded incident that resolved itself, not a hook that is
broken now.

The defect it exposes is still real: **for eighteen hours a hook could not run at all,
and nothing reported it.** The shim bakes an absolute path into one version home
(`.../versions/claude/2.1.219/home/.claude/hooks/11-activity-log.py`), so any session
whose version home does not carry that file gets `127` — silently, at full latency
cost, with the agent none the wiser. A hook that cannot execute should fail loudly at
install or sync time. The only reason this is visible at all is that the shim happens
to record exit codes; nothing reads them.

## The same duplication, one layer up: skills and commands

The guards duplicate a command parser. The **skills** duplicate a pipeline — and
the numbers are worse, because prose has no compiler to catch it.

<figure>
<figcaption><strong>Figure 6 — One pipeline, three skills teaching it.</strong> Every skill that produces an HTML artifact re-teaches the same five mechanics. Counts are occurrences of each concept inside each SKILL.md.</figcaption>

<svg viewBox="0 0 1000 330" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Skill overlap" width="100%" font-family="JetBrains Mono, ui-monospace, monospace">
  <g font-size="12" fill="#8a8a8a">
    <text x="300" y="34" text-anchor="middle">artifacts render</text>
    <text x="440" y="34" text-anchor="middle">frontmatter</text>
    <text x="580" y="34" text-anchor="middle">light/dark</text>
    <text x="710" y="34" text-anchor="middle">inline-SVG</text>
    <text x="860" y="34" text-anchor="middle">headless inspect</text>
  </g>
  <g font-size="13">
    <g transform="translate(0,80)">
      <text x="210" y="5" text-anchor="end" fill="#cfcfcf">artifacts · 131 ln</text>
      <circle cx="300" cy="0" r="14" fill="#7fae5f"/><text x="300" y="5" text-anchor="middle" fill="#0e1f16">2</text>
      <circle cx="440" cy="0" r="18" fill="#7fae5f"/><text x="440" y="5" text-anchor="middle" fill="#0e1f16">4</text>
      <circle cx="580" cy="0" r="16" fill="#7fae5f"/><text x="580" y="5" text-anchor="middle" fill="#0e1f16">3</text>
      <circle cx="710" cy="0" r="14" fill="#7fae5f"/><text x="710" y="5" text-anchor="middle" fill="#0e1f16">2</text>
      <circle cx="860" cy="0" r="14" fill="#7fae5f"/><text x="860" y="5" text-anchor="middle" fill="#0e1f16">2</text>
    </g>
    <g transform="translate(0,150)">
      <text x="210" y="5" text-anchor="end" fill="#ffd7dd">plan-render · 208 ln</text>
      <circle cx="300" cy="0" r="18" fill="#ff5470"/><text x="300" y="5" text-anchor="middle" fill="#2a0e12">4</text>
      <circle cx="440" cy="0" r="14" fill="#ff5470"/><text x="440" y="5" text-anchor="middle" fill="#2a0e12">2</text>
      <circle cx="580" cy="0" r="18" fill="#ff5470"/><text x="580" y="5" text-anchor="middle" fill="#2a0e12">4</text>
      <circle cx="710" cy="0" r="16" fill="#ff5470"/><text x="710" y="5" text-anchor="middle" fill="#2a0e12">3</text>
      <circle cx="860" cy="0" r="18" fill="#ff5470"/><text x="860" y="5" text-anchor="middle" fill="#2a0e12">4</text>
    </g>
    <g transform="translate(0,220)">
      <text x="210" y="5" text-anchor="end" fill="#ffd7dd">visualize · 166 ln</text>
      <circle cx="300" cy="0" r="14" fill="#ff5470"/><text x="300" y="5" text-anchor="middle" fill="#2a0e12">2</text>
      <circle cx="440" cy="0" r="11" fill="#ff5470"/><text x="440" y="5" text-anchor="middle" fill="#2a0e12">1</text>
      <circle cx="580" cy="0" r="18" fill="#ff5470"/><text x="580" y="5" text-anchor="middle" fill="#2a0e12">4</text>
      <circle cx="710" cy="0" r="18" fill="#ff5470"/><text x="710" y="5" text-anchor="middle" fill="#2a0e12">4</text>
      <circle cx="860" cy="0" r="18" fill="#ff5470"/><text x="860" y="5" text-anchor="middle" fill="#2a0e12">4</text>
    </g>
  </g>
  <line x1="230" y1="265" x2="920" y2="265" stroke="#3a3a3a"/>
  <text x="230" y="292" fill="#ff8a9c" font-size="14" font-weight="700">505 lines across 3 skills — one pipeline</text>
  <text x="920" y="292" text-anchor="end" fill="#7fae5f" font-size="13">keep 1 · delete 2</text>
</svg>
</figure>

**`plan-render` and `visualize` are `artifacts` with a different noun in front.**
All three teach: author Markdown → `artifacts render` → branded light/dark HTML with
inline-SVG figures → inspect it headlessly. The *policies* genuinely differ — a plan
owes a current-vs-proposed figure and a declared `surface:`, a visual owes one
striking hero — but that is a **section**, not a skill. The pipeline underneath is
identical, and a pipeline written out three times is a pipeline that drifts three
ways.

The consolidation follows the artifact CLI's own model: the noun is already a
`kind:` in frontmatter (`kind: visual` renders this page; plans use `kind: plan`).
The skills should mirror what the tool already does rather than re-partition it.

### `/share:public` and `/share:private` are two flags wearing two commands

16 and 18 lines. Masking the words *public* / *private* / *unlisted* and diffing them,
the entire functional difference is:

```
public    agents artifacts share <file>
private   agents artifacts share <file> --no-cover --expire 7d
```

Resolving the file, checking `share status`, reporting the link — duplicated in both.
`private.md` step 1 gives it away in writing: *"(same as `/share:public`)"*. A file
that documents its own duplication is the clearest possible signal.

The CLI already takes the flags and a `share` skill already exists, so the surface
should be **one** command where public is the default and private is a modifier.

| | today | proposed |
|---|---|---|
| pipeline skills | `artifacts` 131 · `plan-render` 208 · `visualize` 166 | **`artifacts`** (~200), with `kind: plan` and `kind: visual` sections |
| share surface | `share` skill 67 · `/share:public` 16 · `/share:private` 18 | **`share`** skill + one `/share` |
| total | **606 lines** | **~270** |

**One caveat before cutting.** `plan-html-reminder` greps rendered plans for a
declared `surface:` and specific figure markup, so any consolidation has to preserve
those exact contracts or the guard starts false-blocking the very plans it is meant
to enforce. Its test suite is the check.

## Insight


- **The map has two hot lanes, not five.** SessionStart (6 hooks) and UserPromptSubmit (5 hooks) never block — they inject Linear/topology/inflight context and expand promptcuts/bangcuts. All the friction is PreToolUse + Stop. If you are auditing "where agents fight hooks," you can ignore 60% of the hook surface.
- **The Stop gate is the heaviest hook in the system** — 561 fires, 11 per session it touches, more than git-guard and merge-guard put together. Among PreToolUse guards those two lead (245 and 240): git-guard's top vetoes are `reset --hard`, `checkout`, `branch-delete`, `stash` — exactly the history-destroying moves the agentic-git workflow forbids; merge-guard's are admin-bypass and merging with no non-author verdict.
- **The loudest antagonist is not a hook.** The auto-mode permission classifier denied 1,450 tool calls — nearly as many as all 13 guards combined (1,696). For grok it is almost the *entire* experience of "being stopped".
- **codex fights hardest per session (12.4%), grok softest (1.2%).** claude sits at 6.9% but spreads across all 13 guards; grok concentrates on the classifier + merge-guard.
- **A guard firing zero times is a rule that won.** footer-guard: 0 fires. Nobody tries the banned footer anymore — the guard is pure standing deterrent. The inverse also holds: a hook that fires three times a session and is ignored 58% of the time is a rule nobody internalized, and the fix is the message, not more volume.
