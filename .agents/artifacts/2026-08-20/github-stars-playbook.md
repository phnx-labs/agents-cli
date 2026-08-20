---
kind: report
template: report.v1
title: 'How repos get stars in 2026, and why agi-cli has 15'
summary: 'Case studies from AFFiNE, OpenCode, and a 188k-post Show HN dataset, applied to this repo. The blocker is not tactics: no launch has ever happened, the demos do not show what the tool is actually used for, and the hero demo rendered as a plain blue link.'
status: draft
links:
  - label: 'phnx-labs/agi-cli'
    url: 'https://github.com/phnx-labs/agi-cli'
  - label: 'Show HN 188k-post dataset'
    url: 'https://danfking.github.io/blog/2026/04/23/show-hn-by-the-numbers/'
---

## Summary

The repo has **15 stars in 194 days** (first star 2026-05-30, latest 2026-08-20).
That is 0.18 stars/day. Language-specific GitHub Trending starts at roughly
**50 stars/day**. Nothing in the current setup is within two orders of magnitude
of the discovery threshold, and no coordinated launch has ever been run.

Three things are true at once, and only the third is a tactics problem:

1. **The project has never launched.** No Show HN, no Product Hunt, no Reddit
   post, no awesome-list submission. Every star so far arrived by accident.
2. **The name is fragmented, though the rebrand itself was forced.**
   `google/agents-cli` (5,693 stars) took the original name, so the move to
   `agi-cli` was defensive and is settled. What is left is residual drift: an
   npm package still called `@phnx-labs/agents-cli` (1,857/wk) against
   `@phnx-labs/agi-cli` (7/wk), and two domains. The personal mirror was made
   private on 2026-08-20.
3. **The README's hero demo is invisible.** Line 42 is a bare
   `https://agi-cli.sh/demo.mp4`. GitHub renders it as a blue link. The rendered
   README contains **zero `<video>` elements**.

The opportunity is that the category is the hottest distribution surface on
GitHub right now: the Claude Code ecosystem's curated lists hold **200,000+
combined stars**, and this project appears in none of them.

## Findings

### The 2026 meta, in one line

Stars are won in a **48-hour ignition window** and compounded by **permanent
placement in aggregator lists**. Everything else is preparation for those two.

### 1. Velocity, not volume, is what the algorithm rewards

GitHub Trending ranks on **star velocity** measured against a repo's own
baseline, not absolute count. A repo that normally gets 2 stars/day getting 10
outranks one that normally gets 50 getting 60. That is why a coordinated
multi-channel push works and a steady drip never does: the same 300 stars spread
over three months produce zero trending appearances, while 300 in two days
produce a listing that then does the marketing for free.

AFFiNE recorded **28 Trending appearances in 5 months** off this mechanic. The
practical floor cited is **50 stars/day for language-specific Trending**, which
has far less competition than All Languages.

### 2. Show HN is the highest-leverage single event, and the data is unforgiving

From a study of **188,085 Show HN posts (2012 to April 2026)**, 51,338 of which
linked to a GitHub repo:

| Metric | Value |
| --- | --- |
| Median Show HN score | **2 points** |
| Score to reach top 6% | 50 points |
| Score to reach 99th percentile | 263+ |
| Front-page rate, Q1 2026 | **2.3% of submissions** |
| Upvote to star conversion (48h) | **~1.4 stars per upvote** |
| Conversion at 258-350 points | 1.77 stars/point |
| Conversion at 700+ points | 0.79 stars/point |
| Star impact expired after 48h | **~92%** |
| Best slot | **Mon 00:00 UTC (Sun 7pm ET)**, 10.8% chance of 50+ |
| Worst slot | Thu 06:00 UTC, 2.6% |
| Daily competition | ~200 Show HN posts/day, up from ~30 a decade ago |

Two things to internalize. **HN score explains only 8% of the variance in stars**
(r = 0.29), and **comment count predicts nothing** (r = 0.10). The post is a
trigger, not the strategy. And the window is short: day 1 is a 1,200x spike over
baseline, day 2 collapses to roughly 40 stars. Every other channel has to fire
inside that same window or its traffic is wasted.

One more figure worth planning around: front-page Show HNs drive **5,000-30,000
unique visitors in 24 hours**, with a search-driven long tail for 6-12 months.

### 3. The README is a product page, and the lift is measurable

AFFiNE reports a **2.3x star rate after README optimization**. The structure that
produced it:

- One hero image or video **above the fold**
- **5-7 functional GIFs or screenshots** showing the tool actually running
- A one-sentence value proposition, not a paragraph and not a feature list
- Quick start in **under 5 steps**
- A visible star CTA

### 4. In this category, the aggregator lists are the compounding asset

This is the finding most specific to this repo. The Claude Code ecosystem's
community lists have accumulated **200,000+ combined stars across 11 curated
lists**, with the largest single aggregator (`affaan-m/everything-claude-code`)
past **163,000 stars** on its own. `claude-flow` sits at 59.4k, `SuperClaude` at
23k+, and the official Claude Code repo crossed 131,000 by June 2026.

An accepted awesome-list entry is permanent referral traffic. It does not decay
in 48 hours the way an HN post does. For a tool whose job is orchestrating
Claude, Codex, and Gemini harnesses, absence from every one of those lists is the
largest unclaimed lever here.

### 5. Positioning beats the feature list

OpenCode went from launch in June 2025 to **160,000+ stars**, hitting #1 on
Hacker News on 2026-03-20. The top-voted sentiment in that thread was not about a
feature. It was relief at **not being locked to one vendor**: connect Claude,
GPT, Gemini, or local models from the same interface.

That is one sentence a stranger can repeat to another stranger. It compresses the
product into a grievance the audience already had.

### 6. After the spike, cadence is what holds the line

The post-launch requirements that separate a spike from a curve:

- **Weekly releases**, which signal the project is alive
- **One content piece per week** (blog, tutorial, follow-up Show HN)
- **Issue response inside 24 hours**; unanswered issues read as abandonment
- Continuous awesome-list submissions

### 7. Documented failure modes

The case studies are explicit about what kills launches:

1. **Launching from 0 stars.** Cold repos convert at roughly 5%; pre-seeding past
   100 raises it materially. Social proof is a precondition, not a result.
2. **Spreading the launch across several days** instead of one 48-hour window.
3. **Abandoning momentum** after the first spike.
4. **Ignoring open issues.**
5. **A README with no visual hierarchy and no clear value proposition.**

## Evidence

### The repo's actual position

Every number below was pulled live from the GitHub and npm APIs on 2026-08-20.

| Signal | Measured value | What it implies |
| --- | --- | --- |
| Stars, `phnx-labs/agi-cli` | **15** | ~0.18/day since the first star |
| First star to today | 2026-05-30 to 2026-08-20 (82 days) | 194 days since repo creation |
| Stars, `muqsitnawaz/agents-cli` | **3** | Split equity; resolved 2026-08-20 by making it private |
| Traffic on the mirror | **3 views / 3 uniques in 14 days** | No discovery surface at all |
| Topics on `agi-cli` | 10, which is fine | `.agents-system`, `.agents-extras`, `homebrew-tap` have **0** |
| Open issues | **18** | No `good first issue` label present |
| npm `@phnx-labs/agents-cli` | **1,857/week** | Likely dominated by fleet self-upgrades, worth verifying |
| npm `@phnx-labs/agi-cli` | **7/week** | The advertised name has no install base |
| `<video>` tags in rendered README | **0** | The hero demo is a dead-looking link |

### The hero demo does not render

`README.md:42` is the line `https://agi-cli.sh/demo.mp4`. Fetching GitHub's own
rendered HTML for that README returns:

```html
<p dir="auto"><a href="https://agi-cli.sh/demo.mp4" rel="nofollow">https://agi-cli.sh/demo.mp4</a></p>
```

GitHub only auto-embeds a player for video uploaded to its own
`user-attachments` host. An external URL is a link. The most persuasive
above-the-fold asset on the page is currently a line of blue text that most
visitors will read as a broken embed.

### Star trajectory against a launch benchmark

