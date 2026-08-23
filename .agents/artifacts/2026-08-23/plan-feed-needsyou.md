---
kind: plan
surface: native
title: Feed-driven Needs You for AGI EXT
summary: Make the CLI feed the canonical attention ledger and stream one reconciled operator projection to AGI EXT, while preserving session lifecycle as a fallback signal rather than a second UI authority.
status: draft
links:
  - url: https://github.com/phnx-labs/agi-cli/pull/2954
    label: PR #2954
  - url: https://share.agents-cli.sh/muqsitnawaz/muqsit-feed-needsyou-2de76088855de3e8
    label: Rendered plan
facts:
  - Current main already publishes structured questions and permission prompts into the feed block ledger.
  - AGI EXT still computes Needs You from session-watch lifecycle fields and does not ingest feed blocks.
  - The recommended design adds explicit open/resolved attention lifecycle and a single feed projection owned by the CLI.
---

## Focus for review

- Approve the behavioral rule: an open feed attention record is authoritative; session lifecycle augments it only when no feed record exists.
- Prefer Variant A, one unified feed projection, or Variant B, a smaller session-watch enrichment that leaves two concepts visible in the architecture.
- Confirm that answered items should disappear from **Needs you** immediately but remain in the chronological feed with an answered/continued receipt.
- Confirm the proposed visual hierarchy: the ask and choices lead; task, agent, project, host, source, and age provide context without competing with the decision.

## Intent

> “We have the agents feed mechanism where agents post updates and can say when they're blocked or not. When an agent is asking a question it should show up in the agents feed as well, and then we show the Needs You tab / the Agents tab based on this agents feed. We might need to improve the agents feed. This is complicated — research, show mockups + a plan, then we dispatch a team.”

This is a plan only. It does not implement the feature.

## What happens when

### Agent asks a structured question

Before: the feed hook writes an open block, while AGI EXT independently sees `waiting_input` through `sessions watch`. Either path can be right while the other is stale.

After: the CLI emits one `attention.opened` item into the feed projection. **Needs you** gains a card with the exact question and options; the chronological feed gains the same item. Answering it records a receipt, removes it from **Needs you**, and leaves a resolved history row.

### Agent posts `agents feed post --blocked`

Before: the CLI writes both `status.blocked` activity and a declared open block, but AGI EXT does not read that ledger.

After: the declared block enters the same projection as an auto-detected question. It receives a “declared block” source chip, keeps its options/default, and remains open until an answer is recorded.

### Feed and transcript disagree

The feed does not blindly replace lifecycle detection. The reconciler uses this order:

1. An open feed record wins because it is answerable and has an explicit lifecycle.
2. With no open record, a fresh structural lifecycle signal becomes a fallback attention item and is mirrored into the projection.
3. A resolution tombstone suppresses the same stale lifecycle generation until the session advances beyond the recorded transcript/activity cursor.
4. Heuristic prose questions expire; explicit questions, permissions, plan reviews, and declared blocks resolve only through recorded lifecycle evidence.

<div class="artifact-callout">
The key design decision is not “feed or transcript.” It is one CLI-owned attention lifecycle whose strongest evidence is a feed block and whose compatibility fallback is the existing session state engine.
</div>

## Current architecture

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg class="artifact-diagram" viewBox="0 0 1120 520" role="img" aria-label="Current C4 component diagram showing separate feed and session-watch paths into the CLI and AGI EXT">
  <defs>
    <marker id="arrow-current" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#38bdf8"/></marker>
  </defs>
  <text x="38" y="34" font-family="JetBrains Mono, monospace" font-size="12" fill="#a3e635">C4 · COMPONENTS · CURRENT</text>
  <rect x="30" y="55" width="1060" height="420" rx="12" fill="#090d12" stroke="#334155" stroke-width="1.5"/>
  <text x="48" y="82" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#94a3b8">agents-cli boundary</text>

  <rect x="65" y="112" width="235" height="92" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="84" y="139" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">HOOKS + feed post</text>
  <text x="84" y="162" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#e2e8f0">Ask / permission / declared block</text>
  <text x="84" y="183" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#94a3b8">writes open records and status posts</text>

  <rect x="385" y="112" width="250" height="92" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="404" y="139" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">FEED STORES</text>
  <text x="404" y="162" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#e2e8f0">OpenBlock JSON + activity JSONL</text>
  <text x="404" y="183" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#94a3b8">answerable state and history are separate</text>

  <rect x="735" y="112" width="300" height="92" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="754" y="139" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">agents feed</text>
  <text x="754" y="162" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#e2e8f0">CLI operator inbox + update lane</text>
  <text x="754" y="183" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#94a3b8">joins blocks with active session hints</text>

  <path d="M300 158 H385" stroke="#38bdf8" stroke-width="2" marker-end="url(#arrow-current)"/>
  <text x="316" y="146" font-family="JetBrains Mono, monospace" font-size="9" fill="#7dd3fc">block JSON</text>
  <path d="M635 158 H735" stroke="#38bdf8" stroke-width="2" marker-end="url(#arrow-current)"/>
  <text x="654" y="146" font-family="JetBrains Mono, monospace" font-size="9" fill="#7dd3fc">read + rank</text>

  <rect x="65" y="290" width="235" height="92" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="84" y="317" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">SESSION STATE ENGINE</text>
  <text x="84" y="340" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#e2e8f0">Transcript + PID + mtime inference</text>
  <text x="84" y="361" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#94a3b8">working / waiting_input / idle</text>

  <rect x="385" y="290" width="250" height="92" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="404" y="317" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">sessions watch --json</text>
  <text x="404" y="340" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#e2e8f0">ActiveSession row stream</text>
  <text x="404" y="361" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#94a3b8">question + awaitingReason + lifecycle</text>

  <rect x="735" y="270" width="300" height="132" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="754" y="297" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">AGI EXT · MISSION CONTROL</text>
  <text x="754" y="322" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#e2e8f0">floorAdapter → derivePhase / deriveNeeds</text>
  <text x="754" y="345" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#fbbf24">Needs You comes from session state</text>
  <text x="754" y="367" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#94a3b8">Feed block ledger is not ingested</text>
  <text x="754" y="385" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#94a3b8">UI also groups failure / stall / PR review</text>

  <path d="M300 336 H385" stroke="#38bdf8" stroke-width="2" marker-end="url(#arrow-current)"/>
  <text x="311" y="324" font-family="JetBrains Mono, monospace" font-size="9" fill="#7dd3fc">ActiveSession</text>
  <path d="M635 336 H735" stroke="#38bdf8" stroke-width="2" marker-end="url(#arrow-current)"/>
  <text x="653" y="324" font-family="JetBrains Mono, monospace" font-size="9" fill="#7dd3fc">NDJSON</text>

  <path d="M510 204 V268" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="5 5"/>
  <text x="523" y="241" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#fbbf24">no canonical reconciliation</text>

  <rect x="65" y="428" width="16" height="10" rx="2" fill="#16120a" stroke="#f59e0b"/><text x="90" y="438" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#94a3b8">feed path</text>
  <rect x="180" y="428" width="16" height="10" rx="2" fill="#0e1418" stroke="#38bdf8"/><text x="205" y="438" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#94a3b8">session path</text>
  <rect x="320" y="428" width="16" height="10" rx="2" fill="#0f160a" stroke="#a3e635"/><text x="345" y="438" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#94a3b8">presentation</text>
