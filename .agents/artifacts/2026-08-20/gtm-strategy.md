---
kind: report
template: report.v1
title: 'agi-cli GTM: the numbers, the graveyard, and the one bet worth making'
summary: 'The 18,542 monthly npm downloads are the fleet installing itself — r=0.965 against our own release cadence. Roughly 19 humans visited the public repo landing page in 14 days, and the front door serves a bash script instead of the landing page. Meanwhile the best-funded OSS product in this exact category shut down at 27,867 stars for want of a business model. Pricing is not the question yet.'
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

**2. The front door serves a shell script.** `https://agi-cli.sh/` returns the
797-byte installer as its root document. The real landing page — hero video,
comparison table, benchmark chart — exists at `app/page.tsx` in `agents-cli-web`
and is not being served at the root. Every link in the launch plan points there.

**3. The category's best case is a shutdown notice.** Vibe Kanban reached
**27,867 stars** and $7.4M raised doing multi-agent orchestration, and shut down
on 2026-04-10 because it "couldn't find a business model." Roo Code (3M installs)
shut down 2026-05-15. Terragon shut down 2026-02-09. In the same window Devin
($492M ARR), Cursor ($2B ARR) and Factory ($1.5B valuation) raised nine and ten
figures. Every casualty was free and open. Every winner was hosted and paid.

That third fact is the one that should change the plan. The existing launch
playbook optimizes for stars. Stars are not the win condition — three teams
proved that by getting them and dying anyway. So the sequence is: **open the
front door, instrument for retention rather than installs, and pick the
monetization model the survivors used** — a hosted team layer — rather than the
one the casualties tried.

The uncomfortable corollary, stated plainly because it is a decision only you can
make: this is a 277,892-line product with no paying users, competing in a
category where the OSS lane has a demonstrated zero-revenue ceiling, while you
also carry Rush and Prix at zero revenue. Section *Recommendations* ends with
that fork rather than resolving it.

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

### 2. Three front-door defects, all cheap, all blocking the launch that is already planned

The launch playbook (`.agents/artifacts/2026-08-20/launch-venues-and-posts.md`)
is well-researched and ready. It will underperform against these three defects,
each independently fixable in hours.

- **The root domain serves the installer.** `curl -sIL https://agi-cli.sh/`
  returns `200` with the bash script as the document body; `/docs` correctly
  serves the Next app. `scripts/release.sh:115` states the intent as
  `pattern A: root=docs, /install.sh=script` — so the deployed state contradicts
  the deploy script's own description. Note also that `release.sh` still targets
  `CUSTOM_DOMAIN="agents-cli.sh"`, which now 301s to `agi-cli.sh`, and the local
  `agents-cli-web` checkout is **29 commits behind** `origin/main`.
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
worktrees around one or two harnesses.

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

What survives is stronger for resting entirely on primary sources. OpenClaw — a
harness agi-cli supports (`AgentId` includes `openclaw`) — documents the risk in
its own words: *"Anthropic can change Claude Code billing and rate-limit behavior
without an OpenClaw release."* And its guidance points where this report does:
for **"shared production automation"** and **"predictable production spend,"** it
tells users to prefer API keys over reusing subscription credentials, because
subscription behaviour is subject to unannounced change. That is the vendor of the
subscription-reuse feature telling you not to build shared automation on it.

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

## Recommendations

### Act 1 — Make users detectable, and open the front door (this week)

None of this is growth work. It is the precondition for knowing whether any
growth work succeeded.

| # | Action | Why it blocks everything else |
| --- | --- | --- |
| 1 | Serve the landing page at `agi-cli.sh/`, move the installer to `/install.sh` only | Every launch link currently lands on a bash script |
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
   still happens — a broken front door helps nothing — but Act 3 does not, the
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
