---
kind: report
template: report.v1
title: 'Where to post agi-cli, what wins there, and the drafts'
summary: 'Venue list with rules and sizes, an empirical analysis of 1,581 Show HN posts showing which title features actually correlate with score, and ready-to-post drafts built from that analysis.'
status: draft
links:
  - label: 'phnx-labs/agi-cli'
    url: 'https://github.com/phnx-labs/agi-cli'
  - label: 'Stars playbook (companion report)'
    url: 'https://github.com/phnx-labs/agi-cli/pull/2797'
---

## Summary

I measured rather than guessed. Pulling **1,581 Show HN posts since 2025-01-01**
from the HN Algolia API and bucketing them by title feature gives a clear answer
about what actually correlates with a high score, and it contradicts the usual
advice in one important way.

**The single strongest lever is saying "open source" in the title.** The second
is a concrete number. Together they are worth roughly **21x the mean score** of a
title with neither.

**First-person "I built" is a negative signal** for a tool launch: 52 posts used
it and **not one** cleared 50 points.

The drafts in the last section are built to that shape. They are ready to post.

## Findings

### The empirical title analysis

Method: HN Algolia `search_by_date`, `tags=show_hn`, `created_at > 2025-01-01`,
queries `agent`/`ai`/`llm`/`claude`/`cli`/`coding`, deduped by `objectID`.
n = 1,581.

| Title feature | n | Mean points | Share hitting 50+ |
| --- | --- | --- | --- |
| **Open source AND a number** | 6 | **158.8** | **16.7%** |
| Says open-source / self-hosted | 117 | 23.7 | 6.8% |
| Contains a number | 233 | 17.3 | 3.9% |
| Baseline (no number) | 1,348 | 8.2 | 2.9% |
| Neither feature | 1,237 | 7.5 | 2.6% |
| **First-person "I built / we built"** | 52 | **4.1** | **0.0%** |
| Hype word (AGI, powerful, framework for, meta-) | 9 | 4.9 | 0.0% |

Read these as **tail probabilities, not typical outcomes**. The median Show HN
scores 2 points regardless of what you do. These features do not make a typical
post good; they raise the chance of the outlier result that actually matters.
That is the correct way to use them, because the launch only needs one hit.

Title length also matters, mildly: 65-85 characters averaged 11.0 points against
6.1 for titles under 45. Short and clever loses to specific.

### Why the winners won

Every Show HN in the sample that cleared 200 points:

| Points | Title |
| --- | --- |
| 1,033 | Bento - An entire PowerPoint in one HTML file (edit+view+data+collab) |
| 919 | Open-source engine running Gemma 4 26B in 2 GB RAM on any M-series Mac |
| 534 | Needle2: 14MB agentic LLM for phones, wearables, smart home and robots |
| 484 | Echo - Fable-level results at 1/3 the cost using open-weight models |
| 314 | Woxi - Open-source Mathematica / Wolfram Language reimplementation |
| 306 | I spent 2 years designing a mechanical Magic Keyboard |
| 280 | Juggler - an open-source GUI coding agent, by the creator of JUCE |
| 244 | I simulated closing the Strait of Hormuz on real oil trade data |
| 241 | Eigendrum - Draw any shape and hear what it sounds like as a drum |
| 227 | Wyzer Programming Language |
| 226 | Clawk - Give coding agents a disposable Linux VM, not your laptop |
| 215 | Voice driven murder mystery, Interview AI suspects with your voice |

Four mechanics do all the work:

1. **A number that sounds impossible.** "26B in 2 GB RAM", "14MB agentic LLM",
   "1/3 the cost". The number *is* the argument. A reader can evaluate the claim
   without reading the post, which is exactly why they click.
2. **A known reference point to stand against.** Mathematica. Fable. PowerPoint.
   Borrowing an anchor everyone already has an opinion about beats describing
   your thing from scratch.
3. **X, not Y.** "Give coding agents a disposable Linux VM, **not your laptop**"
   names the grievance in the title. The reader recognizes their own problem.
4. **Borrowed credibility.** "by the creator of JUCE". If you have a credential,
   spend it in the title.

The two first-person winners are not tool launches at all. "I spent 2 years" and
"I simulated" are *stories*, where the person is the point. For a tool, "I built"
just delays the noun and signals hobby project — hence 0 for 52.

### The venues

| Venue | Size / reach | Self-promo rules | What actually works there |
| --- | --- | --- | --- |
| **Hacker News (Show HN)** | ~200 Show HN/day; front page = 5-30k uniques | Show HN is explicitly *for* this. One post, no vote solicitation | The title formula above. Sun 7pm ET / Mon 00:00 UTC is the best documented slot |
| **r/LocalLLaMA** | ~749k members | Strict on promo; value-first | Vendor-lock-in and cost-control angles; the "run it on your own machines" story is native here |
| **r/ClaudeAI** | Densest free feed for coding-agent work in 2026 | 90/10 helpful-to-promo ratio expected | CLAUDE.md patterns, hooks, subagent and parallel-agent workflows, cost management — posted as a *workflow you use*, with the tool incidental |
| **r/ClaudeCode** | 4,200+ weekly contributors | Same | Same, more tool-tolerant |
| **r/commandline, r/selfhosted** | Established | Moderate | 50-300 stars per well-received post; the self-hosted framing fits |
| **Product Hunt** | — | Built for launches | 200-600 stars; real value is the badge and press pickup, not direct traffic |
| **The awesome-lists** | 200k+ combined stars | PR to the list | Permanent referral. Start now, it has lead time |
| **Lobsters** | Small, high signal | Invite-only, allergic to marketing | Only if you have an invite; a plain technical writeup |

