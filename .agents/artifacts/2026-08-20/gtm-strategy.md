---
kind: report
template: report.v1
title: 'agi-cli GTM: the numbers, the graveyard, and the one bet worth making'
summary: 'The 18,542 monthly npm downloads are the fleet installing itself — r=0.965 against our own release cadence. Measured human traffic is ~145 browsers/30d (~61 confirmed-external), and the front door already content-negotiates correctly (browsers get the landing page, curl gets the installer) — the earlier "serves a bash script" finding was a testing artifact. Meanwhile the best-funded OSS product in this exact category shut down at 27,867 stars for want of a business model. Pricing is not the question yet.'
status: draft
human: author
host: fleet-worker
session: n/a
links:
  - label: 'RUSH-2834 — launch: freeze the name, run the 48-hour ignition'
    url: 'https://linear.app/phnx/issue/RUSH-2834'
  - label: 'RUSH-1937 — repo-surface conversion gap'
    url: 'https://linear.app/phnx/issue/RUSH-1937'
  - label: 'RUSH-2581 — no human-identity substrate (blocks any team tier)'
    url: 'https://linear.app/phnx/issue/RUSH-2581'
  - label: 'phnx-labs/agi-cli'
    url: 'https://github.com/phnx-labs/agi-cli'
  - label: 'Companion: developer pain, from 389 Reddit threads'
    url: 'https://github.com/phnx-labs/agi-cli/blob/main/.agents/artifacts/2026-08-20/developer-pain-reddit.md'
  - label: 'Companion: how the winners actually charge'
    url: 'https://github.com/phnx-labs/agi-cli/blob/main/.agents/artifacts/2026-08-20/how-winners-charge.md'
  - label: 'Companion: the GitHub-stars playbook (case studies)'
    url: 'https://github.com/phnx-labs/agi-cli/blob/main/.agents/artifacts/2026-08-20/github-stars-playbook.md'
  - label: 'Show HN: Bento — the 99.9th-percentile reference launch'
    url: 'https://news.ycombinator.com/item?id=49008211'
  - label: 'Show HN: TurboFieldfare — the impossible-number reference launch'
    url: 'https://news.ycombinator.com/item?id=49098510'
---

## Summary

The ask was a GTM and a monetization strategy. The research says the monetization
question is premature by one step, and that the step before it is cheap and
unambiguous. Three findings drive everything below.

**1. There are approximately no users.** `@phnx-labs/agents-cli` shows 18,542
downloads in the last 30 days. That number is the fleet installing itself. Daily
downloads correlate with our own release cadence at **r = 0.965**; days we
published averaged 1,057 downloads and days we did not averaged 179. Last week
**159 distinct versions** were downloaded, the top one being `1.20.88` from
August 2 — and `latest` (`1.22.41`) does not appear in the top 20. Humans install
`latest` once. CI pins a version and reinstalls it forever.

**2. The front door already works — the earlier "serves a shell script" finding
was a testing artifact.** `curl https://agi-cli.sh/` returns the 797-byte installer
*by design* (so `curl … | sh` keeps working), but a **browser** gets the full
landing page: the Pages Function `functions/index.ts` sniffs the User-Agent and
serves `app/page.tsx` to browsers, the script to shell clients. **Verified
2026-08-21:** a Chrome UA returns the 139 KB landing page, and `agents-cli.sh`
301-redirects to the canonical `agi-cli.sh`. The earlier revision curled the URL,
got the script, and wrongly concluded humans see it — they do not. This defect
does not exist.

**3. The category's best case is a shutdown notice.** Vibe Kanban reached
**27,867 stars** and $7.4M raised doing multi-agent orchestration, and shut down
on 2026-04-10 because it "couldn't find a business model." Roo Code (3M installs)
shut down 2026-05-15. Terragon shut down 2026-02-09. In the same window Devin
($492M ARR), Cursor ($2B ARR) and Factory ($1.5B valuation) raised nine and ten
figures. Every casualty was free and open. Every winner was hosted and paid.
*(Corrected 2026-08-21: Cursor's figure is stale — ~$4B ARR by June 2026, and
SpaceX's $60B all-stock acquisition of Anysphere closed 2026-08-14; sourcing in
the companion pricing report linked below. The asymmetry only sharpened.)*

That third fact is the one that should change the plan. The existing launch
playbook optimizes for stars. Stars are not the win condition — three teams
proved that by getting them and dying anyway. So the sequence is: **open the
front door, instrument for retention rather than installs, and pick the
monetization model the survivors used** — a hosted team layer — rather than the
one the casualties tried. *(How the survivors' pricing actually works — the unit,
the buyer, the margin layer — is now reconstructed with sources in Addendum 2 and
the companion report it links.)*

The uncomfortable corollary, stated plainly because it is a decision only you can
make: this is a 277,892-line product with no paying users, competing in a
category where the OSS lane has a demonstrated zero-revenue ceiling, while you
also carry Rush and Prix at zero revenue. Section *Recommendations* ends with
that fork rather than resolving it.

## This is the one page — the companion reports it pulls from

This document is the single source of truth for the agi-cli GTM state. Everything
below folds up from three companion reports; read this page for the decision, open a
companion only for the underlying receipts. All are committed under
`.agents/artifacts/` and linked in the header.

| Companion | What it holds | Feeds |
| --- | --- | --- |
| `developer-pain-reddit.md` | Demand-side pain mined from 389 Reddit threads | Finding 6, Addendum 2 |
| `how-winners-charge.md` | How Devin / Cursor / Cline actually price (unit, buyer, margin layer) | Recommendations Act 3, Addendum 2 |
| `github-stars-playbook.md` | Case studies of star growth (Herdr 5→404pt, OpenClaw, a 99th-pct Show HN) | Recommendations Act 2 (the launch) |

The two **Addenda** at the end of this page carry what is newest: measured PostHog
traffic (the real funnel) and the demand-side + pricing synthesis. Start at the
Summary, end at the Addenda.

## Why every neighbour died — and the specific counter for each

Five companies in this exact category shipped, got traction, and either shut down
or proved the free lane has a revenue ceiling — all within the last seven months.
Each died of a **nameable, repeatable mistake**, and the plan below is built as the
direct inverse of each one. This table is the whole thesis; the Findings and
Recommendations that follow are the evidence and the build order.

| # | Failure mode (how they died) | Who it killed | Our counter | Why the counter holds |
| --- | --- | --- | --- | --- |
| 1 | **Monetized at the prosumer altitude** — a ~$20–50/user/month seat. They *did* charge; the price point just doesn't sustain a company. | Vibe Kanban ($30/seat, 27,867★, dead), Terragon ($25/$50, dead) | Paid tier only at **enterprise altitude** — SSO/SAML, RBAC, audit trail, spend attribution, data residency — sold to a budget holder, not a developer. | The founder who died at 30k MAU said it outright: *"Everyone making money is selling to enterprise and reselling tokens. We were doing neither."* The survivors (Cursor, Devin, Factory) all sell hosted+paid; **Cline skips the middle seat entirely** (free → Enterprise custom). |
| 2 | **Apache-2.0 gave away pricing power** — forks redistributed the work as fast as it shipped. | Roo Code (3M installs, dead; forked into Kilo Code, ZooCode) | CLI stays Apache-2.0 (the distribution asset); the **paid enterprise surface is source-available**, license-key-capped so it can't be re-sold as a competing product. | Roo Code's own successor did exactly this relicensing after the forks bled it — *"you can't offer substantially similar functionality as a competing commercial product."* MongoDB/Elastic/HashiCorp/Redis all made the same move and all judged it commercially necessary. |
| 3 | **Optimized for stars, not retention** — vanity traction that didn't convert. | All three casualties (27,867 / 24,332 / 256 ★) | Launch **win-condition is retention, not stars**: *20 people outside the fleet who ran agi-cli on two separate days in one week, and whom you can contact.* | Vibe Kanban had 27,867 stars and still died. Stars are the metric that was present at every death; two-day retention is the one that would have predicted a different outcome. |
| 4 | **Thin slice of the problem** — a single-machine desktop GUI wrapping git worktrees. | Conductor, Sculptor, Crystal, Vibe Kanban | The genuine **positioning whitespace**: across 21 tools nothing else combines CLI-first + real multi-harness + **cross-device SSH fleet** + one surface (sessions/teams/secrets/browser/computer). | The differentiation is measured (Finding 3), and it's the exact axis — many machines, many harnesses, one control plane — that a single-machine GUI structurally cannot reach. |
| 5 | **(The trap we must not walk into)** charging for a *hosted/cloud* service that runs on a reused "Max subscription" — that has **no monetizable precedent** and sits against provider terms. | Would be *us* if the **cloud** tier were built on subscription-sharing | Split by the local/cloud line (see *The pricing model*): **local** multi-account use is a legitimate paid unlock — your own accounts, your own machine, tokens never sent to the cloud (OpenAI/Codex allow multiple accounts). The **cloud** tier runs on **API keys / Bedrock / Vertex**, never a subscription token. | Finding 4c: no successful *paid hosted* wrapper of a subscription seat exists; Anthropic's Consumer Terms forbid credential sharing; OpenClaw calls subscription-reuse unstable for shared automation. So: monetize local account convenience (Local Pro) and hosted execution on API keys (Cloud) — never a hosted product built on someone's personal subscription. |