</svg>
<figcaption>Read left to right. The amber feed path and blue session path converge only in the operator’s head, not in a shared CLI contract.</figcaption>
</figure>

| Current component | Direct source evidence | Consequence |
|---|---|---|
| Feed block ledger | `apps/cli/src/lib/feed/feed.ts:1-23` | It already models answerable, clearable asks. |
| Feed CLI | `apps/cli/src/commands/feed.ts:680-718` | It joins blocks and active-session hints for its own rendering. |
| Session watch | `apps/cli/src/commands/sessions-watch.ts:6-24` | It streams session rows, not feed blocks. |
| Extension adapter | `apps/ext/ui/settings/components/mission-control/floorAdapter.ts:576-583` | It trusts CLI phase, then re-derives `needs`. |
| Extension filtering | `apps/ext/ui/settings/components/mission-control/UnifiedAgentsPane.tsx:1577-1587` | **Needs you** selects `a.needs`; no feed record participates. |

## Purpose

The plan closes the authority gap without discarding working mechanisms: feed blocks already carry exact, answerable asks; session lifecycle already covers plan review, prose fallback, failure, stall, and progress. A CLI-owned reconciler turns those inputs into one attention lifecycle, and AGI EXT renders that lifecycle instead of independently deciding what needs a person.

## Research evidence

The statements in this section are direct source quotations. Design recommendations elsewhere are proposals, not claims about current behavior.

### The feed already captures questions and blocked posts

> `apps/cli/src/lib/feed/feed.ts:1-15`
>
> “Feed store -- structured block records published by agents waiting on user input (AskUserQuestion). … Each file is one open block -- a question the agent asked. One block per session: a new AskUserQuestion in the same session replaces the previous block … Removed when the session advances past the block.”

> `apps/cli/src/lib/feed/feed.ts:83-96`
>
> “How this block came to exist. question — an AskUserQuestion the harness surfaced; notification — a permission/idle prompt the harness raised; control — a synthetic card the feed itself computed …; declared — the AGENT decided it is stuck and said so (`feed post --blocked`).”

> `apps/cli/src/commands/feed.ts:499-506`
>
> “A blocked post lands in BOTH stores: the event in the shared activity stream (what happened) and an OpenBlock in the ledger (what is still open). The ledger is what makes it answerable and clearable -- without it the ask would scroll away like any other update.”

> `apps/cli/src/lib/feed-post.ts:53-59`
>
> “The agent is STUCK, not merely reporting. Writes `status.blocked` instead of `status.posted`, and the caller pairs it with an OpenBlock so the ask stays answerable until someone resolves it. This is a state, not a volume: a blocked post is always broadcast at `important`.”

> `apps/cli/src/commands/feed.ts:449-454`
>
> “`--session <id>` … `--level <level>` … `--blocked` … `--option <label...>` … `--default <answer>`.”

> `apps/cli/src/lib/feed/feed.ts:38-43,69-82,104-115,139-150`
>
> “`BlockQuestion` … `text` … `header?` … `options?` … `multiSelect?`.” “`OpenBlock` … `blockId` … `sessionId` … `mailboxId` … `host` … `runtime` … `project?` … `ts` … `questions`.” “`blockClass?` … `consequence?` … `timeoutMinutes?` … `safeDefault?` … `costOfDelay?`.” “`answer?` … `receipts?` … `continuedAt?` … `notifiedAt?` … `defaultedAt?` … `parkedAt?`.”

### The feed already has open/answer/clear mechanics

> `apps/cli/src/lib/feed/feed.ts:17-22`
>
> “A block may be answered from any surface … The first answer wins … Answered blocks stay visible until the agent consumes the message and continues, so the UI can show delivered/consumed/continued receipts.”

> `apps/cli/src/lib/feed/feed.ts:456-485`
>
> “Atomic write a block record to the feed store.” “Read all block records.”

> `apps/cli/src/lib/feed/feed.ts:637-667`
>
> “A declared block (`agents feed post --blocked`) is the agent explicitly saying it is stuck. … a declared block stays open until it is actually ANSWERED.” “On PostToolUse, keep a 'question' block; approval/notification blocks clear once the tool runs.”

> `apps/cli/src/lib/feed/feed.ts:686-711`
>
> “Terminal answers … record an answered marker and remove the block file so the feed stops showing it within one poll cycle.”

### Automatic publishing exists, but harness coverage is event-shaped

> `apps/cli/src/lib/feed/feed.ts:537-546`
>
> “The manifest invokes this script for top-level AskUserQuestion calls, waiting notifications, question answers, and session lifecycle events. One atomic file per session means a new block replaces the previous block. Answer/resume/stop events remove it so `agents feed` only lists decisions that are still open.”

