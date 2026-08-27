---
kind: report
template: report.v1
title: 'agi-cli launch worksheet'
summary: 'Every open item to take agi-cli from 15 stars to a launched project, with an owner and a status on each. Four decisions are yours; the rest is work I can do once they are made.'
status: draft
human: author
host: fleet-worker
session: n/a
links:
  - label: 'phnx-labs/agi-cli'
    url: 'https://github.com/phnx-labs/agi-cli'
  - label: 'Stars research (merged)'
    url: 'https://github.com/phnx-labs/agi-cli/pull/2797'
  - label: 'Launch post drafts (merged)'
    url: 'https://github.com/phnx-labs/agi-cli/pull/2809'
---

## Summary

State as of 2026-08-20: **15 stars, 17 open issues, 0 labelled `good first issue`,
0 topics on three sibling repos, nothing posted to any venue.**

**2 of 26 tasks are complete.** Four decisions are yours; everything else is work I
can execute once those land.

<figure>
<svg viewBox="0 0 760 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Progress bars for all five phases: 2 of 26 launch tasks complete, plus 4 decisions pending">
  <text x="20" y="24" font-family="system-ui, sans-serif" font-size="12" font-weight="600" fill="#8a8a8a">LAUNCH READINESS — 2 of 26 tasks complete</text>

  <text x="20" y="56" font-family="ui-monospace, monospace" font-size="11" fill="#b45309">Decisions</text>
  <rect x="150" y="45" width="540" height="14" rx="3" fill="#e8e8e8"/>
  <text x="700" y="56" font-family="ui-monospace, monospace" font-size="11" fill="#b45309">0 / 4</text>

  <text x="20" y="86" font-family="ui-monospace, monospace" font-size="11" fill="#7a7a7a">Phase 0 · bugs</text>
  <rect x="150" y="75" width="540" height="14" rx="3" fill="#e8e8e8"/>
  <text x="700" y="86" font-family="ui-monospace, monospace" font-size="11" fill="#7a7a7a">0 / 4</text>

  <text x="20" y="116" font-family="ui-monospace, monospace" font-size="11" fill="#7a7a7a">Phase 1 · page</text>
  <rect x="150" y="105" width="540" height="14" rx="3" fill="#e8e8e8"/>
  <rect x="150" y="105" width="108" height="14" rx="3" fill="#4d7c0f"/>
  <text x="700" y="116" font-family="ui-monospace, monospace" font-size="11" fill="#7a7a7a">1 / 5</text>

  <text x="20" y="146" font-family="ui-monospace, monospace" font-size="11" fill="#7a7a7a">Phase 2 · lists</text>
  <rect x="150" y="135" width="540" height="14" rx="3" fill="#e8e8e8"/>
  <text x="700" y="146" font-family="ui-monospace, monospace" font-size="11" fill="#7a7a7a">0 / 5</text>

  <text x="20" y="176" font-family="ui-monospace, monospace" font-size="11" fill="#7a7a7a">Phase 3 · ignition</text>
  <rect x="150" y="165" width="540" height="14" rx="3" fill="#e8e8e8"/>
  <text x="700" y="176" font-family="ui-monospace, monospace" font-size="11" fill="#7a7a7a">0 / 8</text>

  <text x="20" y="206" font-family="ui-monospace, monospace" font-size="11" fill="#7a7a7a">Phase 4 · cadence</text>
  <rect x="150" y="195" width="540" height="14" rx="3" fill="#e8e8e8"/>
  <rect x="150" y="195" width="135" height="14" rx="3" fill="#4d7c0f"/>
  <text x="700" y="206" font-family="ui-monospace, monospace" font-size="11" fill="#7a7a7a">1 / 4</text>

  <text x="20" y="238" font-family="system-ui, sans-serif" font-size="11" fill="#7a7a7a">Research and drafting are done and merged. Execution against a venue has not started.</text>
</svg>
<figcaption>All five phases, 26 rows total. The two complete are the README hero fix (Phase 1) and the already-running weekly release cadence (Phase 4). Decisions are shown separately because they gate the rest rather than being tasks.</figcaption>
</figure>

## Findings

### Decisions only you can make

Nothing below Phase 1 moves until these are settled.

| # | Decision | Options | My recommendation |
| --- | --- | --- | --- |
| **D1** | Launch at all, and when? | Now (HN + PH only) · In ~2 weeks (full multi-channel) · Hold | **2 weeks.** Reddit needs aged accounts or the posts get removed, and the multi-channel 48h window is the whole mechanic |
| **D2** | Which Show HN title? | A · C (B is out) | **A** — `Show HN: Source-available CLI that runs 16 coding agents across your own machines` |
| **D3** | Fix RUSH-2858 before launching? | Fix first · Launch and stay quiet about rotation | **Fix first.** Rotation is a top differentiator and a commenter can falsify it today |
| **D4** | Do I open the awesome-list PRs now? | Yes · Wait for D1 | **Yes.** They have review lag, they compound, and they do not depend on a launch date |

### Owner key

**You** = only you can do it. **Me** = I execute on your go-ahead. **Either** = I can
draft, you approve before it goes out.

## Evidence

Current measured state, so the worksheet is not aspirational:

| Signal | Value | Source |
| --- | --- | --- |
| Stars | **15** | `gh repo view phnx-labs/agi-cli` |
| Open issues | **17** | `gh issue list --state open` |
| Issues labelled `good first issue` | **0** | `gh issue list --label 'good first issue'` |
| Topics on `agi-cli` | 10 (fine) | `gh repo view` |
| Topics on `.agents-system` / `.agents-extras` / `homebrew-tap` | **0 / 0 / 0** | `gh repo view` each |
| Posted to any venue | **none** | — |
| npm published | 1.22.42, installed matches | `npm view` / `agents --version` |

## Recommendations

### Phase 0 — unblock the claims (before any launch)

| ✓ | Task | Owner | Ticket | Notes |
| --- | --- | --- | --- | --- |
| ☐ | Fix balanced rotation dispatching to session-limited accounts | Me | RUSH-2858 | Gates D3. Makes the rotation claim safe to say out loud |
| ☐ | Fix `artifacts render` leaking device/session names | Me | RUSH-2846 | Also sweep already-merged artifacts that leak |
| ☐ | Fix `pr-merge-on-green` never firing | Me | RUSH-2848 | Not launch-blocking, but it silently strands PRs today |
| ☐ | Fix monitor children having no `gh` auth | Me | RUSH-2860 | Same class; a monitor reports `ok` and does nothing |

None of these are launch-blocking except RUSH-2858. The other three are here
because they are live defects found while doing this work, and they will bite
whoever runs the launch automation.

### Phase 1 — fix the page

| ✓ | Task | Owner | Notes |
| --- | --- | --- | --- |
| ☑ | **Make the hero demo render** | Me | **Done.** Was a bare mp4 URL GitHub showed as a blue link; now an 860px GIF. Merged in #2797 |
| ☐ | Rewrite the opening sentence to one repeatable claim | Either | Draft ready: *"Run Claude, Codex, and Gemini in parallel across your own machines, on the subscriptions you already pay for."* Replaces the 12-capability run-on |
| ☐ | Add per-feature demo GIFs, ranked by real usage | Me | Order is measured, not guessed: sessions (82,704 invocations) → run (63,236) → secrets (43,927) → teams (43,413) → browser (22,930) → computer (19,207) |
| ☐ | Label 5-8 issues `good first issue`, answer the rest | Either | 17 open, 0 labelled. Unanswered issues read as abandonment to a first-time visitor |
| ☐ | Add topics to the three sibling repos | Me | `.agents-system`, `.agents-extras`, `homebrew-tap` are all at 0 |

The browser demo needs three beats, not one: **local** profile, **remote**
`--device`, and **several agents sharing one browser** via `--attach`. The third
is the differentiated one and no competitor demo shows it.

### Phase 2 — permanent placement (start now, has lead time)

| ✓ | Target | Owner | Notes |
| --- | --- | --- | --- |
| ☐ | `affaan-m/ECC` (was `everything-claude-code`) | Me | **241,474 stars** — the single biggest one. Renamed since the research; use the current path |
| ☐ | `hesreallyhim/awesome-claude-code` | Me | |
| ☐ | `sst/opencode` adjacent-tool lists | Me | |
| ☐ | `punkpeye/awesome-mcp-servers` | Me | Only if an MCP surface genuinely qualifies |
| ☐ | General `awesome-ai-agents-2026` lists | Me | |

Unlike an HN post, an accepted entry does not expire in 48 hours. This is the
compounding asset and it is gated only on **D4**.

### Phase 3 — the 48-hour ignition

| ✓ | When | Task | Owner |
| --- | --- | --- | --- |
| ☐ | -14 days | Start commenting in r/ClaudeAI, r/ClaudeCode, r/LocalLLaMA | **You** — needs a real human account with history |
| ☐ | -1 day | Pre-seed past 100 stars | **You** — colleagues, existing users |
| ☐ | Hour 0 (Sun 7pm ET) | Post the Show HN | **You** — your identity, your account |
| ☐ | Hour 0 +1min | Post the prepared first comment | **You** — draft is written |
| ☐ | Hour 0-2 | r/ClaudeCode, r/LocalLLaMA, r/commandline | **You** |
| ☐ | Hour 2 | X thread with the hero GIF | Either |
| ☐ | Hour 4 | Product Hunt | Either |
| ☐ | Hour 0-48 | Answer every comment personally | **You** — this drives ranking longevity |

Cold accounts get removed, so the -14 day item is a real prerequisite, not a
nicety. Everything in this phase is yours because it runs under your identity.

### Phase 4 — cadence (from day 3)

| ✓ | Task | Owner | Notes |
| --- | --- | --- | --- |
| ☑ | Weekly releases | — | Already happening |
| ☐ | One written piece per week | Either | |
| ☐ | Issue response within 24 hours | Either | |
| ☐ | Follow-up Show HN on one subsystem, 4-6 weeks out | Either | |

The 43-day mark is where the curve separates projects that kept pushing from
those that took the spike and stopped.

### How you will know it worked

| Milestone | Benchmark | Current |
| --- | --- | --- |
| Trending eligibility | ~50 stars/day | **0.12/day** since the repo was created 2026-04-20 (15 stars / 122 days); 0.18/day if measured from the first star on 2026-05-30 |
| A coordinated launch | ~1,000 stars in 72h | never attempted |
| Genuine traction | ~6,000 stars in 7 days | — |

### What I am NOT doing without a decision

- Posting anything to any venue.
- Opening PRs against other people's repositories.
- Rewriting the README's opening claim, since the voice is yours.