**The one-line synthesis:** every casualty monetized a thin, forkable, free product
at a prosumer price and counted stars. The plan is the inverse on all four axes —
a broad, un-forkable **enterprise governance layer** over the free CLI, sold to a
budget holder, measured by retention — and it deliberately avoids the one
foundation (subscription-sharing) that has no legal or commercial precedent. The
single hard prerequisite is the identity substrate (RUSH-2581): SSO/RBAC/audit all
hang off a principal model the system does not have yet, so that is the first build.

## Findings

### 1. The traction metrics are self-inflicted, and each one fails a different way

Every number currently used as a traction signal measures our own infrastructure.

| Signal | Reported | What it actually is |
| --- | --- | --- |
| npm downloads, 30d | 18,542 | r=0.965 with our own releases; 61 versions shipped in the window |
| npm, top version last week | `1.20.88`, 470 dls | Published Aug 2 — a pinned CI version, not `latest` |
| npm, distinct versions last week | 159 | A real user base does not spread across 159 versions |
| GitHub clones, 14d | 18,015 / 1,076 "unique" | 315 "unique cloners" on a day with 23 human viewers |
| GitHub top path, 14d | `/agents-cli/pulls` — 135 views, **1 unique** | Our own automation polling the PR list |
| GitHub repo landing page, 14d | 50 views, **19 uniques** | The honest human number |
| Referrals from `agi-cli.sh`, 14d | 34 views, **5 uniques** | The website sends five people a fortnight |
| Stars since repo creation (2026-04-20, 122 days) | 15 | 0.12/day — 0.18/day counting from the first star on 2026-05-30; Trending starts near 50/day |

The clone number deserves special mention because it is the most misleading. On
2026-08-10 the repo logged 5,945 clones from 315 "unique" cloners — on a day when
23 unique humans viewed the repo. CI runners get fresh IPs, and `release.sh`
does clean clones. The metric is counting our own release pipeline.

**The load-bearing consequence is not embarrassment, it is blindness.** The CLI
ships with no telemetry by design (`README.md:1345`, `README.md:1498`). Combined
with download and clone counts that measure our own machines, there is currently
**no mechanism by which a real user could be detected**. If fifty people adopted
agi-cli tomorrow and loved it, nothing in the current stack would reveal it.
That is a monetization blocker before it is a privacy stance: you cannot
interview, price, or convert users you cannot see.

### 2. Two front-door defects, both cheap (the third, "root serves a script," was a false alarm)

The launch playbook (`.agents/artifacts/2026-08-20/launch-venues-and-posts.md`)
is well-researched and ready. Two genuine defects remain, each fixable in hours.

- **~~The root domain serves the installer.~~ Corrected 2026-08-21 — not a defect.**
  An earlier revision ran `curl -sIL https://agi-cli.sh/`, got the bash script, and
  concluded the root was broken for humans. It is not: the Pages Function
  `functions/index.ts` User-Agent-sniffs — shell clients (`curl|wget|fetch|
  powershell|httpie|libcurl`) get the installer so `curl … | sh` works, and
  **browsers get the landing page**. Verified live 2026-08-21: a Chrome UA on
  `https://agi-cli.sh/` returns the 139 KB Next landing page, and `agents-cli.sh`
  301-redirects to the canonical `agi-cli.sh`. The `release.sh` `pattern A` comment
  is loosely worded but the deployed behavior is correct. (Still worth a cleanup:
  `release.sh` still names `CUSTOM_DOMAIN="agents-cli.sh"`, and the local
  `agents-cli-web` checkout was 29 commits behind at the time — housekeeping, not a
  launch blocker.)
- **The hero demo renders as a blue link.** `README.md` points at
  `https://agi-cli.sh/demo.mp4`. GitHub only embeds video hosted on its own
  `user-attachments` domain; the rendered README contains zero `<video>`
  elements. The single most persuasive asset above the fold reads as a broken
  embed.
- **The identity is split.** The brand is `agi-cli`; the package that everyone
  actually installs is `@phnx-labs/agents-cli` (1,857/wk) while
  `@phnx-labs/agi-cli` gets 7/wk; two domains, one redirecting to the other; two
  repos, one now private. A visitor cannot tell what to type.

### 3. The positioning slot is genuine whitespace — inside a graveyard

Across 21 researched tools, nothing combines all four of: CLI-first, genuinely
multi-harness (18 harness ids, 17 of them active — `gemini` is hard-deprecated — not two), cross-device fleet dispatch over SSH, and one
surface spanning sessions, teams, secrets, browser and computer-use. The nearest
neighbours each cover one or two legs — Uzi (CLI-native, worktrees, no fleet),
Warp's Oz (multi-agent but cloud-hosted and closed), Omnara (steering layer, not
an execution engine). Most of the funded competition — Conductor, Sculptor,
Crystal, the late Vibe Kanban — is a **single-machine desktop GUI** wrapping git
worktrees around local coding-agent CLIs. (Correction, 2026-08-20: an earlier
revision said "one or two harnesses" — Vibe Kanban's launcher offered nine at
shutdown. The single-machine, launcher-slice characterization stands; the
harness count did not. See the Vibe Kanban post-mortem in this directory.)

So the differentiation is real. The problem is what happened to everyone who
occupied nearby ground. Star counts and repo state below were pulled live from
the GitHub API on 2026-08-20; funding, ARR and shutdown dates come from secondary
web sources (company blogs and trade press) and are not independently verified:

| Product | Peak traction | Model | Outcome |
| --- | --- | --- | --- |
| Vibe Kanban | 27,867 stars, 30k MAU | **$30/user/mo + Enterprise** | **Shut down 2026-04-10** (repo not archived) |
| Roo Code | 3M+ installs, 24,332 stars | Free ext + **paid Cloud/Router** | **Shut down 2026-05-15** (repo archived) |
| Terragon | 256 stars | **$25 / $50 per mo** | **Shut down 2026-02-09** |
| Devin (Cognition) | $492M ARR | Hosted, $20–200/mo | Raising at reported $40B |
| Cursor | $2B ARR | Paid, $20–200/mo | $29.3B valuation |
| Factory (Droid) | "hundreds of thousands" of devs | Hosted, paid | $150M Series C at $1.5B |