> `apps/cli/src/lib/feed/feed.ts:713-766`
>
> “Claude emits a generic permission notification after presenting an AskUserQuestion.” “Codex approval prompt. … Publish it as a notification-kind approval block naming the tool so the feed and the phone notifier can surface it.”

> `apps/cli/src/lib/feed/feed.ts:83-94`
>
> “Every other kind is inferred from a harness event, and hook events are not portable across harnesses (only Claude fires Notification, only Codex fires PermissionRequest), so a declared block is the one signal every agent can raise — it is just a shell command.”

### Session lifecycle is a separate authority today

> `apps/cli/src/lib/session/state.ts:4-15`
>
> “Turns a chronological slice of normalized `SessionEvent`s … plus … file mtime, cwd, branch, whether the owning process is alive into a `SessionState`: is the agent working, waiting on the user, or idle.” “Structural signals are preferred over prose heuristics.”

> `apps/cli/src/lib/session/state.ts:616-638`
>
> “Structural ‘waiting on you’ — Claude handed control back via a plan/question tool and nothing has come after it.” “Alive but the file hasn't moved — likely blocked on a permission prompt.”

> `apps/cli/src/lib/session/state.ts:653-667`
>
> “A prose question takes a free-text reply.” “Unlike the structural plan/ask signals above, the prose heuristic DECAYS.”

> `apps/cli/src/lib/session/active.ts:1238-1260`
>
> “Fold a computed SessionState onto an active-session row.” “`status: life ?? statusFromActivity(state.activity)` … `activity: state.activity` … `awaitingReason: state.awaitingReason` … `question: state.question`.”

> `apps/cli/src/commands/sessions-watch.ts:6-24`
>
> “Stream canonical live and recoverable session row changes as NDJSON.” “Each line is one versioned reset, upsert, remove, scope, or heartbeat envelope.”

### AGI EXT remains a session-state projection

> `apps/ext/CLAUDE.md:3-12`
>
> “AGI EXT is the VS Code/VSCodium presentation client for agents-cli.” “agents-cli owns sessions, devices, accounts, teams, tickets, watchdog, routines, lifecycle, ranking, deduplication, and scheduling.” “The elected extension monitor owns one `agents sessions watch --json` child … each extension host has one presentation store and derives no lifecycle state.”

> `apps/ext/src/core/remoteSessions.ts:51-61`
>
> “The structured decision an agent is waiting on, carried verbatim from the CLI state engine (`agents sessions watch --json` → ActiveSession.question). This is the load-bearing ‘what does it want from me’ signal the NEEDS-YOU card renders.”

> `apps/ext/ui/settings/components/mission-control/floorModel.ts:35-45`
>
> “Precedence when deriving from raw signals: failed > waiting > running > done(unreviewed) > done(settled) > idle.” “A FINISHED agent … can no longer consume an answer, so a stale waitingForInput flag never lifts it back into Needs-You (RUSH-1522).”

> `apps/ext/ui/settings/components/mission-control/floorModel.ts:628-644`
>
> “Raw signals -> FloorPhase.” “if (input.waitingForInput) return 'waiting'.”

> `apps/ext/ui/settings/components/mission-control/floorModel.ts:648-661`
>
> “waiting || failed || stalled || (open PR that needs a human decision).” “if (phase === 'waiting' || phase === 'failed' || phase === 'stalled') return true.”

> `apps/ext/ui/settings/components/mission-control/UnifiedAgentsPane.tsx:1577-1587`
>
> “Center list scoped by project filter + host filter + status/agent chips + search.” “if (statusChips.length) list = list.filter((a) => statusChips.some((c) => (c === 'needs' ? a.needs : a.phase === c))).”

> `apps/ext/src/vscode/prBoard.vscode.ts:11-23`
>
> “`const PR_TTL_MS = 45_000`.” “`const GH_FIELDS = 'number,title,state,isDraft,reviewDecision,mergeable,statusCheckRollup'`.” “`gh pr view … --json ${GH_FIELDS}`.”

> `apps/ext/ui/settings/components/mission-control/SavedViewsBar.tsx:23-28,145-164`
>
> “Needs you” “Running” “Idle” “Failed” … “Background”.

## UI behavior mockups

