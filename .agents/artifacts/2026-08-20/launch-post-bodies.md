---
kind: report
template: report.v1
title: 'The launch posts, in full, and what each title costs you'
summary: 'Complete copy-paste bodies for Show HN, r/ClaudeAI, and r/LocalLLaMA, plus the adversarial read on each candidate title: what the top comment will attack and how to answer it.'
status: draft
human: author
host: fleet-worker
session: n/a
links:
  - label: 'phnx-labs/agi-cli'
    url: 'https://github.com/phnx-labs/agi-cli'
  - label: 'RUSH-2834 launch sequence'
    url: 'https://linear.app/'
---

## Summary

Three complete post bodies, ready to paste. Before them, the part that actually
decides the launch: **the title you pick determines what the thread argues
about**, and one of the three candidates hands HN a better argument than your
product.

The short version:

| Title | Expected reach | What the top comment attacks |
| --- | --- | --- |
| **A. 16 agents / your own machines** | Good | "How is this different from just running them?" — answerable, on-topic |
| **B. rotates 7 Claude accounts** | Highest | **"Is this a ToS violation?"** — thread becomes about Anthropic, not you |
| **C. machines you own, not a cloud sandbox** | Moderate | "Sandboxing exists for a reason" — on-topic, mild |

Recommendation: **A**, with B's rotation detail moved into the body where it is
context rather than the headline claim.

## Findings

### Why "stress tested" is a real cost, not a caveat

A Show HN title is a promise the thread will try to falsify. That is the
mechanic that makes a specific number valuable — a reader can evaluate the claim
from the title alone, which is why they click. It is the same mechanic that makes
the wrong number expensive.

Candidate B is `Show HN: Agi - open-source CLI that rotates 7 Claude accounts so
runs never stall`. It contains two separately attackable things:

**1. "7 Claude accounts" invites a terms-of-service argument.** HN has a
well-established reflex for anything that looks like working around a vendor's
rate limits. The likely top comment is some form of *"isn't this just circumventing
per-seat pricing?"* You have a good answer — they are subscriptions you pay for,
one human, and rotation picks by remaining headroom rather than evading a cap —
but you will be *making* that answer instead of talking about the product. Worse,
the answer is not fully yours to give: whether it is permitted is Anthropic's call,
not yours, so you cannot close the argument, only participate in it.

**2. "never stall" is an absolute.** One commenter reporting a stall falsifies the
title. Absolutes read as marketing to this audience, and the empirical analysis
already showed hype-shaped titles score badly (n=9, none cleared 50 points).

The cost is not that the launch fails. It is that a thread which should be about
a control plane for coding agents becomes a referendum on multi-account usage,
and the top-voted takeaway is "clever rate-limit workaround" rather than
"infrastructure I want."

### What the thread will attack regardless of title

Prepare these four. Having a crisp answer ready is worth more than the title
choice, because engagement from the submitter is what correlates with ranking
longevity.

| Objection | The honest answer |
| --- | --- |
| **"Why not just run the harnesses directly?"** | Because the hard part is not starting agents, it is that they stall — they ask a question and idle, or stop mid-task. Sessions, resume, and the fleet view exist to notice a stopped agent and get it moving. Lead with this; it is the actual thesis. |
| **"Isn't this what OpenCode / Claude Code already do?"** | Those are harnesses. This runs *them*, plus 14 others, across machines you own. It is a layer up, not a competitor. Say so plainly — the distinction is real and easy to miss. |
| **"Multiple accounts sounds like a ToS problem."** | They are subscriptions you pay for; rotation picks by remaining headroom, and skips rate-limited accounts rather than evading limits. If it is in the body rather than the title, this stays a footnote. |
| **"This is a lot of surface for one tool."** | Fair. It is a power-user tool and the docs assume you already run agents daily. Concede it rather than defending; conceding a real weakness buys credibility for everything else. |

## Evidence

Numbers in the bodies below, and where each comes from:

| Claim | Source |
| --- | --- |
| 16 harnesses | `apps/cli/AGENTS.md` harness parity list |
| 3,703 session transcripts | `find ~/.agents/.history/versions -name '*.jsonl'` |
| Several accounts per harness, headroom-scheduled | `agents view` output |
| Apache-2.0 | `LICENSE` |

Do not put a number in a post you have not run the command for that morning.
The one certainty about HN is that someone will check.

## Recommendations

### The Show HN title, ranked

```
A.  Show HN: Open-source CLI that runs 16 coding agents across your own machines
B.  Show HN: Agi - open-source CLI that rotates 7 Claude accounts so runs never stall
C.  Show HN: Run coding agents on machines you own, not a per-seat cloud sandbox
```

**A is the pick.** 76 characters, inside the 65-85 band that averaged 11.0 points
against 6.1 for short titles. It carries "open-source" (the strongest single
lever: mean 23.7 vs 8.4) and a number (17.3 vs 8.2), and the number it carries —
16 — is checkable, defensible, and boring in the right way. Nobody starts a fight
about how many harnesses you support.

### The full Show HN body

Paste as-is. Roughly 190 words, which is the right length: enough to establish
the thesis, short enough that the comments carry the rest.