<figure>
<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Two panels comparing this repo's 15 stars over 194 days against a coordinated launch reaching 1000 stars in 72 hours">
  <text x="20" y="24" font-family="system-ui, sans-serif" font-size="13" font-weight="600" fill="#8a8a8a">ACTUAL — agi-cli</text>
  <text x="20" y="52" font-family="ui-monospace, monospace" font-size="22" font-weight="700" fill="#b45309">15 stars</text>
  <text x="20" y="70" font-family="system-ui, sans-serif" font-size="11" fill="#7a7a7a">194 days · 0.18 per day</text>
  <line x1="60" y1="250" x2="340" y2="250" stroke="#8a8a8a" stroke-width="1"/>
  <line x1="60" y1="100" x2="340" y2="100" stroke="#c9c9c9" stroke-width="1" stroke-dasharray="3 3"/>
  <line x1="60" y1="175" x2="340" y2="175" stroke="#c9c9c9" stroke-width="1" stroke-dasharray="3 3"/>
  <text x="30" y="104" font-family="ui-monospace, monospace" font-size="11" fill="#7a7a7a">20</text>
  <text x="30" y="179" font-family="ui-monospace, monospace" font-size="11" fill="#7a7a7a">10</text>
  <text x="36" y="254" font-family="ui-monospace, monospace" font-size="11" fill="#7a7a7a">0</text>
  <path d="M60,250 L96,250 L120,242 L142,235 L168,227 L196,220 L214,212 L232,205 L268,197 L290,190 L306,182 L322,175 L330,167 L336,160 L340,152" fill="none" stroke="#b45309" stroke-width="2.5"/>
  <circle cx="340" cy="152" r="3.5" fill="#b45309"/>
  <text x="62" y="268" font-family="ui-monospace, monospace" font-size="11" fill="#7a7a7a">Feb</text>
  <text x="316" y="268" font-family="ui-monospace, monospace" font-size="11" fill="#7a7a7a">Aug</text>

  <line x1="380" y1="20" x2="380" y2="280" stroke="#c9c9c9" stroke-width="1" stroke-dasharray="3 3"/>

  <text x="420" y="24" font-family="system-ui, sans-serif" font-size="13" font-weight="600" fill="#8a8a8a">BENCHMARK — 48h coordinated ignition</text>
  <text x="420" y="52" font-family="ui-monospace, monospace" font-size="22" font-weight="700" fill="#4d7c0f">1,000 stars</text>
  <text x="420" y="70" font-family="system-ui, sans-serif" font-size="11" fill="#7a7a7a">72 hours · about 14 per hour at peak</text>
  <line x1="460" y1="250" x2="740" y2="250" stroke="#8a8a8a" stroke-width="1"/>
  <line x1="460" y1="100" x2="740" y2="100" stroke="#c9c9c9" stroke-width="1" stroke-dasharray="3 3"/>
  <line x1="460" y1="175" x2="740" y2="175" stroke="#c9c9c9" stroke-width="1" stroke-dasharray="3 3"/>
  <text x="424" y="104" font-family="ui-monospace, monospace" font-size="11" fill="#7a7a7a">1k</text>
  <text x="418" y="179" font-family="ui-monospace, monospace" font-size="11" fill="#7a7a7a">500</text>
  <text x="436" y="254" font-family="ui-monospace, monospace" font-size="11" fill="#7a7a7a">0</text>
  <path d="M460,250 C482,248 496,200 520,150 C544,112 570,100 600,96 C640,92 700,90 740,89" fill="none" stroke="#4d7c0f" stroke-width="2.5"/>
  <text x="462" y="268" font-family="ui-monospace, monospace" font-size="11" fill="#7a7a7a">h0</text>
  <text x="500" y="268" font-family="ui-monospace, monospace" font-size="11" fill="#7a7a7a">h24</text>
  <text x="592" y="268" font-family="ui-monospace, monospace" font-size="11" fill="#7a7a7a">h48</text>
  <text x="716" y="268" font-family="ui-monospace, monospace" font-size="11" fill="#7a7a7a">h72</text>
</svg>
<figcaption>Same visual footprint, different y-axis. The left curve is what a project with no launch looks like; the right is the documented result of firing every channel inside one 48-hour window. The gap is distribution, not product.</figcaption>
</figure>

### The name is fragmented across five identities

| Identity | Where it points | Weight |
| --- | --- | --- |
| `phnx-labs/agi-cli` | canonical repo today | 15 stars |
| `muqsitnawaz/agents-cli` | personal mirror — **made private + archived 2026-08-20** | 3 stars, now 404 publicly |
| `phnx-labs/agi-cli-jul2026-archive` | private, "rebrand of agents-cli" | dormant |
| npm `@phnx-labs/agents-cli` | the package people install | 1,857/wk |
| npm `@phnx-labs/agi-cli` | the name the README advertises | 7/wk |

Two live domains (`agents-cli.sh` and `agi-cli.sh`), a repo named `agi-cli`, a
package named `agents-cli`, and a binary named `agents`. GitHub preserves stars
across a rename, but it does not preserve **word of mouth**: external backlinks
lose their SEO value, and a reader who hears the name once cannot find it twice.

### The value proposition is a 100-word run-on