<div class="artifact-behavior artifact-grid artifact-grid-2">
<figure class="artifact-panel" data-state="current" data-evidence="mockup">
<svg class="artifact-diagram" viewBox="0 0 760 590" role="img" aria-label="Current AGI EXT Agents feed mockup with Needs you derived from session state">
  <rect x="0" y="0" width="760" height="590" rx="12" fill="#0a0e14"/>
  <rect x="0" y="0" width="760" height="54" fill="#101720"/><text x="24" y="33" font-family="Inter, system-ui" font-size="17" font-weight="700" fill="#e7e5e4">AGI EXT</text><text x="674" y="32" font-family="JetBrains Mono, monospace" font-size="10" fill="#6e7681">FLEET</text>
  <rect x="18" y="72" width="724" height="46" rx="8" fill="#0f151d" stroke="#25303d"/>
  <rect x="30" y="82" width="100" height="27" rx="13" fill="#2b2614" stroke="#d4a72c"/><text x="49" y="100" font-family="Inter, system-ui" font-size="11" fill="#f5c451">Needs you · 2</text>
  <text x="152" y="100" font-family="Inter, system-ui" font-size="11" fill="#8b949e">Running</text><text x="225" y="100" font-family="Inter, system-ui" font-size="11" fill="#8b949e">Idle</text><text x="273" y="100" font-family="Inter, system-ui" font-size="11" fill="#8b949e">Failed</text><text x="332" y="100" font-family="Inter, system-ui" font-size="11" fill="#8b949e">Background</text>
  <text x="24" y="150" font-family="JetBrains Mono, monospace" font-size="10" fill="#d4a72c">NEEDS YOU · 2</text><line x1="126" y1="146" x2="736" y2="146" stroke="#27313d"/>
  <rect x="24" y="168" width="712" height="150" rx="9" fill="#121923" stroke="#8b6f24"/>
  <circle cx="45" cy="194" r="5" fill="#d4a72c"/><text x="61" y="199" font-family="Inter, system-ui" font-size="13" font-weight="650" fill="#e7e5e4">Plan feed-driven Needs You</text><text x="590" y="199" font-family="JetBrains Mono, monospace" font-size="9" fill="#6e7681">codex · agents-cli</text>
  <rect x="42" y="219" width="80" height="20" rx="10" fill="#1d2630"/><text x="55" y="233" font-family="JetBrains Mono, monospace" font-size="9" fill="#f5c451">question?</text>
  <text x="42" y="261" font-family="Inter, system-ui" font-size="13" fill="#f0f3f6">Which reconciliation rule should the UI use?</text>
  <rect x="42" y="278" width="147" height="25" rx="6" fill="#a3e635"/><text x="60" y="295" font-family="Inter, system-ui" font-size="10" font-weight="700" fill="#10150b">Feed augments</text><rect x="198" y="278" width="128" height="25" rx="6" fill="#19222c" stroke="#36414d"/><text x="218" y="295" font-family="Inter, system-ui" font-size="10" fill="#c8d1dc">Feed replaces</text>
  <rect x="24" y="334" width="712" height="117" rx="9" fill="#121923" stroke="#8b6f24"/>
  <circle cx="45" cy="360" r="5" fill="#d4a72c"/><text x="61" y="365" font-family="Inter, system-ui" font-size="13" font-weight="650" fill="#e7e5e4">Release CLI package</text><text x="612" y="365" font-family="JetBrains Mono, monospace" font-size="9" fill="#6e7681">claude</text>
  <text x="42" y="400" font-family="Inter, system-ui" font-size="12" fill="#c8d1dc">Waiting on a permission prompt</text><rect x="42" y="416" width="86" height="22" rx="5" fill="#a3e635"/><text x="62" y="431" font-family="Inter, system-ui" font-size="10" font-weight="700" fill="#10150b">Approve</text><rect x="137" y="416" width="70" height="22" rx="5" fill="#19222c" stroke="#36414d"/><text x="158" y="431" font-family="Inter, system-ui" font-size="10" fill="#c8d1dc">Deny</text>
  <rect x="24" y="478" width="712" height="72" rx="9" fill="#0e141c" stroke="#252f3a"/><text x="43" y="506" font-family="Inter, system-ui" font-size="12" fill="#9aa4af">Current limitation</text><text x="43" y="529" font-family="Inter, system-ui" font-size="11" fill="#697481">Cards look correct, but their authority is session state; declared feed blocks can be absent.</text>
</svg>
<figcaption>Current faithful mockup. The visible design is already close; the data authority is the problem.</figcaption>
</figure>

<figure class="artifact-panel" data-state="proposed" data-evidence="mockup">
<svg class="artifact-diagram" viewBox="0 0 760 590" role="img" aria-label="Proposed Variant A unified feed projection mockup">
  <rect x="0" y="0" width="760" height="590" rx="12" fill="#0a0e14"/>
  <rect x="0" y="0" width="760" height="54" fill="#101720"/><text x="24" y="33" font-family="Inter, system-ui" font-size="17" font-weight="700" fill="#e7e5e4">AGI EXT</text><text x="655" y="32" font-family="JetBrains Mono, monospace" font-size="10" fill="#a3e635">FEED LIVE</text>
  <rect x="18" y="72" width="724" height="46" rx="8" fill="#0f151d" stroke="#25303d"/>
  <rect x="30" y="82" width="108" height="27" rx="13" fill="#293611" stroke="#a3e635"/><text x="48" y="100" font-family="Inter, system-ui" font-size="11" font-weight="700" fill="#c9f56f">Needs you · 3</text>
  <text x="160" y="100" font-family="Inter, system-ui" font-size="11" fill="#8b949e">Running · 12</text><text x="250" y="100" font-family="Inter, system-ui" font-size="11" fill="#8b949e">Idle · 4</text><text x="310" y="100" font-family="Inter, system-ui" font-size="11" fill="#8b949e">Failed · 1</text><text x="382" y="100" font-family="Inter, system-ui" font-size="11" fill="#8b949e">Background</text>
  <text x="24" y="150" font-family="JetBrains Mono, monospace" font-size="10" fill="#a3e635">NEEDS YOU · FEED ATTENTION</text><line x1="204" y1="146" x2="736" y2="146" stroke="#27313d"/>
  <rect x="24" y="168" width="712" height="160" rx="9" fill="#111b19" stroke="#739c25"/>
  <circle cx="45" cy="194" r="5" fill="#a3e635"/><text x="61" y="199" font-family="Inter, system-ui" font-size="13" font-weight="650" fill="#f0f3f6">Plan feed-driven Needs You</text><text x="565" y="199" font-family="JetBrains Mono, monospace" font-size="9" fill="#89949f">codex · 2m</text>
  <rect x="42" y="217" width="95" height="20" rx="10" fill="#243313"/><text x="55" y="231" font-family="JetBrains Mono, monospace" font-size="9" fill="#c9f56f">QUESTION</text><rect x="145" y="217" width="92" height="20" rx="10" fill="#17222d"/><text x="157" y="231" font-family="JetBrains Mono, monospace" font-size="9" fill="#7dd3fc">feed hook</text><text x="608" y="231" font-family="JetBrains Mono, monospace" font-size="9" fill="#697481">agents-cli</text>
  <text x="42" y="264" font-family="Inter, system-ui" font-size="13" fill="#f0f3f6">Which reconciliation rule should the UI use?</text>
  <rect x="42" y="282" width="147" height="28" rx="6" fill="#a3e635"/><text x="60" y="300" font-family="Inter, system-ui" font-size="10" font-weight="700" fill="#10150b">Feed augments</text><rect x="198" y="282" width="128" height="28" rx="6" fill="#19222c" stroke="#36414d"/><text x="218" y="300" font-family="Inter, system-ui" font-size="10" fill="#c8d1dc">Feed replaces</text><text x="619" y="300" font-family="JetBrains Mono, monospace" font-size="9" fill="#7f8b96">open</text>
  <rect x="24" y="344" width="712" height="126" rx="9" fill="#121923" stroke="#8b6f24"/>
  <circle cx="45" cy="370" r="5" fill="#d4a72c"/><text x="61" y="375" font-family="Inter, system-ui" font-size="13" font-weight="650" fill="#f0f3f6">Publish the release?</text><text x="568" y="375" font-family="JetBrains Mono, monospace" font-size="9" fill="#89949f">grok · 4m</text>
  <rect x="42" y="393" width="112" height="20" rx="10" fill="#382619"/><text x="54" y="407" font-family="JetBrains Mono, monospace" font-size="9" fill="#fbbf24">DECLARED BLOCK</text><rect x="162" y="393" width="75" height="20" rx="10" fill="#17222d"/><text x="175" y="407" font-family="JetBrains Mono, monospace" font-size="9" fill="#7dd3fc">agent post</text>
  <text x="42" y="439" font-family="Inter, system-ui" font-size="12" fill="#c8d1dc">npm token is valid; this is the irreversible publish gate.</text><text x="550" y="439" font-family="JetBrains Mono, monospace" font-size="9" fill="#fbbf24">default: wait</text>
  <rect x="24" y="492" width="712" height="58" rx="9" fill="#0e1714" stroke="#314b22"/><text x="43" y="516" font-family="Inter, system-ui" font-size="11" fill="#c9f56f">Resolved items leave Needs you immediately.</text><text x="43" y="536" font-family="Inter, system-ui" font-size="10" fill="#7f8b96">The activity timeline retains “answered → consumed → continued” receipts.</text>