This is the central strategic fact, and the primary sources sharpen it past what a
star count shows. **All three casualties were already charging.** Vibe Kanban had a
$30/user/month Pro tier and an Enterprise tier, and issued refunds to paying
customers on the way out; Terragon sold $25 and $50/month plans; Roo Code ran paid
Cloud and Router products. They did not fail to monetize — they monetized at the
wrong altitude.

Vibe Kanban's founder said why onstage at AI Engineer Europe, shutting the company
down live at 30,000 monthly actives:

> "Everyone who is making money is doing 2 things: selling to enterprise, and
> reselling tokens. **We were doing neither.**"

Sourcing note: this quote is **not** in the shutdown blog post linked above. It is
reported second-hand from a talk at AI Engineer Europe, via a tweet. It is the
most load-bearing quote in this report and it rests on the weakest source in it —
treat it as a strong signal of the founder's own reading, not as a company
statement of record.

So the plan cannot be "get the stars, then add a team seat" — that is precisely
the plan that failed three times in seven months.

### 4. What actually converted OSS into revenue

Revenue and funding figures in this section and the two that follow come from
secondary web sources — company blogs, pricing pages and trade press — gathered
2026-08-20. They were not independently audited and should be read as directional
magnitudes, not precise accounting. Where a figure rests only on an aggregator it
is called out inline.

The pattern across every OSS devtool that made real money is a **hosted layer
that is genuinely inconvenient to self-host**: Supabase ($170M ARR), PostHog
($57.5M ARR), Temporal, n8n ($40M+ ARR), Vercel ($340M ARR), Modal ($60M→$300M
annualized in eight months). The secondary patterns are enterprise
SSO/audit/compliance (Grafana $425M ARR, Elastic $1.48B) and usage-based billing.

Two cautions from the same dataset. First, MongoDB, Elastic, HashiCorp and Redis
each **abandoned permissive licensing** because permissive-plus-goodwill did not
capture revenue — every relicensing triggered a fork and real contributor loss,
and every one was judged commercially necessary anyway. Second, the marketplace
and sponsorship patterns are weak in practice: most paid VS Code extensions earn
$300–2,100/month.

For agi-cli the honest read is that the free/paid seam is already visible in the
architecture. A developer with three machines they own is served completely by
SSH and needs nothing hosted. A **team** of twelve engineers sharing agent
sessions, secrets, spend and audit trails cannot do it over SSH into each other's
laptops. That is the layer people pay for, and it is the layer that does not
exist yet.

### 4b. Correction: a BYO orchestrator *can* meter usage — OpenRouter does

An earlier draft of this report claimed a BYO-subscription orchestrator has no
metered unit and therefore cannot use usage pricing. That is too strong, and
OpenRouter is the counterexample that breaks it.

OpenRouter charges **5.5% on credit top-ups** ($0.80 minimum) and passes inference
through at cost — *"We pass through the pricing of the underlying providers
without any markup on inference pricing."* More importantly for this argument, it
also charges in **bring-your-own-key mode**, where it never touches the money:
*"The cost of using custom provider keys on OpenRouter is 5% of what the same
model/provider would cost normally on OpenRouter."*

That is a usage-scaled fee levied on the **value of traffic routed**, not on
holding the payment. It is a real, available mechanism, and OpenRouter is at 8M
users and ~100T tokens/month on it, reportedly being acquired by Stripe for $7B+.

So the correct statement is narrower: the orchestrator gives up the *inference
margin*, not metering as such. LangChain shows the other shape — LangSmith at
$39/seat plus metered compute and storage units, sitting beside the customer's own
model bill. Portkey meters log volume; LiteLLM sells a self-hosted enterprise
licence *"never per token."*

The mechanism exists. Whether agi-cli can use it is a different question, and the
next section is why the answer may be no.

### 4c. The risk that outranks pricing: the subscription pitch may not be monetizable at all

This is the most consequential finding in the report and it was not in the
original brief.

**No commercially successful paid wrapper of a *subscription seat* was found to
exist.** Every real example either is free and open source, or resells API-key
usage instead — a different and permitted model. That is a negative result across
a deliberate search, not an absence of looking.

The plainest reason is that the provider terms forbid it. Anthropic's Consumer
Terms state: *"You may not share your
Account login information, Anthropic API key, or Account credentials with anyone
else. You also may not make your Account available to anyone else,"* and bar
accessing the Services *"through automated or non-human means, whether through a
bot, script, or otherwise"* outside the API.

**Retracted:** an earlier revision of this section asserted a specific Anthropic
enforcement action against OpenClaw on 2026-04-05, a quote attributed to Claude
Code's head of product, and a February 2026 Google restriction. A non-author
reviewer could not corroborate any of the three against OpenClaw's blog index, its
Anthropic-provider documentation, or GitHub search, and a direct fetch of
`docs.openclaw.ai/providers/anthropic` confirms that page contains **no** mention
of a cutoff, block, or restriction. Those claims are withdrawn as unverified. They
should not be repeated.

What survives is stronger for resting entirely on primary sources — but the two
surviving sources carry **different kinds of risk, and they should not be blended.**

**Compliance risk** comes from the Consumer Terms quoted above. That is a question
about what is permitted, and it is the one that needs a lawyer rather than an
engineer.

**Operational risk** comes from OpenClaw — a harness agi-cli supports (`AgentId`
includes `openclaw`) — which documents it in its own words: *"Anthropic can change
Claude Code billing and rate-limit behavior without an OpenClaw release."* For
**"shared production automation"** and **"predictable production spend,"** its docs
tell users to prefer API keys over reusing subscription credentials. Note the
stated reason is cost and rate-limit predictability, **not** compliance — so this
is the vendor of the subscription-reuse feature saying the feature is an unreliable
foundation for shared automation, which is a different and weaker claim than saying
it is disallowed.

Both point the same direction for a paid product, for independent reasons: one
says the ground may not be permitted, the other says it is not stable. Neither on
its own is fatal; together they make it the least attractive foundation available
when an alternative (API keys, Bedrock, Vertex) carries neither problem.

Why this lands squarely on agi-cli: the subscription pitch is the product's
headline (`README.md:1494`), and **balanced account rotation is a documented
feature built for exactly this purpose** — `README.md:193` describes
`--strategy balanced` as *"useful when you have multiple accounts and want to
avoid burning through one."*

Two consequences, and they point the same way:

1. **The free tool is not the exposure; the paid product would be.** Running your
   own subscriptions on your own machines is your business. *Charging money* for
   software whose value proposition is spreading subscription seats across
   parallel automation is what has no precedent and sits against explicit terms.
2. **It reinforces the enterprise conclusion.** Enterprises do not run personal
   Max seats — they use API keys, Bedrock, or Vertex, where metering and
   automation are permitted and where OpenRouter's 5%-of-routed-value mechanism
   is actually available. The buyer who can pay is also the buyer whose usage is
   contractually clean.

This deserves a real legal read before any paid tier is built on the rotation
story, and it should be treated as a gating question rather than a footnote.

### 5. Pricing has already converged, so the number is not the hard part

Solo tiers cluster at **$20/month** (Cursor Pro, Claude Pro, Devin Pro, Amp,
Windsurf) and power tiers at exactly **$200/month** across at least six vendors.
Team seats run $19–125: Copilot Business $19, Claude Team $25–125, Cursor Teams
$40–120, Warp Business $50. Enterprise engineering budgets are $500–3,000 per
developer per year, and Anthropic's own disclosed Claude Code usage runs
$150–250/dev/month.

A team control plane at **$20–40/seat/month** sits inside every one of those
bands and is small relative to the model spend it governs. The pricing question
is answered by the market; the open question is whether anyone wants the product.

### 6. Demand for the category is real, even though demand for *this* is unmeasured