The README's opening paragraph names twelve capabilities in a single sentence:
dispatch, measure, fold back, schedule, spawn teams, dispatch to cloud, watch
state, nudge, message mid-flight, store secrets, drive browsers, steer from a
menu bar. The repo description is "a meta-harness for building Agent Factories."

Compare OpenCode's one-liner: any model, one interface, no vendor lock-in.
Nobody repeats a twelve-item list.

## Recommendations

### The name is already settled, and the rebrand was correct

An earlier draft of this report recommended renaming back to `agents-cli`. That
was wrong, and the reason matters for the launch plan.

**`google/agents-cli` exists and has 5,693 stars.** Created 2026-04-08, described
as "The CLI and skills that turn any coding assistant into an expert at creating,
evaluating, and deploying AI agents on Google Cloud," with docs at
`google.github.io/agents-cli`. This repo was created first (2026-02-08), but
Google now holds roughly 380x the stars on that exact name.

| Name | Owner | Stars | Created |
| --- | --- | --- | --- |
| `google/agents-cli` | Google | **5,693** | 2026-04-08 |
| `phnx-labs/agi-cli` | this project | 15 | 2026-02-08 |

So the rebrand to `agi-cli` was defensive and necessary, not brand churn. Renaming
back would mean competing head-on for a query Google already owns, on a page with
380x the authority, and losing it permanently. **Keep `agi-cli`. The name is
decided; do not revisit it.**

What remains is not a naming decision but a **cleanup of residual fragmentation**,
and none of it requires renaming anything:

| Loose end | State | Action |
| --- | --- | --- |
| `muqsitnawaz/agents-cli` mirror | **resolved 2026-08-20** — set private + archived, now 404 to the public | done |
| npm `@phnx-labs/agents-cli` (1,857/wk) vs `@phnx-labs/agi-cli` (7/wk) | install base is on the old name | keep publishing the canonical package; make the README name the package it actually installs, so the two stop disagreeing |
| `agents-cli.sh` and `agi-cli.sh` | `agents-cli.sh` already 301s to `agi-cli.sh` | correct as-is; keep the redirect permanently so old links survive |
| Binary `agents` vs repo `agi-cli` | intentional | leave it. `gh`/`rg`/`fd` all differ from their repo names; this is normal and costs nothing |

The one thing to avoid is a **third** rename. Two names in the wild is a cost
already paid; a third would reset word of mouth again with no upside.

Since "AGI" does read as a hype word to the HN audience, the fix is not the repo
name but the **tagline** carrying the weight: lead with the concrete job, not the
acronym. That is the Phase 1 rewrite below.

### Phase 1, before any launch: fix the page

1. **Make the demo render.** Upload `demo.mp4` through a GitHub comment box to
   get a `user-attachments` URL, or commit a short GIF under `assets/`. Today the
   most persuasive asset on the page is a blue link.
2. **Rewrite the first sentence** into one repeatable claim. Draft: *"Run Claude,
   Codex, and Gemini in parallel across your own machines, on the subscriptions
   you already pay for."* One grievance, one answer.
3. **Add one demo per feature, ranked by what actually gets used.** A single
   hero reel cannot carry twelve capabilities, and the current one tries. Below
   the fold each major surface gets its own short GIF, in this order.

   The order is not a guess. It is invocation counts pulled from 3,703 local
   session transcripts on 2026-08-20 (`grep -rhoE '\bagents [a-z-]+'` across
   `~/.agents/.history/versions`), so the demos lead with what the tool is
   genuinely used for:

   | Rank | Surface | Invocations | What the demo must show |
   | --- | --- | --- | --- |
   | 1 | `sessions` | **82,704** | `--active` (20,586) across the fleet, then `resume` (4,869) picking a session back up on a different machine, and `inject` (1,626) steering a running agent mid-flight |
   | 2 | `run` | **63,236** | one prompt, three harnesses, on existing subscriptions |
   | 3 | `secrets` | **43,927** | `exec` (8,303) injecting a credential into a headless run with no Touch ID sheet — the thing that makes unattended work possible |
   | 4 | `teams` | **43,413** | `create` + `add` + `status`, with `--device` (1,564) putting teammates on different boxes in isolated worktrees |
   | 5 | `ssh` / `devices` | **33,123** / **30,657** | the fleet as one address space |
   | 6 | `browser` | **22,930** | see below — this one needs three beats, not one |
   | 7 | `computer` | **19,207** | `describe` (1,677) element mode driving a native app without stealing the cursor |

   **The browser demo specifically needs three beats**, because the interesting
   claim is not "an agent can browse." It is that the browser is a shared,
   addressable resource:

   - **Local** — `start` (4,764) on your own configured profile (`profiles`,
     2,518 invocations), logged into your real sessions.
   - **Remote** — `start --device <box>` driving a browser on another machine,
     with `remote-control` (210) when you need to watch or take over.
   - **Shared** — several agents on **one** browser: `--attach` (1,391),
     `sessions` (457), and `use` (276) hand the same live browser between agents
     instead of each spawning its own and re-authenticating.

   That third beat is the differentiated one and no competitor demo shows it.
   Before cutting these, mine the transcripts for the real flows rather than
   inventing them — the counts above came from the same source and the actual
   commands are there verbatim.