</svg>
<figcaption><b>Variant A — recommended.</b> One CLI feed projection drives counts, filters, attention cards, and chronological receipts. More CLI work; cleanest authority.</figcaption>
</figure>
</div>

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide" data-state="proposed" data-evidence="mockup">
<svg class="artifact-diagram" viewBox="0 0 1120 390" role="img" aria-label="Proposed Variant B session watch enriched with feed block overlay mockup">
  <rect x="0" y="0" width="1120" height="390" rx="12" fill="#0a0e14"/>
  <text x="28" y="36" font-family="JetBrains Mono, monospace" font-size="12" fill="#fbbf24">VARIANT B · FEED OVERLAY ON SESSION WATCH</text>
  <rect x="28" y="60" width="1064" height="46" rx="8" fill="#0f151d" stroke="#25303d"/>
  <rect x="42" y="70" width="110" height="27" rx="13" fill="#2b2614" stroke="#d4a72c"/><text x="60" y="88" font-family="Inter, system-ui" font-size="11" fill="#f5c451">Needs you · 3</text><text x="175" y="88" font-family="Inter, system-ui" font-size="11" fill="#8b949e">Running · 12</text><text x="270" y="88" font-family="Inter, system-ui" font-size="11" fill="#8b949e">Idle · 4</text><text x="330" y="88" font-family="Inter, system-ui" font-size="11" fill="#8b949e">Failed · 1</text><text x="405" y="88" font-family="Inter, system-ui" font-size="11" fill="#8b949e">Background</text>
  <rect x="28" y="130" width="1064" height="105" rx="9" fill="#121923" stroke="#8b6f24"/>
  <text x="48" y="160" font-family="Inter, system-ui" font-size="13" font-weight="650" fill="#f0f3f6">Publish the release?</text><rect x="48" y="178" width="104" height="20" rx="10" fill="#382619"/><text x="60" y="192" font-family="JetBrains Mono, monospace" font-size="9" fill="#fbbf24">FEED BLOCK</text><text x="172" y="192" font-family="Inter, system-ui" font-size="11" fill="#a8b2bd">overlaid onto the matching ActiveSession row</text>
  <rect x="28" y="258" width="514" height="86" rx="9" fill="#101720" stroke="#334155"/><text x="48" y="285" font-family="JetBrains Mono, monospace" font-size="10" fill="#7dd3fc">PRO</text><text x="48" y="309" font-family="Inter, system-ui" font-size="11" fill="#c8d1dc">Smaller protocol change; existing monitor and card model survive.</text><text x="48" y="328" font-family="Inter, system-ui" font-size="10" fill="#7f8b96">Add `attention` to each sessions-watch row.</text>
  <rect x="578" y="258" width="514" height="86" rx="9" fill="#16120a" stroke="#f59e0b"/><text x="598" y="285" font-family="JetBrains Mono, monospace" font-size="10" fill="#fbbf24">TRADEOFF</text><text x="598" y="309" font-family="Inter, system-ui" font-size="11" fill="#c8d1dc">The feed remains an overlay, not the operator projection.</text><text x="598" y="328" font-family="Inter, system-ui" font-size="10" fill="#7f8b96">Updates/history still need a second read path later.</text>
</svg>
<figcaption><b>Variant B — lower-risk interim.</b> It fixes declared blocks missing from Needs You but does not fully satisfy “Agents based on the feed.”</figcaption>
</figure>