JetBrains' 2026 developer survey (N=15,000+) reports **90% weekly and 68% daily**
use of AI coding agents, with tool shares summing well past 100% — Claude Code
39%, Copilot 21%, Codex 16%, Cursor 12% — implying most developers already run
two or more harnesses. Jellyfish (N=700+ companies, 200,000+ engineers) puts
median enterprise adoption at 71%. Multi-harness is the normal state, which is
exactly the premise agi-cli is built on.

What does not exist is any rigorous measure of *parallel-agent fleet* usage. A
widely-repeated "70% of engineers use 2–4 tools" figure traces to an
uncredentialed blog and should not be cited. The premise is sound; the segment
size is unknown.

## Evidence

### The funnel that isn't

<figure>
<svg viewBox="0 0 780 330" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Funnel showing 18,542 npm downloads narrowing to 19 human visitors and zero revenue">
  <text x="16" y="20" font-family="system-ui, sans-serif" font-size="12" font-weight="700" fill="#8a8a8a">FROM HEADLINE METRIC TO HUMAN BEINGS</text>
  <text x="16" y="38" font-family="system-ui, sans-serif" font-size="11" fill="#8a8a8a">npm 30d · GitHub traffic 14d · stars since repo creation</text>

  <g font-family="system-ui, sans-serif">
    <rect x="16" y="54" width="700" height="30" rx="4" fill="#3f6212"/>
    <text x="28" y="74" font-size="13" font-weight="700" fill="#f4f4f4">18,542 npm downloads / 30d</text>
    <text x="600" y="74" font-size="11" fill="#d9f99d">machine</text>

    <rect x="16" y="92" width="430" height="30" rx="4" fill="#4d7c0f"/>
    <text x="28" y="112" font-size="13" font-weight="700" fill="#f4f4f4">18,015 git clones / 14d</text>
    <text x="330" y="112" font-size="11" fill="#d9f99d">machine</text>

    <rect x="16" y="130" width="250" height="30" rx="4" fill="#65a30d"/>
    <text x="28" y="150" font-size="13" font-weight="700" fill="#f4f4f4">1,076 "unique" cloners</text>
    <text x="180" y="150" font-size="11" fill="#1a2e05">machine</text>

    <rect x="16" y="168" width="150" height="30" rx="4" fill="#84cc16"/>
    <text x="28" y="188" font-size="13" font-weight="700" fill="#1a2e05">126 repo viewers</text>

    <rect x="16" y="206" width="74" height="30" rx="4" fill="#a3e635"/>
    <text x="28" y="226" font-size="13" font-weight="700" fill="#1a2e05">19 humans</text>
    <text x="100" y="226" font-size="11" fill="#8a8a8a">on the repo landing page, 14 days</text>

    <rect x="16" y="244" width="34" height="30" rx="4" fill="#bef264"/>
    <text x="24" y="264" font-size="13" font-weight="700" fill="#1a2e05">5</text>
    <text x="60" y="264" font-size="11" fill="#8a8a8a">referred by agi-cli.sh in 14 days</text>

    <rect x="16" y="282" width="20" height="30" rx="4" fill="#dc2626"/>
    <text x="46" y="302" font-size="12" font-weight="700" fill="#dc2626">$0 revenue</text>
    <text x="140" y="302" font-size="11" fill="#8a8a8a">15 stars in 122 days · no telemetry, so no user is detectable</text>
  </g>
</svg>
<figcaption>Each step down is a different measurement artifact being stripped away. The bottom two rows are the only ones describing people.</figcaption>
</figure>

### Downloads track our release cadence, not adoption

<figure>
<svg viewBox="0 0 780 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Daily npm downloads plotted against versions published per day, showing near-perfect correlation">
  <text x="16" y="18" font-family="system-ui, sans-serif" font-size="12" font-weight="700" fill="#8a8a8a">DAILY DOWNLOADS vs VERSIONS PUBLISHED — 2026-07-21 to 2026-08-19</text>
  <text x="16" y="34" font-family="system-ui, sans-serif" font-size="11" fill="#8a8a8a">Pearson r = 0.965 · release days avg 1,057 dls · quiet days avg 179</text>

  <line x1="50" y1="250" x2="756" y2="250" stroke="#3a3a3a" stroke-width="1"/>
  <line x1="50" y1="60" x2="50" y2="250" stroke="#3a3a3a" stroke-width="1"/>
  <text x="14" y="64" font-family="system-ui, sans-serif" font-size="10" fill="#8a8a8a">4000</text>
  <text x="22" y="252" font-family="system-ui, sans-serif" font-size="10" fill="#8a8a8a">0</text>

  <!-- downloads bars: 30 days, scaled /4000 over 190px -->
  <g fill="#4d7c0f">
    <rect x="54" y="237" width="14" height="13"/><rect x="77" y="243" width="14" height="7"/>
    <rect x="100" y="247" width="14" height="3"/><rect x="123" y="242" width="14" height="8"/>
    <rect x="146" y="243" width="14" height="7"/><rect x="169" y="247" width="14" height="3"/>
    <rect x="192" y="248" width="14" height="2"/><rect x="215" y="248" width="14" height="2"/>
    <rect x="238" y="234" width="14" height="16"/><rect x="261" y="246" width="14" height="4"/>
    <rect x="284" y="239" width="14" height="11"/><rect x="307" y="225" width="14" height="25"/>
    <rect x="330" y="191" width="14" height="59"/><rect x="353" y="175" width="14" height="75"/>
    <rect x="376" y="168" width="14" height="82"/><rect x="399" y="64" width="14" height="186"/>
    <rect x="422" y="173" width="14" height="77"/><rect x="445" y="190" width="14" height="60"/>
    <rect x="468" y="180" width="14" height="70"/><rect x="491" y="236" width="14" height="14"/>
    <rect x="514" y="210" width="14" height="40"/><rect x="537" y="231" width="14" height="19"/>
    <rect x="560" y="243" width="14" height="7"/><rect x="583" y="232" width="14" height="18"/>
    <rect x="606" y="250" width="14" height="0"/><rect x="629" y="228" width="14" height="22"/>
    <rect x="652" y="246" width="14" height="4"/><rect x="675" y="230" width="14" height="20"/>
    <rect x="698" y="238" width="14" height="12"/><rect x="721" y="239" width="14" height="11"/>
  </g>

  <!-- releases per day markers -->
  <g fill="#a3e635">
    <circle cx="61" cy="268" r="3"/><circle cx="245" cy="268" r="3"/><circle cx="291" cy="268" r="3"/>
    <circle cx="314" cy="266" r="5"/><circle cx="337" cy="263" r="7"/><circle cx="360" cy="264" r="6"/>
    <circle cx="383" cy="263" r="7"/><circle cx="406" cy="258" r="12"/><circle cx="429" cy="265" r="5"/>
    <circle cx="452" cy="266" r="4"/><circle cx="475" cy="266" r="4"/><circle cx="521" cy="268" r="3"/>
    <circle cx="590" cy="268" r="3"/><circle cx="613" cy="268" r="3"/><circle cx="682" cy="268" r="3"/>
  </g>
  <text x="54" y="292" font-family="system-ui, sans-serif" font-size="10" fill="#a3e635">● versions published that day (radius scales with count; largest = 18 on Aug 5)</text>
  <text x="54" y="279" font-family="system-ui, sans-serif" font-size="10" fill="#4d7c0f">▮ downloads</text>
</svg>
<figcaption>The Aug-5 spike is 18 versions published and 3,910 downloads on the same day. Adoption curves do not have this shape; CI pipelines do.</figcaption>
</figure>

### Reproducing these numbers