4. **Label 5-8 of the 18 open issues `good first issue`** and answer the rest.
   Unanswered issues read as abandonment to a first-time visitor.
5. **Add topics** to `.agents-system`, `.agents-extras`, and `homebrew-tap`, all
   at zero. (The personal mirror is already handled: private + archived as of
   2026-08-20.)

### Phase 2, permanent placement: start immediately, it has lead time

Submit to the Claude Code aggregators **before** the launch, so the launch lands
on a page that already carries inbound:

- `affaan-m/everything-claude-code` (163k stars)
- `hesreallyhim/awesome-claude-code`
- the `sst/opencode` adjacent-tool lists
- `punkpeye/awesome-mcp-servers`, if an MCP surface qualifies
- the general `awesome-ai-agents-2026` lists

This is the compounding asset. Unlike an HN post, an accepted entry does not
expire in 48 hours.

### Phase 3, the 48-hour ignition

Pre-seed past 100 stars first, since launching from 15 converts at roughly 5%.
Then fire every channel inside one window:

| Hour | Channel | Expected yield |
| --- | --- | --- |
| 0 (Sun 7pm ET / Mon 00:00 UTC) | **Show HN**, the best documented slot at 10.8% chance of 50+ | ~1.4 stars/upvote |
| 0-2 | r/ClaudeAI, r/LocalLLaMA, r/selfhosted, r/commandline | 50-300 each |
| 2 | X thread with the demo video and real numbers | referral |
| 4 | Product Hunt | 200-600 |
| 0-48 | Answer every comment personally | drives ranking longevity |

Title the Show HN with the technical fact, not the claim. "Show HN: Run Claude,
Codex, and Gemini in parallel across your own machines" beats anything carrying
"AGI", "factory", or "meta-harness". Avoid Monday and Friday; the data favors
Sunday evening ET and Tuesday through Thursday mornings.

### Phase 4, cadence from day 3 onward

Weekly release, which already happens (v1.22.41 shipped 2026-08-20), one written
piece per week, 24-hour issue response, and a follow-up Show HN on a specific
subsystem in 4-6 weeks. The 43-day mark is where the AFFiNE curve separates
projects that kept pushing from those that took the spike and stopped.

### What not to do

Do not buy stars. The geography and velocity fingerprint is exactly what
investors and serious contributors screen for, and it poisons the signal the
launch exists to earn.

## Sources

- [How to Get GitHub Stars in 2026 (AFFiNE 33k to 60k case study)](https://gingiris.github.io/growth-tools/blog/2026/03/25/how-to-get-more-github-stars-the-definitive-guide-33k-stars-case-study/)
- [Show HN by the Numbers: 188,000 Posts, 14 Years of Data](https://danfking.github.io/blog/2026/04/23/show-hn-by-the-numbers/)
- [OpenCode Hits 160K Stars](https://essamamdani.com/blog/opencode-160k-stars-open-source-ai-coding-agent-2026)
- [OpenCode Review: The Open-Source AI Coding Agent That Took #1 on Hacker News](https://agentconn.com/blog/opencode-open-source-ai-coding-agent-review-2026/)
- [Awesome Claude Code: 11 Curated Lists Worth Bookmarking](https://claudefa.st/blog/tools/resources/awesome-claude-code)
- [Hacker News Front Page in 2026: The Honest Playbook](https://www.flowjam.com/blog/how-to-get-on-the-front-page-of-hacker-news-in-2025-the-complete-up-to-date-playbook)
- [GitHub Trending Repository and Star-Velocity Alerts](https://pagecrawl.io/blog/github-trending-repository-star-velocity-alerts)
- [Hacker News Marketing for Developer Tools](https://business.daily.dev/resources/hacker-news-marketing-developer-tools-show-hn-launch-day-sustained-coverage/)