## Proposed architecture

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg class="artifact-diagram" viewBox="0 0 1120 560" role="img" aria-label="Proposed C4 component diagram with a canonical attention reconciler and feed watch projection">
  <defs><marker id="arrow-proposed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#38bdf8"/></marker></defs>
  <text x="38" y="34" font-family="JetBrains Mono, monospace" font-size="12" fill="#a3e635">C4 · COMPONENTS · PROPOSED VARIANT A</text>
  <rect x="30" y="55" width="1060" height="455" rx="12" fill="#090d12" stroke="#334155" stroke-width="1.5"/>
  <text x="48" y="82" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#94a3b8">agents-cli boundary</text>

  <rect x="60" y="110" width="230" height="88" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/><text x="79" y="137" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">FEED PRODUCERS</text><text x="79" y="161" font-family="Inter, system-ui" font-size="12" fill="#e2e8f0">hooks + feed post</text><text x="79" y="180" font-family="Inter, system-ui" font-size="10" fill="#94a3b8">explicit, structural evidence</text>
  <rect x="60" y="258" width="230" height="88" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/><text x="79" y="285" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">SESSION STATE ENGINE</text><text x="79" y="309" font-family="Inter, system-ui" font-size="12" fill="#e2e8f0">lifecycle candidates</text><text x="79" y="328" font-family="Inter, system-ui" font-size="10" fill="#94a3b8">fallback + progress states</text>

  <rect x="380" y="155" width="290" height="145" rx="10" fill="#0f160a" stroke="#a3e635" stroke-width="2"/><text x="401" y="183" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">ATTENTION RECONCILER</text><text x="401" y="210" font-family="Inter, system-ui" font-size="12" fill="#e2e8f0">Open record wins</text><text x="401" y="233" font-family="Inter, system-ui" font-size="12" fill="#e2e8f0">Lifecycle fills gaps</text><text x="401" y="256" font-family="Inter, system-ui" font-size="12" fill="#e2e8f0">Resolution cursor blocks resurrection</text><text x="401" y="279" font-family="Inter, system-ui" font-size="10" fill="#94a3b8">stable key: host + session + generation</text>
  <path d="M290 154 H365" stroke="#38bdf8" stroke-width="2" marker-end="url(#arrow-proposed)"/><text x="300" y="143" font-family="JetBrains Mono, monospace" font-size="9" fill="#7dd3fc">OpenBlock</text>
  <path d="M290 302 H335 Q355 302 365 282" stroke="#38bdf8" stroke-width="2" marker-end="url(#arrow-proposed)"/><text x="298" y="323" font-family="JetBrains Mono, monospace" font-size="9" fill="#7dd3fc">SessionState</text>

  <rect x="760" y="110" width="290" height="88" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/><text x="780" y="137" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">FEED LIFECYCLE STORE</text><text x="780" y="161" font-family="Inter, system-ui" font-size="12" fill="#e2e8f0">opened / answered / resolved</text><text x="780" y="180" font-family="Inter, system-ui" font-size="10" fill="#94a3b8">retains cursor + receipts + history</text>
  <rect x="760" y="238" width="290" height="88" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/><text x="780" y="265" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">agents feed watch --json</text><text x="780" y="289" font-family="Inter, system-ui" font-size="12" fill="#e2e8f0">one versioned operator projection</text><text x="780" y="308" font-family="Inter, system-ui" font-size="10" fill="#94a3b8">agents + attention + activity + scope</text>
  <path d="M670 200 H735 Q750 200 760 180" stroke="#38bdf8" stroke-width="2" marker-end="url(#arrow-proposed)"/><text x="683" y="188" font-family="JetBrains Mono, monospace" font-size="9" fill="#7dd3fc">transitions</text>
  <path d="M905 198 V238" stroke="#38bdf8" stroke-width="2" marker-end="url(#arrow-proposed)"/>

  <rect x="760" y="382" width="290" height="92" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/><text x="780" y="410" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">AGI EXT · THIN CLIENT</text><text x="780" y="434" font-family="Inter, system-ui" font-size="12" fill="#e2e8f0">project rows + render cards</text><text x="780" y="454" font-family="Inter, system-ui" font-size="10" fill="#94a3b8">no transcript parsing or needs derivation</text>
  <path d="M905 326 V382" stroke="#38bdf8" stroke-width="2" marker-end="url(#arrow-proposed)"/><text x="920" y="358" font-family="JetBrains Mono, monospace" font-size="9" fill="#7dd3fc">NDJSON</text>

  <rect x="60" y="406" width="16" height="10" rx="2" fill="#16120a" stroke="#f59e0b"/><text x="85" y="416" font-family="Inter, system-ui" font-size="10" fill="#94a3b8">producer evidence</text><rect x="220" y="406" width="16" height="10" rx="2" fill="#0e1418" stroke="#38bdf8"/><text x="245" y="416" font-family="Inter, system-ui" font-size="10" fill="#94a3b8">canonical data contract</text><rect x="415" y="406" width="16" height="10" rx="2" fill="#0f160a" stroke="#a3e635"/><text x="440" y="416" font-family="Inter, system-ui" font-size="10" fill="#94a3b8">decision / presentation</text>
</svg>
<figcaption>Read left to right. Existing producers stay; the new reconciler makes their disagreement explicit, records lifecycle, and emits one operator-facing stream.</figcaption>
</figure>

### Canonical rules

| Signal | Feed effect | Needs You effect | Resolution |
|---|---|---|---|
| `AskUserQuestion` | `attention.opened`, source `hook`, full choices | Show immediately | Answer/continued transition |
| `PermissionRequest` / waiting notification | `attention.opened`, source `hook`, approval default | Show immediately | Tool result, deny, or lifecycle clear |
| `feed post --blocked` | `attention.opened`, source `declared`, plus activity post | Show immediately and persist | Recorded answer only |
| Plan review | `attention.opened`, source `lifecycle` until all harnesses emit a hook | Show exact plan-review actions | Approval/send-back |
| Fresh prose question | ephemeral `attention.opened`, source `heuristic` | Show with “inferred” chip | Reply, expiry, or newer transcript cursor |
| Failure, stalled agent, ready PR | feed `attention` control item, source `system` | Preserve current Needs You coverage | Recovery, new activity, or PR state change |
| Running / idle / done | agent projection only | Not an attention item | Session lifecycle update |

## Proposed changes

### 1. Model attention as a lifecycle, not a file that disappears

`apps/cli/src/lib/feed/feed.ts` keeps `OpenBlock` compatibility, but the canonical record gains a generation key, source, state, and source cursor. Resolution is appended before the open-file view is cleared.

```diff
 export interface OpenBlock {
   blockId: string;
   sessionId: string;
+  generation: string;
+  source: 'hook' | 'declared' | 'lifecycle' | 'heuristic' | 'system';
+  state: 'open' | 'answered' | 'consumed' | 'continued' | 'resolved';
+  sourceCursor?: { lastActivityMs?: number; eventId?: string };
   questions: BlockQuestion[];
 }
+
+export interface AttentionResolution {
+  blockId: string;
+  generation: string;
+  resolvedAt: string;
+  sourceCursor?: OpenBlock['sourceCursor'];
+  reason: 'answered' | 'continued' | 'tool_completed' | 'expired' | 'session_advanced';
+}
```