```bash
# Downloads vs. our own release cadence (r = 0.965)
curl -s "https://api.npmjs.org/downloads/range/last-month/@phnx-labs/agents-cli"
curl -s "https://registry.npmjs.org/@phnx-labs/agents-cli" | jq '.time'

# `latest` is absent from the top 20 downloaded versions
curl -s "https://api.npmjs.org/versions/@phnx-labs%2Fagents-cli/last-week"

# Human vs. machine traffic on the public repo
gh api repos/phnx-labs/agi-cli/traffic/views  --jq '{count,uniques}'   # 779 / 126
gh api repos/phnx-labs/agi-cli/traffic/clones --jq '{count,uniques}'   # 18015 / 1076
gh api repos/phnx-labs/agi-cli/traffic/popular/paths                   # /pulls: 135 views, 1 unique

# The front door
curl -sIL https://agi-cli.sh/ | grep -iE '^HTTP|^content-type'         # 200, serves install.sh
```

### What could not be verified

Cloudflare zone analytics and PostHog were both unreachable from this session.
The `cloudflare.com` API token authenticates but lacks
`com.cloudflare.api.account.zone.analytics.read` on either zone, and returns 403
on the account RUM endpoint. The `cloudflare` and `posthog.com` secret bundles on
the workstation that holds them are Touch-ID-locked, and no CDP port was
listening there, so the browser could not attach to an authenticated dashboard
without relaunching a live browser session.

PostHog is genuinely wired into the site (`app/layout.tsx:107-120`, nine
references in the deployed `/docs` HTML) and is the one source that would measure
humans rather than machines, because bots and `curl` never execute its JavaScript.
**It is the single highest-value unknown in this report.** Unlocking it is one
command — see *Recommendations*.

**Update (2026-08-21): the command was run, and this unknown is now closed.** The
`posthog.com` bundle was unlocked and PostHog project `299876` queried directly.
The measured numbers — 145 distinct browser visitors in 30 days, of which ~61 are
confirmed-external humans (search/social referred, 15+ countries), against the
~19/fortnight this report estimated — are in the [Addendum](#addendum-the-command-was-run-measured-human-traffic-2026-08-21)
at the end. Cloudflare's edge volume is now read too (from the authenticated
dashboard): ~38,946 requests/month vs ~103 humans — machines ≫ people, ~380:1.

## Recommendations

### Act 1 — Make users detectable, and finish the front-door housekeeping (this week)

None of this is growth work. It is the precondition for knowing whether any
growth work succeeded.

| # | Action | Why it blocks everything else |
| --- | --- | --- |
| 1 | ~~Serve the landing page at `agi-cli.sh/`~~ **Already done** (verified 2026-08-21): `functions/index.ts` serves browsers the landing page, `curl` the installer; `agents-cli.sh` 301s to `agi-cli.sh`. Only housekeeping left (update `release.sh` `CUSTOM_DOMAIN`, catch up the web checkout). | — no longer a blocker |
| 2 | Ship opt-out anonymous telemetry: install, first run, weekly-active, top commands | Today no real user is detectable by any mechanism |
| 3 | Collapse the identity: one package name, one domain, one public repo | A visitor cannot tell what to type |
| 4 | Re-upload the hero demo to GitHub `user-attachments` so it renders | The best asset above the fold reads as broken |
| 5 | Point `release.sh` at `agi-cli.sh` and catch the web checkout up (29 behind) | The deploy script contradicts the deployed state |

Item 2 is a real decision, not a task. `README.md:1498` promises "No CLI
telemetry or phone-home," twice. Keeping that promise means permanently choosing
to run this business blind. The defensible version is opt-out, anonymous, no
prompt contents, documented in the README — the same shape PostHog and Vercel
ship. My recommendation is to take the trade and say so loudly.

### Act 2 — Run the planned launch, but change the win condition (2–3 weeks)

The launch playbook is good and should run mostly as written: awesome-list
submissions first (permanent referral traffic, and agi-cli appears in none of the
200,000+ combined-star Claude Code lists), then the 48-hour ignition with the
Show HN title already chosen.

Change one thing: **the success metric is not stars.** Vibe Kanban had 27,867 and
died. The metric that would have predicted a different outcome is retention. Set
the bar as:

> **20 people outside the fleet who ran agi-cli on two separate days in the same week, and whom you can contact.**

If the launch produces 2,000 stars and not those 20 people, it succeeded at the
thing that killed three competitors. If it produces 300 stars and those 20
people, it worked.

### Act 3 — Monetize the team layer, not the CLI

The evidence points one direction. The free/paid seam that matches both the
architecture and every OSS success in the dataset:

- **Free, forever, Apache-2.0:** the CLI on machines you personally own. Every
  harness, sessions, teams, worktrees, secrets, browser, computer, SSH fleet.
  This is the distribution asset and it should stay unambiguously free — it is
  also already licensed that way and cannot be recalled.
- **Paid — and priced at the enterprise altitude, not a prosumer seat.** This is a
  correction to an earlier draft of this report, forced by the primary sources: a
  ~$20–40/seat team tier is *the exact price point that just failed*. Vibe Kanban's
  $30/user/month is the closest comparable in the dataset and it did not sustain a
  company; Nimbalyst's $20/user/month is still "free during beta" and has proven
  nothing. The survivors skip that rung entirely — Cline goes free → Enterprise
  custom with **no** middle tier, on the stated doctrine that *"inference cannot be
  the business model,"* and sells inference at cost.

  So the paid surface is the one an enterprise buyer requires and cannot fork
  around: SSO/SAML, RBAC, audit trail of what agents did, centralized spend
  attribution, admin control, data residency. Custom-priced, sales-led, sold to a
  budget holder — not self-serve seats sold to developers who will otherwise fork
  it.

- **Licence the paid surface source-available, not Apache-2.0.** Roo Code's
  post-mortem names the mechanism that removed its pricing power: *"forks
  redistributed our work as fast as we shipped it"* — it had forked Cline, and was
  then forked by Kilo Code and ZooCode. Its successor abandoned Apache-2.0 for a
  Fair Core licence with a license-key-enforced user cap, explicitly so that *"you
  can't offer Roomote or substantially similar functionality as a competing
  commercial product."* The existing CLI stays Apache-2.0 and cannot be recalled;
  new enterprise code should not repeat the experiment.

Note that `RUSH-2581` already records the blocker: *"No human-identity substrate:
SSO/SAML cannot attach because there is no principal model."* Everything in a team
tier hangs off that one piece of work.

It sits in Backlog by an explicit decision, and that decision should be read
before acting on this recommendation. The ticket's own comment states: *"Decision:
not a current product goal ... the system is single-operator today. Building an
SSO/OIDC identity substrate for one operator is speculative infrastructure."*
That reasoning was correct on its own terms. It also names the exact condition
that reverses it: *"if a second operator ever needs access, this is the ticket to
reopen, and its analysis stands."*

A paid team tier **is** that second operator. So this recommendation does not
overturn the earlier call — it argues the trigger condition has become a product
decision rather than an accident. But the sequencing matters: RUSH-2581 stays
speculative infrastructure until Act 2 produces evidence that multi-seat demand
exists. Build it after the retention bar is met, not before.

The ICP that follows is narrower than "teams of 5–50" and has a different buyer.
It is an **engineering organization whose developers already spend $150–250 each
per month across more than one harness, where someone above them is accountable
for that spend and for what the agents touched.** The buyer is that accountable
person, not the developer — developers are the ones who fork rather than pay. What
is being sold is governance over spend already committed, which is budget
displacement rather than a new line item.

A second path exists and should be named rather than dismissed: **reselling
tokens** is the other mechanism Knight-Webb identified, and it is how OpenRouter
monetizes routing. agi-cli has the surface for it half-built already
(`agents route`, RUSH-2555). But it collides head-on with the product's own value
proposition — `README.md:1494` sells "use your existing subscription" precisely
because subscription pricing beats API pricing for heavy users. Taking a token
margin means asking users to pay more than they do today. That is a real strategic
fork, not an obvious win, and it deserves its own decision rather than a default.

### The pricing model — the tier is set by who bears the recurring cost