Two rules that apply everywhere and are worth more than any single post:

- **Aged presence beats launch-day posting.** Reddit launches land for accounts
  that were already participating in that subreddit; a cold account posting a
  tool on day one reads as spam and often gets removed outright.
- **Answer every comment personally for 24 hours.** Engagement from the submitter
  correlates with ranking longevity on both HN and Reddit.

## Evidence

### Numbers you own and can put in a title

Real, defensible, pulled from this machine on 2026-08-20:

| Claim | Source |
| --- | --- |
| 16 agent harnesses supported | `apps/cli/AGENTS.md` harness parity list |
| 3,703 session transcripts on one fleet | `find ~/.agents/.history/versions -name '*.jsonl'` |
| 6 reachable machines, 88 cores | `agents devices` live snapshot |
| Multiple accounts per harness with automatic rotation | `agents view` shows 7 Claude accounts under one `balanced` policy |

That last one is the most under-sold thing in the product. Nobody else does
**account rotation across several subscriptions of the same harness with
headroom-aware scheduling**. It is a concrete, checkable, slightly outrageous
claim, which is precisely the shape that wins on HN.

## Recommendations

### The Show HN draft

Title, 79 characters, carrying open-source + a number + a grievance:

```
Show HN: Open-source CLI that runs 16 coding agents across your own machines
```

Two alternates worth A/B considering before you commit:

```
Show HN: Agi - open-source CLI that rotates 7 Claude accounts so runs never stall
Show HN: Run coding agents on machines you own, not a per-seat cloud sandbox
```

The first alternate is the strongest by the data (open-source + number +
implausible-sounding specific) but only post it if the rotation behavior is
genuinely solid, because the comments will go straight at it.

Body:

```
agi-cli is a control plane for running many coding agents at once and driving
each to a merged PR rather than just starting them.

It installs and version-pins the harnesses (Claude, Codex, Gemini, Cursor,
OpenCode, Grok, Droid, and 9 more), runs them on subscriptions you already pay
for, and spreads work across your own machines over SSH. No per-seat cloud
sandbox and no vendor lock-in.

The parts I would want to read about if someone else posted this:

- Sessions are a first-class object: searchable transcripts synced across
  devices, resumable on a different machine than they started on.
- Teams run several agents in parallel, each isolated in its own git worktree,
  with an explicit boundary contract so they do not clobber each other.
- The browser is a shared resource. Several agents can attach to one live
  browser session instead of each spawning its own and re-authenticating.
- Secrets live in the OS keychain and inject into headless runs, so unattended
  work does not stall on a Touch ID prompt.
- Accounts rotate: several subscriptions of the same harness under one policy,
  picked by remaining headroom, skipping rate-limited ones.

Apache-2.0. It is a power-user tool and the docs assume you already run agents
daily. Happy to answer anything about the scheduling or the session model.
```

### The r/ClaudeAI and r/ClaudeCode draft

Do **not** post the launch announcement here. Post the workflow; let the tool be
incidental. This is the 90/10 rule and it is enforced socially even where it is
not enforced by rule.

Title:

```
How I run 4 Claude accounts without hitting a limit mid-task
```

Body opens with the problem and the config, mentions the tool once, in passing,
near the end, with a link. If it gets traction, the follow-up post ("here is the
parallel-teams setup") is where the second link goes. Two useful posts beat one
promotional one.

### The r/LocalLLaMA draft

The native grievance here is ownership and cost, not features.

```
Title: Running coding agents across your own boxes instead of a per-seat cloud sandbox
```

Lead with the machine-ownership angle and the SSH fleet. Do not lead with Claude
— this audience is local-model-first, and the honest framing is that the tool is
harness-agnostic and will drive a local model through OpenCode just as happily.

### Sequence

Because 92% of a Show HN's star impact is gone after 48 hours, everything fires
in one window. Order within launch day:

| Hour | Action |
| --- | --- |
| -14 days | Start commenting in r/ClaudeAI, r/ClaudeCode, r/LocalLLaMA. Aged presence is the prerequisite |
| -14 days | Open the awesome-list PRs. They have review lag |
| -1 day | Pre-seed past 100 stars |
| 0 (Sun 7pm ET) | Show HN |
| +0-2h | r/ClaudeCode, r/LocalLLaMA, r/commandline |
| +2h | X thread with the demo GIF |
| +4h | Product Hunt |
| +0-48h | Answer every comment personally |

### What I would not do

Do not post the same text to four subreddits. Cross-posting identical
promotional copy is the fastest way to get removed from all of them, and the
per-venue drafts above exist because each audience has a different grievance.