```
agi-cli is a control plane for running many coding agents at once and driving
each one to a merged PR rather than just starting it.

Starting an agent is the easy part. The hard part is that agents stall: they
ask a question and idle, stop mid-task, or hand work back instead of finishing
it. Most of what is in here exists to notice an agent that stopped making
progress and get it moving again.

It installs and version-pins the harnesses (Claude, Codex, Gemini, Cursor,
OpenCode, Grok, Droid and 9 more), runs them on subscriptions you already pay
for, and spreads work across your own machines over SSH.

Some specifics:

- Sessions are first-class: searchable transcripts synced across devices, and
  resumable on a different machine than they started on.
- Teams run several agents in parallel, each isolated in its own git worktree
  with an explicit boundary contract so they do not clobber each other.
- The browser is a shared resource. Several agents can attach to one live
  browser session instead of each spawning its own and re-authenticating.
- Secrets sit in the OS keychain and inject into headless runs, so unattended
  work does not stall on a Touch ID prompt.
- Several accounts of the same harness rotate under one policy, picked by
  remaining headroom.

Apache-2.0. It is a power-user tool and the docs assume you already run agents
daily. Happy to go into the scheduling or the session model.
```

Note the last bullet: the rotation detail is present, but as the fifth item in a
list rather than the headline. It gets discovered by people who read, which is
the audience you want it to reach.

### The first comment, posted by you, immediately

Post this yourself within a minute of submitting. It absorbs the "why does this
exist" question before someone else frames it, and submitter engagement drives
ranking longevity.

```
Some context on why this exists rather than what it does.

I run a lot of coding agents concurrently across a handful of machines. The
failure mode that actually costs time is not a bad diff, it is an agent that
quietly stopped: waiting on a prompt nobody answered, or idle mid-task with the
work half-done. Idle-but-unfinished is the worst state because it looks like
nothing is wrong.

So the design consequence is that every status surface ranks by progress rather
than liveness. A running agent needs nothing from you. The ones that need you
are the ones that stopped, and those get surfaced first instead of buried under
the healthy ones.

Happy to answer anything about the session model, the scheduler, or where it
falls over.
```

### The r/ClaudeAI and r/ClaudeCode post

Do **not** post the launch here. These subs expect roughly 90/10 helpful-to-promo,
and a cold launch post reads as spam. Post a workflow; let the tool be incidental.

```
Title: How I stopped losing work to agents that stall mid-task
```

```
The thing that costs me the most time with Claude Code is not a bad edit. It is
a session that quietly stopped — waiting on a prompt I never saw, or idle
halfway through with the work unfinished. It looks identical to a session that
is thinking.

Two things that helped more than any prompt change:

1. Rank sessions by progress, not by whether they are running. A running agent
   needs nothing from me. The ones worth my attention are the stopped ones, and
   idle-but-unfinished is the highest risk state, not the lowest — that is the
   one most likely to get silently abandoned.

2. Make the completion contract explicit in CLAUDE.md. "Your task is done when
   the PR is merged, or you have named who now owns it" removed most of the
   hand-back-and-idle behavior for me. Agents stop at "PR opened" unless you
   tell them that is not the finish line.

[concrete config here]

I ended up building tooling around this (link in profile / happy to share if
useful) but the two ideas above work with plain Claude Code and cost nothing.
```

Mention the tool once, near the end, or not at all on the first post. If it
lands, the follow-up post is where the link goes. Two useful posts beat one
promotional one.

### The r/LocalLLaMA post

This audience is local-model-first. Do not lead with Claude, and do not lead with
features. Lead with ownership.

```
Title: Running coding agents across your own boxes instead of a per-seat cloud sandbox
```

```
Most agent tooling assumes the agent runs in someone else's sandbox, billed per
seat. I wanted the opposite: agents running on hardware I already own, over SSH,
against whatever model I point them at.

What that ended up requiring:

- A dispatch layer that treats a fleet of machines as one address space, so work
  goes to a box with headroom rather than the one I am sitting at.
- Session transcripts that sync across devices, so a run started on one machine
  is searchable and resumable from another.
- Parallel agents isolated per git worktree, because the moment two agents share
  a checkout they clobber each other's index.

It is harness-agnostic — it drives Claude, Codex, and Gemini, but it will drive a
local model through OpenCode just as happily, which is the configuration I would
actually recommend if you are trying to keep everything on your own metal.

Apache-2.0. Genuinely interested in what breaks for people running fully local.
```

### Sequence

92% of a Show HN's star impact is gone after 48 hours, so everything fires in one
window.

| When | Action |
| --- | --- |
| -14 days | Start commenting in r/ClaudeAI, r/ClaudeCode, r/LocalLLaMA. Aged presence is the prerequisite; a cold account gets removed |
| -14 days | Open the awesome-list PRs — they have review lag |
| -1 day | Pre-seed past 100 stars |
| 0 (Sun 7pm ET) | Show HN, then your own first comment within a minute |
| +0-2h | r/ClaudeCode, r/LocalLLaMA, r/commandline |
| +2h | X thread with the hero GIF |
| +4h | Product Hunt |
| +0-48h | Answer every comment personally |

### What not to do

- Do not run title B unless you are prepared for the thread to be about Anthropic's
  terms rather than your product.
- Do not post identical copy to several subreddits. That is the fastest route to
  removal from all of them, which is why the three bodies above are genuinely
  different rather than reskinned.
- Do not put a number in any post you have not re-run the command for that morning.