The governing rule, decided 2026-08-21: **price each feature by who pays the
recurring cost of running it.** Purely-local convenience that costs us nothing
recurring is a cheap one-time unlock; anything we host and pay for every month is a
subscription; the enterprise governance surface is a subscription plus metering.
One hard architectural line makes the whole model clean and keeps it clear of the
Finding 4c trap:

> **Local account tokens never leave the machine, and the cloud never runs on your
> subscription token.** Local use is your own accounts on your own hardware; cloud
> use is API keys / Bedrock / Vertex (ours or yours). The two never cross.

That line is what turns the "row 5 trap" into a non-issue: we are not reselling
subscription access. Locally, you use accounts you legitimately bought; in the
cloud, nobody's Max token is involved at all.

| Tier | For | Included | Price shape | Why this shape |
| --- | --- | --- | --- | --- |
| **Free** (Apache-2.0) | solo dev, own machines | full CLI — sessions, teams, worktrees, secrets, browser, computer, SSH fleet — up to **3 local provider accounts** | **$0** | zero recurring cost to us; this is the distribution asset and cannot be recalled |
| **Local Pro** | power users running many local accounts | **unlimited local accounts** + balanced rotation, local power features | **one-time / low unlock (~$19.99–$99)** | it is *your* accounts on *your* machine — OpenAI/Codex explicitly allow multiple accounts on different emails, and many providers do; tokens never touch the cloud, so no ToS/compliance exposure. We incur no recurring cost, so it is a capability unlock, **not** a recurring seat (this is deliberately not the ~$30 prosumer SaaS seat that killed Vibe Kanban — there is no hosted value being rented) |
| **Cloud** | anyone wanting hosted execution | run agents in the cloud, hosted session sync + state, cloud dispatch, managed compute | **recurring subscription (+ usage)** | **we** pay infra every month, so it must recur to cover cost + margin; it runs on API keys / Bedrock / Vertex or our own compute — never a personal subscription token — which is what keeps it both permitted and operationally stable (Finding 4c) |
| **Enterprise** | orgs / budget holders | SSO/SAML, RBAC, audit trail of agent actions, centralized spend attribution + metering, data residency, admin controls | **subscription + metering, sales-led, custom** | the altitude the survivors monetize at (Cursor/Devin/Factory hosted+paid; Cline free→Enterprise); source-available + license-key-capped so it cannot be forked (Roo Code's lesson) |

**The decision rule in one line:** *does running this feature cost us money every
month?* No, and it is local → **one-time unlock**. Yes → **subscription**. Sold to
an org that needs governance over committed spend → **subscription + metering**. The
free CLI stays the top of funnel; Local Pro converts individual power users at near-
zero marginal cost to us; Cloud and Enterprise are where recurring revenue and the
enterprise altitude live.

This does not overturn Act 3's core conclusion — the enterprise team tier is still
the load-bearing revenue bet and still hangs off the identity substrate (RUSH-2581).
It adds the two tiers beneath it (Free, Local Pro) and the one above the seat
(Cloud), and gives each a principled price shape instead of a single guess.

### The fork that is yours, not mine

Everything above assumes agi-cli should become a business. There is a coherent
alternative, and a prior session on 2026-08-08 already argued for it: *"dev
tooling is a bloodbath... that is not your revenue lane — it's free OSS you use
to build Rush."*

That reading is defensible and the shutdown table supports it. But it has not
been working either, because agi-cli is not currently distributing anything: five
referred visitors a fortnight is not a top of funnel. So the real choice is
between two honest positions, and they imply very different calendars:

1. **agi-cli is the business.** It gets Act 1, Act 2, and the identity/team-tier
   work above, and it gets most of your attention for the next quarter.
2. **agi-cli is distribution and credibility for something else.** Then Act 1
   still happens — detectability and a polished front door help nothing if skipped
   — but Act 3 does not, the
   team tier is never built, and agi-cli gets a fixed small share of attention
   while the revenue work happens in Rush or the code-review product.

What is not viable is the current state: full engineering investment on the
assumption it is the business, with the GTM of something that is meant to be
incidental.

### The one command that would sharpen all of this

PostHog is the only instrument already installed that counts humans. Unlock it
and this report's largest unknown closes:

```bash
agents secrets unlock posthog.com
```

Run that on the workstation holding the bundle, and the actual human traffic to
`agi-cli.sh` — sessions, sources, bounce, whether anyone reaches the install
snippet — becomes readable in minutes.

## Addendum — the command was run: measured human traffic (2026-08-21)

`agents secrets unlock posthog.com` was run on 2026-08-21, and PostHog project
`299876` (US) was queried directly with HogQL. This closes the report's single
largest unknown. Window: 30 days, **2026-07-22 → 2026-08-21**. PostHog's
JavaScript executes only in a real browser, so `curl`, CI runners, and non-JS
bots are absent by construction. What it counts is a **distinct browser that
loaded the page and ran the JS** — which excludes machines but does *not* by
itself exclude the operator's own visits or a fleet agent driving a headless
browser. So the raw count and the *confirmed-external* count are reported
separately below, and the segmentation that separates them follows in the next
section.

### The traffic is ~3x this report's estimate — and still a trickle

| Metric | This report estimated | Measured |
| --- | --- | --- |
| Distinct browser visitors / 30d | (unmeasured) | **145** |
| Distinct browser visitors / 14d | ~19 | **95** |
| **Confirmed-external humans / 30d** (search/social referred) | — | **61** |
| Pageviews / 30 days | (unmeasured) | 240 |

The *"there are approximately no users"* finding softens but does not reverse.
The honest floor is **61 confirmed-external humans in 30 days** — visitors a
search engine or social platform referred, which is neither the operator typing
the URL nor a fleet agent. That is ~3x the report's ~19/fortnight estimate and,
crucially, *real strangers* (see next section), but it is still a trickle, and
the npm r=0.965 release-cadence correlation is untouched — that number is still
the fleet installing itself.

### Who these 145 browsers actually are — internal vs external

The raw 145 is not 145 strangers. Segmenting it:

- **Confirmed external — 61 unique visitors** arrived from a search or social
  referrer: Google 40, ChatGPT 8, LinkedIn 6, and the remaining 7 spread one or
  two apiece across Bing, DuckDuckGo, Yahoo, Yandex, `t.co` (Twitter/X), and
  GitHub (40 + 8 + 6 + 7 = 61, after de-duplicating people who arrived by more
  than one path). A referrer of `google.com` or `chatgpt.com` means a person
  searched and clicked; the fleet does not do that and the operator does not
  need to.
- **Genuinely global — 15+ countries.** US 70, then Japan 6, China 6, India 6,
  Taiwan 6, UK 5, Bangladesh 3, Pakistan 3, Singapore 3, Vietnam 3, Israel 3,
  Netherlands 3, Hong Kong 3, Canada 2. Every fleet box is US-based, so this
  international tail cannot be self-traffic.
- **27 on mobile** (18 iOS Safari + 9 Android Chrome). The fleet has no mobile
  browsers and `agents browser` is desktop-headless, so these are unambiguously
  real people on phones.
- **Internal contamination is small and identifiable:** exactly **one**
  identified person in the whole set (the operator's own account), just **2**
  Brave/macOS visitors (the browser `agents browser` uses), and some
  Mountain-View / Council-Bluffs hits that are Google prefetch/datacenter rather
  than a person.

So the defensible statement is: **~61 confirmed-external humans/month, spread
across 15+ countries and including real mobile traffic**, inside a raw
browser-visitor count of 145 that also contains the operator, ~2 fleet sessions,
and some Google prefetch noise. Quote the 61, not the 145.

### Where the humans land

| Host | Unique visitors (30d) | Pageviews |
| --- | --- | --- |
| `agi-cli.sh` | **103** | 175 |
| `getrush.ai` | 38 | 61 |
| `*.pages.dev` (preview) | ~4 | 4 |

`agi-cli.sh` draws **103 real humans in 30 days**, and — corrected 2026-08-21 —
those humans **do** get the real landing page: the root Pages Function serves
`app/page.tsx` to browsers and the installer only to `curl`/shell clients (verified
with a Chrome UA). So the 103 are landing on the working page, not a broken one; the
earlier "root serves a script to humans" reading was a `curl`-testing artifact. The
opportunity is converting those 103 better, not un-breaking a door that already works.

### The conversion leak, now measured

| Step (30d, unique visitors) | Count |
| --- | --- |
| `/` homepage | 96 |
| `/download` | 10 |
| `/install` | **1** |
| `signup_submitted` (event) | 3 |

96 homepage humans yield **1** who reaches `/install`; across all 145 visitors, **3**
signed up (`signup_submitted`), a ~2% visitor → signup rate. This is the direct measurement behind RUSH-1937
(repo-surface conversion gap): the leak is real and it is at the top, not the
bottom, of the funnel.

### Retention — the metric that killed the competitors

127 new versus **19 returning** visitors in 30 days — a **13% return rate**. This
confirms the Act 2 thesis that retention, not stars, is the win condition. But the
CLI-run retention bar this report set (*"20 people who ran agi-cli on two separate
days"*) **cannot be scored today**: only **2** distinct users emit an
`app_launched` event, because the CLI has no telemetry. Act 1, item 2 (ship opt-out
telemetry) is thus not a nice-to-have — it is the precondition for measuring the
one metric Act 2 is judged on.

### Discovery channels the report did not know existed

Top referring domains (30d, unique visitors): `(direct)` 78, `google.com` 40,
**`getrush.ai` 11**, **`chatgpt.com` 8**, **`linkedin.com` 6**, `bing.com` 2,
`duckduckgo.com` 1, `github.com` 1. Two live, unpaid surfaces the report never
saw: **ChatGPT** (people asking an LLM and clicking through) and **LinkedIn**. The
`getrush.ai` cross-referral shows the sister product already feeds this funnel.
Autocapture also shows a non-trivial share of clicks in Chinese (`下载 Windows CLI`),
i.e. real international traffic.

### Cloudflare — read from the authenticated dashboard (2026-08-21)

The `cloudflare.com` API token still 403s on `zone.analytics.read`, but the number
was reachable another way: the logged-in Cloudflare dashboard for the `agi-cli.sh`
zone, read directly. It closes the machine-vs-human side of the funnel.

- **~38,946 requests served at the edge in the last ~month** (dashboard "Share
  Your Stats"), with **4,297 attacks blocked** in the same window.
- Against PostHog's **~103 human browser visits** to `agi-cli.sh` in 30 days, that
  is a **~380 : 1 ratio of edge requests to humans-who-ran-JS.** Even after
  discounting the blocked-attack noise, the overwhelming majority of `agi-cli.sh`
  traffic is non-browser — bots, CI, and `curl | bash` installer fetches — which is
  the server-side confirmation of Finding 1: the download volume is machines, not
  people.
- Geography of that edge traffic (last 24h) skews the same way the human data does:
  US 835, Spain 162, Argentina 74, France 54, China 52.

**One number still genuinely unavailable:** the exact split of the installer path
(`curl | bash`) versus page loads. The free plan's dashboard exposes no per-path
server breakdown, Cloudflare Web Analytics is a JS beacon (browser-only, so it
would miss `curl` the same way PostHog does), and the per-path GraphQL query needs
the `zone.analytics.read` scope the token lacks. Getting that one figure is still
the "add **Zone → Analytics → Read** to the token" action — but it is now a
refinement, not the missing headline: the headline (machines ≫ humans, ~380:1) is
measured.

*Pulled 2026-08-21 via HogQL against PostHog project 299876; every query is
reproducible with `agents secrets exec posthog.com -- <curl to /api/projects/@current/query/>`.*

## Addendum 2 — demand-side receipts and the winners' pricing mechanics (2026-08-21)

Two follow-up questions were asked after this report was first read, and both
answers are now merged as companion artifacts in this directory. This addendum
carries what changes for the plan; the receipts live in the companions.

### What developers actually complain about ([developer-pain-reddit.md](developer-pain-reddit.md))

A live harvest of the coding-agent subreddits (389 unique posts, 18 threads
comment-harvested through the operator's own logged-in browser, June–August 2026
weighted as current state) confirms the demand this report could only infer:

- **The #1 pain by engagement is usage-limit volatility**, not just scarcity —
  the rules changing weekly is its own complaint, and the community reads
  Anthropic's goodwill extensions as churn signals.
- **Multi-account stacking is the crude coping form** — real and current (six
  open-source account-switchers exist for it), but gray-zone and ban-feared.
- **Power users already run provider portfolios** — Claude + Codex + a cheap
  executor, split by role, with cross-model review — and hand-build cheap-model
  offload to protect their subscriptions. The unsolved seams they name are
  context-across-switches, fleet visibility, and remote control: this product's
  surfaces, described by people who do not know it exists.
- Consequence for Act 2: the launch copy should be written in these threads'
  own words — the pain table in the companion maps each quoted complaint to the
  agi-cli surface that answers it.

### How the winners actually charge ([how-winners-charge.md](how-winners-charge.md))

The §Summary line "every winner was hosted and paid" now has its mechanics,
sourced and dated:

- **The unit is metered agent consumption, not seats** — Devin's ACUs, Cursor's
  credit pool at API rates, Copilot's AI Credits (June 2026). The whole category
  converged on consumption metering within twelve months. The casualties charged
  seats for collaboration on top of a free complete product.
- **The buyer that makes the math work is the enterprise** — Cursor's reported
  split: enterprise accounts margin-positive, individuals loss-making; Cognition
  bought Windsurf for its enterprise book and 6.7x'd revenue in eleven months.
- **Margin comes from owning the layer underneath** — Cursor only reached gross-
  margin profitability (April 2026) after its own Composer model absorbed enough
  routing; first parties are playing the same game from the other side.
- Consequence for Act 3: "monetize the team layer" gets a mechanical spec —
  free local core, **metered hosted consumption** (cloud sessions, gateway,
  control plane) sold org-level, with the meter visible before the bill
  (Cursor's July 2025 apology is the cautionary tale). Feature-gating the local
  tool is the casualty pattern; metering hosted compute is the survivor pattern.

## Addendum 3 — who, what job, why the extreme Show HN posts win, and why pricing killed the casualties (2026-08-21)

The prior draft answered the eventual enterprise buyer but blurred that buyer
with the person the launch must reach. It also listed the features of high-scoring
Show HN titles without showing the full launch anatomy, and compressed the pricing
failures into a quadrant. This addendum answers those three gaps directly.

### Who the launch targets — one user now, one buyer later

The launch does **not** target every developer, generic "AI teams," or an
enterprise procurement lead. It targets a narrower beachhead:

> **A coding-agent power user who already runs at least two harnesses, has work
> stranded across terminals or machines, and personally maintains scripts,
> account switchers, handoff files, or dashboards to keep the work moving.**

The Reddit corpus gives this person observable qualifying behavior rather than a
persona invented from demographics. They split planning, implementation, and
review across Claude, Codex, Gemini, or cheap executors; hit limits they cannot
predict; lose context when they switch; and want to see or steer work away from
the laptop. They are already paying the workflow tax. agi-cli replaces the glue
they wrote themselves.

| Stage | Person | Trigger | Promise | Proof they should see |
| --- | --- | --- | --- | --- |
| Launch user | Individual power user / technical founder | Two or more agent CLIs, several concurrent sessions, or work spread across machines | One command plane; context survives harness, account, and device changes | A real mixed-harness job completed with one durable session record |
| Internal champion | Staff engineer, platform engineer, or AI enablement lead | The hand-built workflow spreads to several developers | Standardize the workflow without forcing one model vendor | Shared profiles, reproducible teams, fleet visibility, searchable history |
| Eventual buyer | Engineering leader accountable for AI spend and agent access | The organization needs governance over an adopted workflow | Govern spend and actions already happening | SSO/RBAC, audit history, attribution, policy, managed execution |

This sequence matters. Marketing enterprise governance before individual power
users adopt the workflow asks a buyer to govern an empty system. Marketing only
"save money with multiple accounts" attracts a gray-zone workaround seeker and
makes the product interchangeable with six account switchers. The wedge is
**continuity across a provider portfolio**; rotation is one supporting mechanism.

### A concrete research job — the Reddit pain study as a repeatable demo

"Research" should not mean opening several chat tabs and asking each model for an
opinion. The job needs a bounded question, source acquisition, independent roles,
a reconciliation seam, and a checkable artifact. The research already completed
for this report is the right demo subject because it is real, visual, and
impossible to fake with one polished answer:

> **Question:** What problems are coding-agent power users reporting now, and
> which of those problems does agi-cli actually solve?

The demo run:

1. **Collector:** use the logged-in browser on the machine that can reach Reddit;
   sweep 16 query/subreddit combinations and save structured results.
2. **Qualitative reader:** open the highest-signal threads and extract the top
   comment trees, preserving date, score, permalink, and exact wording.
3. **Recency auditor:** reject stale evidence as current state and split durable
   pains from one-week incidents. This is the step that corrected the original
   six-month-old suspension example.
4. **Product mapper:** map each repeated pain to a shipped agi-cli surface, and
   mark complaints the product does not solve instead of stretching the claim.
5. **Adversarial reviewer:** challenge the synthesis for selection bias, missing
   citations, unsupported causality, and launch copy that overclaims.
6. **Composer:** reconcile the tracks into one rendered report with a thread
   index and a decision table.

The observable output is not "five agents said research is complete." It is the
existing companion report: **389 unique posts, approximately 800 comments from
18 deeply read threads, every cited thread indexed, stale evidence demoted, and
eight pain-to-product mappings.** That makes a good demo because the seams are
visible: a remote browser acquires evidence, different harnesses can analyze it,
the session corpus preserves the chain, and one artifact carries the result.

The launch video should show this as a compressed before/after, not a feature
tour: one research brief enters; collectors visibly fan out; one worker is routed
to the browser-capable machine; findings return; the reviewer rejects one stale
claim; the final HTML report opens. The claim is concrete: **"One brief, multiple
models and machines, one cited report — with the stale claim caught before it
shipped."**

### What the 99.9th-percentile Show HN launch actually looks like

In the measured set of **1,581 Show HN posts since 2025-01-01**, the 99.9th
percentile is roughly the top **two** posts, not a useful description of the
median. The median remains 2 points. The extreme tail is useful because it shows
the complete package required for an outlier; it is not a forecast that copying
the title produces the score.

| Layer | Bento — 1,033 points in the frozen dataset | TurboFieldfare — 919 points in the frozen dataset | What agi-cli must learn |
| --- | --- | --- | --- |
| One-glance claim | "An entire PowerPoint in one HTML file" | "Gemma 4 26B in 2 GB RAM" | State a surprising result, not a category label |
| Familiar anchor | PowerPoint, HTML file | Gemma, RAM, M-series Mac | Borrow concepts readers can evaluate instantly |
| Constraint | One portable file; offline; no login | A 14 GB quantized model on an 8 GB machine | Make the obstacle tangible |
| Immediate proof | Link opens directly into the editor; examples and guestbook are live | Repo explains the SSD expert-streaming trick; app produces measured tokens/second | Let readers test the central claim before trusting the prose |
| Technical reveal | JSON data plus an editor, presenter, printer, save path, and encrypted relay inside the artifact | Routed experts stream from SSD while the GPU runs the shared layer | Explain the non-obvious mechanism in plain technical language |
| Honest tradeoff | Collaboration uses a blind relay; the core remains offline | Lower memory buys lower speed; model download is still 15 GB | Name the cost before commenters discover it |
| Thread fuel | Portability, standards, PowerPoint replacement, security, file longevity | mmap comparison, SSD wear, thermal behavior, speed, model support | Give experts several real claims to interrogate |
| Builder behavior | A detailed first comment explains why it exists and how it is built | The author answers benchmarks and competing approaches with numbers | Stay present and answer the hard comparison questions |

The shared anatomy is **artifact first, claim second, explanation third**:

1. A result a reader can restate after seeing only the title.
2. A live artifact or repository that proves the exact result immediately.
3. A first comment that explains the origin, mechanism, boundaries, and tradeoff.
4. Enough technical specificity for skeptical experts to have a substantive
   argument rather than a branding argument.
5. An author who answers comparisons directly instead of defending every choice.

agi-cli currently has a weaker candidate title — "Open-source CLI that runs 16
coding agents across your own machines." It has the number and open-source cue,
but "runs" is a capability inventory, not a demonstrated result. The research
job above supplies the missing artifact. A title shaped for the extreme-tail
mechanics would be:

> **Show HN: One research brief, 16 coding agents, one cited report**

That title should run only if the linked page opens directly on the completed
research artifact and a short recording shows the fan-out, the cross-machine
browser hop, the rejected stale claim, and the final report. Without that proof,
the original title A is more honest.

### Why pricing killed the adjacent products — the causal chain

"Pricing caused the failure" does not mean the number `$30` was inherently too
high. The failure was a chain in which the **unit charged, value withheld, buyer,
and cost base did not line up**.

#### Vibe Kanban: the paid tier sat beside the value

1. The free local product already completed the solo user's core job: orchestrate
   several coding agents.
2. The $30/user/month tier withheld collaboration and hosted conveniences, not
   more of the core outcome.
3. The active user was a solo developer or founder, so adding a seat did not
   increase that user's value; it introduced a feature they often did not need.
4. Open source removed switching friction and made self-hosting or forking a
   credible answer to the paywall.
5. The company therefore had attention and usage but no paid event tied to the
   work users valued. Its founder's post-mortem reduces the missing mechanics to
   two: enterprise sales and token resale. It had neither.

#### Roo Code and Continue.dev: bring-your-own-key removes the meter

1. Their tools created value locally while the user bought inference directly
   from model providers.
2. Usage growth increased Anthropic/OpenAI revenue, not the orchestrator's
   revenue; the tool owned no metered resource that became more valuable with
   use.
3. Apache-licensed code made feature gates easy to route around and enabled
   forks to redistribute improvements.
4. A team/governance layer can be valuable, but only after an enterprise buying
   motion exists. Continue.dev built that layer without the enterprise book and
   was acquired by a company that had one; Roo's successor moved toward hosted,
   consumption-shaped execution and a licence that protects the paid surface.

#### Flat-rate agent subscriptions: the price promises the wrong cost curve

1. A human seat has roughly fixed monthly revenue; an agent can consume wildly
   different inference per task.
2. Heavy users therefore become the worst-margin customers under "unlimited" or
   loosely capped plans.
3. Vendors respond with opaque limits and moving allowances, which creates the
   exact volatility and distrust found in the Reddit corpus.
4. Consumption pricing fixes the unit mismatch but introduces bill shock unless
   usage is visible and capped. Cursor's public apology and refunds show that a
   correct unit can still fail when the meter is not legible.
5. The durable versions combine a visible meter, enterprise contracts, and an
   owned model or infrastructure layer that keeps the inference spread from
   disappearing.

The implication for agi-cli is narrower than "charge for agents." Keep the
local, bring-your-own-subscription workflow free. Charge only when agi-cli itself
supplies a scarce, growing resource: managed execution, hosted relay/gateway,
retained organizational history, policy enforcement, or governed fleet capacity.
Tie the paid unit to that resource, expose the meter before the run, cap it by
default, and sell governance only after the launch user has pulled the workflow
into an organization.