### 2. Reconcile feed blocks with session lifecycle in the CLI

Add `apps/cli/src/lib/feed/attention.ts`. It is a pure merge over an open block, a session row, CLI-owned pull-request status, and the latest resolution tombstone. It never lets the extension choose authority. PR status moves out of `apps/ext/src/vscode/prBoard.vscode.ts`: the CLI refreshes `number,title,state,isDraft,reviewDecision,mergeable,statusCheckRollup` on the same bounded TTL and supplies the result to both feed attention and the PR board projection.

```diff
+export function reconcileAttention(input: {
+  block?: OpenBlock;
+  session: ActiveSession;
+  pullRequest?: PullRequestAttentionSignal;
+  resolution?: AttentionResolution;
+  nowMs: number;
+}): AttentionItem | undefined {
+  if (input.block?.state === 'open') return attentionFromBlock(input.block, input.session);
+  const candidate = attentionFromSession(input.session, input.nowMs);
+  if (!candidate) return undefined;
+  if (coveredByResolution(candidate, input.resolution)) return undefined;
+  return candidate;
+}
```

### 3. Stream a single operator projection

Add `apps/cli/src/commands/feed-watch.ts` and `apps/cli/src/lib/feed/watch.ts`. Compose the existing local session watcher with feed/activity store notifications. For fleet mode, the coordinator starts `agents feed watch --json --local` on each peer rather than reusing the current peer command `agents sessions watch --json --local`; every peer therefore streams its own session rows, open blocks, resolutions, and activity events. The coordinator preserves each peer’s `streamId + sequence`, assigns one coordinator sequence to forwarded envelopes, and emits `scope unavailable/available` transitions. An unavailable peer retains its last rows until that scope reconnects, matching the existing session-watch contract. Do not add another lifecycle detector or scheduler.

```diff
+export type FeedWatchEnvelope =
+  | { v: 1; streamId: string; sequence: number; type: 'reset'; agents: AgentProjection[]; attention: AttentionItem[] }
+  | { v: 1; streamId: string; sequence: number; type: 'agent.upsert'; rowKey: string; agent: AgentProjection }
+  | { v: 1; streamId: string; sequence: number; type: 'attention.upsert'; rowKey: string; attention: AttentionItem }
+  | { v: 1; streamId: string; sequence: number; type: 'attention.remove'; rowKey: string; resolution: AttentionResolution }
+  | { v: 1; streamId: string; sequence: number; type: 'activity.append'; event: ActivityEvent }
+  | { v: 1; streamId: string; sequence: number; type: 'scope' | 'heartbeat'; scope: string };
```

The existing `agents sessions watch --json` remains compatible for session-only consumers. AGI EXT moves to `agents feed watch --json` because it needs the joined operator projection.

### 4. Make AGI EXT project, not derive

Change `apps/ext/src/monitor/sessionCliStream.ts`, `apps/ext/src/core/remoteSessions.ts`, and the presentation store to consume the feed envelopes. Add `attention` to the normalized agent model. Both adapter entry points in `floorAdapter.ts` change: `toFloorAgentFromRemote` maps projected attention, while `toFloorAgentFromUnified` joins the same projected agent by `sessionId`/`terminalId` and uses the terminal registry only for editor-owned display and reply metadata. Neither path calls `deriveNeeds`, parses tool calls, or parses response prose for streamed rows.

```diff
-const needs = deriveNeeds(phase, prOpenUnreviewed, ci)
+const needs = r.attention?.state === 'open'
 
-question: structuredQuestionFromRemote(r.question) ?? parseStructuredQuestion(resp, phase),
+question: structuredQuestionFromAttention(r.attention),
+attentionSource: r.attention?.source ?? null,
+attentionAgeMs: r.attention?.openedAt ? Date.now() - Date.parse(r.attention.openedAt) : 0,
```

Local editor tabs must use the same projected attention record as remote rows. The extension may still format and group data; it must not inspect transcripts or infer whether a record needs a human.

### 5. Claim and route answers in one CLI operation

Add `agents feed answer <attention-key>` in `apps/cli/src/commands/feed.ts` and a service in `apps/cli/src/lib/feed/answer.ts`. AGI EXT sends the attention key plus an option id or free text to the CLI. The CLI verifies high-consequence authorization, atomically claims the first answer through `recordAnswer`, resolves the option’s delivery key, routes it over the recorded reply rail, and only then advances the receipt. A losing surface receives `already answered` and must not inject a second reply.

```diff
+export interface AttentionChoice extends BlockOption {
+  id: string;
+  deliveryKey?: string;
+}
+
+export async function claimAndRouteAttentionAnswer(input: {
+  attentionKey: string;
+  choiceId?: string;
+  text?: string;
+  operator: VerifiedOperator;
+}): Promise<{ status: 'delivered' | 'already_answered'; receipt: MessageReceipt }>;
```

### 6. Render source and receipts without redesigning the whole floor

Update `FeedItem.tsx`, `AgentDecision.tsx`, and `SavedViewsBar.tsx`:

```diff
+<AttentionSourceChip source={agent.attentionSource} />
 <StructuredReply question={agent.question} ... />
+<AttentionReceipt state={agent.attentionState} />
```

- **Needs you** count comes from open attention items.
- **Running / Idle / Failed / Background** come from the agent projection in the same stream.
- An answered item leaves **Needs you** immediately; a compact receipt remains in the chronological activity lane.
- Grouping by question uses `attention.fingerprint`, not UI-normalized question text.

### 7. Update contracts and guidance in the same delivery

Update `apps/cli/docs/specifications.md`, `apps/cli/docs/observability.md`, `apps/cli/README.md`, `apps/cli/AGENTS.md`, `apps/ext/AGENTS.md`, `apps/ext/README.md`, and both component changelogs. Audit the companion `.agents-system` guidance for every invocation of `agents feed` and `agents sessions watch`; link the companion PR even if the audit concludes no change is needed.

## Public interface

```text
agents feed watch --json [--local]
agents feed answer <attention-key> (--choice <choice-id> | --text <answer>)
```

The stream is versioned NDJSON. It is additive: `agents feed`, `agents feed --filter updates`, and `agents sessions watch --json` retain their current contracts.

The proposed canonical attention item is:

```ts
interface AttentionItem {
  key: string
  sessionId: string
  mailboxId: string
  host: string
  project?: string
  kind: 'question' | 'permission' | 'plan_review' | 'declared' | 'failure' | 'stall' | 'review'
  source: 'hook' | 'declared' | 'lifecycle' | 'heuristic' | 'system'
  state: 'open' | 'answered' | 'consumed' | 'continued' | 'resolved'
  openedAt: string
  question?: BlockQuestion
+  choices?: AttentionChoice[]
+  replyCapability: 'terminal' | 'tmux' | 'cloud' | 'team' | 'none'
  safeDefault?: string
  fingerprint: string
  sourceCursor?: { lastActivityMs?: number; eventId?: string }
}
```

## Plan

- [ ] Define `AttentionItem`, generation/fingerprint rules, and resolution tombstones beside the feed store.
- [ ] Add pure reconciliation tests for block-wins, lifecycle fallback, disagreement, answer, continued receipt, expiry, and stale resurrection.
- [ ] Emit feed lifecycle transitions from existing question, permission, declared-block, answer, and clear paths.
- [ ] Implement `agents feed watch --json` by composing existing session watch and feed/activity stores.
- [ ] Stream remote peers through `agents feed watch --json --local`, with scope retention/reconnect tests and coordinator ordering.
- [ ] Implement atomic `agents feed answer` claim-before-route with option keys, reply capability, receipts, and high-consequence authorization.
- [ ] Add cross-harness fixtures for Claude question/notification, Codex permission, plan review, prose fallback, and a harness with no hook event.
- [ ] Move AGI EXT’s elected monitor to the feed stream and normalize `attention` once at the host boundary for both remote sessions and local editor tabs.
- [ ] Remove streamed-row needs/question derivation from the webview while preserving grouping and rendering.
- [ ] Add the source chip, exact choices, default policy, and resolution receipt shown in Variant A.
- [ ] Update CLI/ext docs, changelogs, normative spec, and companion fleet guidance.
- [ ] Verify the composed flow twice: local dev build before merge, installed released CLI + packaged AGI EXT after release.

## Validation

| Scenario | Real-path proof | Expected visible result |
|---|---|---|
| AskUserQuestion | Run a real supported harness and invoke its actual question tool | One feed item; one Needs You card; exact options match |
| Declared block | Run `agents feed post --title "Release gate" "Publish now?" --blocked --option publish --option wait --default wait` inside a real session | Declared-source card persists after the turn ends |
| Terminal answer | Answer in the harness TUI | Card leaves Needs You; answered receipt remains in activity |
| Extension answer | Click an option in AGI EXT | First answer wins; agent consumes it; receipt advances monotonically |
| Concurrent answer | Answer the same block from AGI EXT and the terminal at once | One atomic claim wins; the losing surface injects nothing |
| Stale transcript | Resolve, then poll before transcript tail changes | Tombstone prevents card resurrection |
| New question | Ask again after transcript cursor advances | New generation appears as a new open item |
| Feed/session mismatch | Inject an open block while session reports running | Open feed record wins and discrepancy is observable in diagnostics |
| Remote host | Ask on a reachable worker and watch locally | Same item appears once with correct host and reply rail |
| Remote reconnect | Interrupt one peer feed stream, then restore it | Last rows remain marked stale; one scope reset reconciles without duplicates |
| Ready PR | Move a real PR through checks/review while its session is done | CLI projection adds/removes the review attention item and the PR board uses the same status |
| Viewports/themes | Render Fleet at desktop/mobile widths in light/dark | Tabs, source chips, options, and receipts remain legible |

Run through repository scripts and real harnesses; do not mock the critical path.

```bash
cd apps/cli
bun run test:remote
scripts/install.sh --skip-tests
agents-dev feed watch --json --local

cd ../ext
bun test
bun run compile:ext
```

## Risks

| Risk | Mitigation |
|---|---|
| Answered item resurrects from stale transcript state | Resolution tombstone carries the source cursor; equal/older lifecycle candidates are suppressed. |
| Feed hooks differ by harness | Keep lifecycle fallback and declare source; add parity fixtures and capability coverage. |
| New watcher duplicates session lifecycle work | Compose `watchLocalSessions` inside each peer feed watcher; do not rescan transcripts or add a scheduler. |
| Fleet feed sees sessions but misses remote block stores | Each peer runs `feed watch --json --local`; the coordinator forwards peer envelopes and retains unavailable scopes. |
| Existing consumers depend on sessions-watch envelopes | Keep `sessions watch` unchanged; AGI EXT opts into `feed watch`. |
| One session asks twice | Stable session key plus generation/fingerprint replaces only the current open item and preserves history. |
| Declared block is cleared by generic lifecycle | Preserve the current rule: unanswered declared blocks clear only through an answer. |
| Feed/activity stores race | Atomic record writes, monotonic receipt transitions, and stream sequence numbers make ordering explicit. |
| Needs You loses failures/stalls/PR review | Reconciler emits system attention items for those current UI cases. |
| Two surfaces answer at once | All UI answers call the CLI claim-before-route operation; an unsuccessful claim never reaches the reply rail. |

## Tracking

- [Plan-only PR #2954](https://github.com/phnx-labs/agi-cli/pull/2954)
- [Shareable rendered plan](https://share.agents-cli.sh/muqsitnawaz/muqsit-feed-needsyou-2de76088855de3e8)

No implementation ticket or feature PR was created in this plan-only task. After design approval, dispatch one team with explicit ownership across: feed model/reconciler, feed watch protocol, AGI EXT host adapter, AGI EXT presentation/tests, and composed real-harness verification.
