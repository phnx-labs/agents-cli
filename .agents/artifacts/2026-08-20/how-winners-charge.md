---
kind: report
template: report.v1
title: 'How the winners actually charge: the pricing mechanics behind "every casualty was free, every winner was paid"'
summary: 'The GTM report said the casualties were free and the winners were hosted and paid. This answers the follow-up: paid HOW? The winners do not simply price better — they charge for a different thing. Casualties gave away the complete product and charged seats for collaboration features nobody needed. Winners meter the compute the agent consumes, sell it org-level to enterprises, and drive margin by owning the model underneath. The whole industry converged on that shape within twelve months, and even the winners bleed on flat-rate individuals — which is why every flat subscription in the category keeps tightening its limits.'
status: draft
human: author
host: fleet-worker
session: n/a
links:
  - label: 'Companion: agi-cli GTM report (the passage this answers)'
    url: 'https://github.com/phnx-labs/agents-cli/blob/main/.agents/artifacts/2026-08-20/gtm-strategy.md'
  - label: 'Companion: why the biggest orchestrators died'
    url: 'https://github.com/phnx-labs/agents-cli/blob/main/.agents/artifacts/2026-08-20/why-orchestrators-die.md'
  - label: 'Companion: developer pain, from the threads (same date)'
    url: 'https://github.com/phnx-labs/agents-cli/blob/main/.agents/artifacts/2026-08-20/developer-pain-reddit.md'
---

## Summary

The GTM report's third finding — *"Every casualty was free and open. Every
winner was hosted and paid"* — prompted the natural follow-up: **paid how?**
If Vibe Kanban failed *with* a $30/seat paid tier, "being paid" cannot be the
whole answer. This report reconstructs the winners' actual pricing mechanics
from primary sources and dated reporting (research run 2026-08-20; every
claim sourced; aggregator-only figures marked UNVERIFIED).

Four findings:

1. **The winners charge for a different thing, not a better price.** The
   casualties gave away the complete product and charged for *collaboration*
   — a seat fee on features solo users didn't need (Vibe Kanban's $30 seat;
   its founder's verdict: *"Everyone who is making money is doing 2 things:
   selling to enterprise, and reselling tokens. We were doing neither"*).
   The winners meter **the compute the agent consumes** — Devin's ACUs,
   Cursor's dollar-denominated credit pool drawn at API rates, Copilot's AI
   Credits, Factory's token meter. That unit scales with work performed and
   tracks the vendor's own inference bill, so heavy use grows revenue
   instead of destroying margin.
2. **The entire category converged on consumption metering within twelve
   months.** Cursor moved June 2025 (and apologized for how it communicated
   it); Augment swapped per-message for credits October 2025; Warp
   consolidated to AI credits effective December 2025 renewals; GitHub
   Copilot replaced premium requests with token-metered AI Credits on June
   1, 2026; Devin was consumption-priced from the start. Seat-only pricing
   for agents is dead among the survivors — a seat measures a human, and
   the whole point of an agent is that the human is not the unit of work.
3. **The buyer that makes the model work is the enterprise.** Cursor:
   roughly 60–65% of revenue from enterprise, with ~$2.6B annualized
   enterprise/B2B revenue cited in the SpaceX acquisition filing (June
   2026). Cognition: bought Windsurf in July 2025 explicitly for its ~$82M
   enterprise ARR, 350+ enterprise customers and go-to-market team — then
   went from $73M to $492M ARR in eleven months. Factory raised at $1.5B
   selling enterprise droid deployments. Copilot rides Microsoft's
   enterprise agreements to 4.7M paid seats. Meanwhile, the reported
   segment split at Cursor: **enterprise accounts gross-margin positive,
   individual accounts loss-making.**
4. **"Winning" pricing still is not profitable pricing — the margin comes
   from owning the layer underneath.** Anthropic ran a −94% gross margin in
   2024 and cut its 2025 margin target to ~40% when inference overran; a
   June 2026 analysis found a $200/mo subscription can consume ~$14,000 of
   compute at full utilization; one analyst put Cursor's gross margin at
   −23% for the quarter ending January 2026 (UNVERIFIED, single source) —
   before its own Composer model absorbed enough routing to flip it
   margin-positive by April 2026. The stable stack is: consumption pricing
   on top, enterprise contracts in the middle, an owned model (or owned
   infrastructure) at the bottom. Everyone without the bottom layer is
   reselling someone else's tokens at a spread the model vendor can close
   at will — which is also why every flat-rate subscription in the category
   keeps tightening its limits (the demand-side view of this is the
   companion pain report).

**What this sharpens for agi-cli:** the GTM report's "hosted team layer"
recommendation gets a mechanical spec. The monetizable unit is not a feature
gate on the free local tool (that is the casualty pattern) — it is **hosted
consumption billed org-level**: cloud sessions, managed gateway, fleet
control plane. Free local core, metered hosted compute, enterprise contract.
That is the only shape in this dataset with living examples at every scale.

## Findings

### 1. The mechanics, company by company

| Company | Unit charged | Entry → ceiling | Enterprise motion | Scale (sourced) |
| --- | --- | --- | --- | --- |
| Cursor (Anysphere) | $-denominated credit pool drawn at model API rates; Auto-routing to own model free | $20 Pro → $200 Ultra ($400 usage) | Teams $40/seat; Enterprise pooled usage, 50+ seats, annual | ~$4B ARR Jun 2026; acquired by SpaceX for $60B all-stock, closed Aug 14 2026 |
| Cognition (Devin) | ACU ≈ 15 min of agent work (~$2.00–2.25) | $20 Pro → $200 Max → Teams $80+$40/seat | ACU-contracted enterprise (Goldman, NASA, Mercedes); Windsurf sold per-seat alongside | $492M ARR May 2026 (own announcement), $25B pre-money raise |
| Factory | Hybrid: seats + metered tokens, minimum commitments | Pro $20 → Max $200 | Custom contracts, dedicated inference pools, on-prem | $1.5B valuation Apr 2026 (TechCrunch); no ARR disclosed |
| GitHub Copilot | AI Credits (token-metered) since Jun 1 2026; completions stay free | Free → Pro $10 → Pro+ $39 | Business $19/seat, Enterprise $39/seat inside Microsoft EAs | 4.7M paid subscribers (Microsoft FY26 Q2 earnings call) |
| Warp (Oz) | AI credits; BYOK escape valve | Free → Build $20 (1,500 cr) → Max $200 (18,000 cr) | Business $50/seat; Oz cloud orchestration gated to Enterprise | no revenue disclosed |
| Anthropic / OpenAI (first party) | Flat subscription reselling own inference | $20 → $100/$200 Max/Pro | API + enterprise seats | Anthropic $4.5B revenue 2025; GM −94% ('24) → ~40% target ('25) → 77% target ('28) |

The column that separates this table from the graveyard is the **unit**: every
row meters agent consumption (or owns the model being consumed). None of them
charges a seat fee for collaboration features on top of a free complete
product — the exact structure Vibe Kanban, Roo Code and the OSS cohort tried.

### 2. The twelve-month pivot to consumption

Dated sequence, all primary or vendor-stated:

- **Jun 16–17, 2025 — Cursor** replaces 500-requests-flat with "$20 of
  frontier model usage at API pricing." Its own stated reason: *"the hardest
  requests cost an order of magnitude more than simple ones. API-based
  pricing is the best way to reflect that."*
- **Oct 20, 2025 — Augment Code** kills per-message billing: a trivial edit
  and a full-module refactor cost the same message. Its own numbers: a small
  task ≈ 293 credits, a complex one ≈ 4,261 — a 14× spread inside one
  "message."
- **Dec 1, 2025 renewals — Warp** collapses three tiers into credit-metered
  Build/Max with BYOK.
- **Jun 1, 2026 — GitHub Copilot** retires Premium Request Units for
  token-metered AI Credits; sticker prices unchanged, the *unit* changed.
- **Devin** was consumption-priced from launch; its April 2025 move was a
  96% *entry-price* cut ($500→$20) to open self-serve, while enterprise
  stayed ACU-contracted.

The mechanic every vendor states in its own words: agentic workloads vary by
orders of magnitude per task, so flat units (seats, requests, messages)
misprice both ends — light users overpay and churn, heavy users are a
subsidy fire. The demand-side mirror of the same fact is in the companion
pain report: a $200 subscription can consume ~$14,000 of compute at the
ceiling (SemiAnalysis via secondary, Jun 2026), which is why flat-rate
vendors keep reaching for limit-tightening — and why their heaviest users
riot, stack accounts, and build coping infrastructure.

### 3. Enterprise is the buyer that makes the math work

- **Cursor:** enterprise/corporate ≈ 60–65% of revenue (Sacra + aggregators,
  2026), and the SpaceX deal filing cites **~$2.6B annualized enterprise/B2B
  revenue** (SEC-filing-sourced via Reuters/Yahoo, Jun 2026). Reported
  segment economics: enterprise accounts gross-margin **positive**,
  individuals **negative** (Sacra, 2026). Cursor hired a President of Global
  Revenue (ex-Rubrik) in Feb 2026 to build the enterprise motion.
- **Cognition:** the Windsurf acquisition (Jul 14, 2025) bought an ~$82M-ARR
  enterprise book, 350+ enterprise customers, and — per Cognition's own
  blog — Windsurf's go-to-market team. Revenue went $73M (Jun 2025, pre) →
  $492M (May 2026, post), a 6.7× in eleven months; logos across both
  products: Goldman Sachs, JPMorgan, NASA, Mercedes-Benz, Dell, Anduril.
- **Factory:** enterprise-first by design — custom contracts, partitioned
  inference pools, on-prem, "hundreds of thousands of developers" at Nvidia,
  Adobe, EY, MongoDB (TechCrunch, Apr 2026).
- **Copilot:** Business/Enterprise seats bill like any Microsoft 365 add-on
  inside existing enterprise agreements — distribution the point solutions
  cannot match; 4.7M paid seats as of the Jan 2026 earnings call.
- **The OSS survivors tell the same story from below:** Cline (5M installs,
  $32M raised) monetizes via an enterprise Teams tier; Augment retreated
  from self-serve entirely in 2026 to pivot enterprise; Continue was
  acqui-hired and shut down (by Cursor, Jun 2026); Roo Code shut down
  (May 2026) pivoting to a hosted cloud agent. In the whole free/open
  cohort, the only monetizations still alive are **enterprise
  seats/governance** and **hosted inference gateways** (OpenCode Zen, Kilo
  Pass — both young, neither with disclosed revenue).

### 4. The margin layer: own the model or bleed the spread

- **Cursor** is the clean experiment. On third-party models it reportedly ran
  a **−23% gross margin** in the quarter ending Jan 2026 — $1.23 paid to
  Anthropic/OpenAI per $1 of revenue (single analyst on X, UNVERIFIED). It
  shipped its own **Composer** model (Nov 2025; Composer 2, Mar 2026, priced
  ~$0.50/$2.50 per M tokens vs Sonnet's ~$3/$15), routed an increasing share
  of Auto-mode traffic to it, and reached slight gross-margin profitability
  by **April 2026** (Sacra). The pricing didn't change — the **COGS** did.
- **First parties** run the same play from the other side: Anthropic's gross
  margin path (−94% in 2024 → ~40% 2025 target, cut from 50% when inference
  ran 23% over → 77% by 2028 target) is a bet that owning the model and
  buying compute at scale eventually prices everyone else's spread. Its
  weekly-limit tightening (Jul 2025 onward) explicitly targets flat-rate
  power users whose agentic consumption exceeds the subscription — the same
  users whose rage fills the companion pain report.
- **The no-markup crowd** (Amp's token pass-through, OpenCode Zen, Kilo
  Pass) deliberately refuses the spread — monetizing convenience, not
  margin. Amp's ad-supported free tier (Oct 2025) was already walked back
  or reshaped within months (sources conflict; UNVERIFIED as of Aug 2026) —
  early evidence that "free, monetized sideways" remains unstable in this
  category.

### 5. Consumption pricing has a failure mode too: trust

The winners' unit is not painless. Cursor's June 2025 rollout produced a
$7,225 single-developer invoice story, a public CEO apology (Jul 4, 2025)
and refunds; Devin's real-world spend reportedly lands at $300–500/mo
against a $20 sticker, with under-specified tasks burning ACUs without
producing a mergeable PR (aggregator-sourced, UNVERIFIED). The lesson the
survivors internalized is not "charge less" — none of them reverted the
unit — it is **meter transparently and cap by default**: spend limits
(Cursor), visible credit pools (Copilot, Warp), plan ceilings with on-demand
top-ups (Devin 2026). Any hosted agi-cli tier inherits this requirement on
day one: the meter must be visible before the bill is.

<figure>
<svg viewBox="0 0 760 400" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Two-by-two: unit charged (seats vs consumption) against primary buyer (individual vs enterprise), with the 2026 outcome of each quadrant">
  <line x1="380" y1="40" x2="380" y2="360" stroke="currentColor" stroke-opacity="0.3" stroke-width="1"/>
  <line x1="40" y1="200" x2="720" y2="200" stroke="currentColor" stroke-opacity="0.3" stroke-width="1"/>
  <text x="380" y="26" text-anchor="middle" font-family="monospace" font-size="12" font-weight="700" fill="currentColor">unit: SEATS / FEATURES ← → unit: METERED CONSUMPTION</text>
  <text x="30" y="200" text-anchor="middle" font-family="monospace" font-size="12" font-weight="700" fill="currentColor" transform="rotate(-90 30 200)">INDIVIDUAL ← → ENTERPRISE</text>
  <rect x="52" y="52" width="316" height="136" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.35"/>
  <text x="66" y="76" font-family="monospace" font-size="13" font-weight="600" fill="currentColor">Seats, sold to enterprise</text>
  <text x="66" y="96" font-family="monospace" font-size="11" fill="currentColor" opacity="0.7">Windsurf (per-seat IDE) · Copilot Business</text>
  <text x="66" y="112" font-family="monospace" font-size="11" fill="currentColor" opacity="0.7">Cline Teams · Augment (post-pivot)</text>
  <text x="66" y="136" font-family="monospace" font-size="11" fill="currentColor" opacity="0.85">Outcome: viable — the seat rides an</text>
  <text x="66" y="152" font-family="monospace" font-size="11" fill="currentColor" opacity="0.85">existing procurement motion</text>
  <rect x="392" y="52" width="316" height="136" rx="8" fill="none" stroke="#a3e635" stroke-opacity="0.9"/>
  <text x="406" y="76" font-family="monospace" font-size="13" font-weight="600" fill="currentColor">Consumption, sold to enterprise</text>
  <text x="406" y="96" font-family="monospace" font-size="11" fill="currentColor" opacity="0.7">Devin ACU contracts · Cursor Enterprise</text>
  <text x="406" y="112" font-family="monospace" font-size="11" fill="currentColor" opacity="0.7">Factory · Copilot AI Credits</text>
  <text x="406" y="136" font-family="monospace" font-size="11" fill="currentColor" opacity="0.85">Outcome: where every winner lives —</text>
  <text x="406" y="152" font-family="monospace" font-size="11" fill="currentColor" opacity="0.85">margin-positive segment at Cursor</text>
  <rect x="52" y="212" width="316" height="136" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.35"/>
  <text x="66" y="236" font-family="monospace" font-size="13" font-weight="600" fill="currentColor">Seats/features, sold to individuals</text>
  <text x="66" y="256" font-family="monospace" font-size="11" fill="currentColor" opacity="0.7">Vibe Kanban $30 collab seat · Roo Code</text>
  <text x="66" y="272" font-family="monospace" font-size="11" fill="currentColor" opacity="0.7">Continue.dev · Terragon</text>
  <text x="66" y="296" font-family="monospace" font-size="11" fill="currentColor" opacity="0.85">Outcome: the graveyard — free core was</text>
  <text x="66" y="312" font-family="monospace" font-size="11" fill="currentColor" opacity="0.85">already the whole product</text>
  <rect x="392" y="212" width="316" height="136" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.35"/>
  <text x="406" y="236" font-family="monospace" font-size="13" font-weight="600" fill="currentColor">Consumption, sold to individuals</text>
  <text x="406" y="256" font-family="monospace" font-size="11" fill="currentColor" opacity="0.7">Cursor Pro/Ultra · Devin $20 · flat-rate</text>
  <text x="406" y="272" font-family="monospace" font-size="11" fill="currentColor" opacity="0.7">Claude Max / ChatGPT Pro · Zen/Kilo Pass</text>
  <text x="406" y="296" font-family="monospace" font-size="11" fill="currentColor" opacity="0.85">Outcome: loss-leader / funnel — subsidized</text>
  <text x="406" y="312" font-family="monospace" font-size="11" fill="currentColor" opacity="0.85">by enterprise; limits keep tightening</text>
</svg>
<figcaption>Every 2026 winner monetizes in the top-right quadrant. The graveyard is entirely bottom-left. The bottom-right — consumption sold to individuals — is where the pricing rage in the companion pain report is generated: it exists as a funnel, subsidized until the limits tighten.</figcaption>
</figure>

### 6. Read back onto the graveyard

With the mechanics in hand, the casualties' failure is precise, not vague:

- **Vibe Kanban** charged a seat (wrong unit) to solo developers (wrong
  buyer) for collaboration (wrong thing — the free local core was already
  the complete solo product). Its founder's two-part epitaph — enterprise
  and reselling tokens — is literally the two axes of the figure above.
- **Roo Code** (3M installs) had the users but monetized nothing they
  couldn't self-serve with their own keys; its team's pivot (Roomote) is a
  hosted, consumption-shaped cloud agent — the top-right quadrant, second
  attempt.
- **Continue.dev** built the governance/hub layer without the enterprise
  book to sell it into, and was acqui-hired by the company that had one.
- **Augment** had real funding ($252M) and retreating self-serve revenue
  (~$20M est., UNVERIFIED); its 2026 moves — killing self-serve plans and
  IDE extensions, pivoting to enterprise orchestration — are a live company
  executing the same migration the dead ones missed.

## Evidence

### Primary and dated sources

- Cursor pricing change + rationale + apology: cursor.com/blog/june-2025-pricing (own post); refund window Jun 16–Jul 4 2025 reported by news.aakashg.com and wearefounders.uk (2026).
- Cursor tiers 2026: cloudzero.com/blog/cursor-ai-pricing (fetched 2026-08-20). ARR trajectory + SpaceX deal: Yahoo Finance/Reuters citing the SEC filing signed by SpaceX CFO Bret Johnsen, dated Jun 16 2026; close Aug 14 2026 and share conversion per Wikipedia "Cursor (company)" (fetched 2026-08-20). Composer margin turnaround: sacra.com/c/cursor (2026).
- Devin ACU model + $500→$20 cut: VentureBeat (Apr 2025), valueaddvc.com breakdown; $492M ARR + $25B pre-money raise: TechCrunch, May 27 2026; Windsurf deal terms: cognition.com/blog/windsurf (Jul 2025); Scott Wu on seat→usage: Stripe customer interview.
- Factory: TechCrunch Apr 16 2026 ($150M Series C, $1.5B); billing structure: withorb.com/case-studies/factory; BYOK scope: docs.factory.ai/cli/byok/overview.
- Copilot AI Credits: github.blog "GitHub Copilot is moving to usage-based billing" (2026, effective Jun 1 2026); 4.7M paid: Microsoft FY26 Q2 earnings call (Jan 28 2026) via getpanto.ai.
- Warp: warp.dev/blog/warp-new-pricing-flexibility-byok (2026); Augment: augmentcode.com/blog/augment-codes-pricing-is-changing (Oct 2025); 2026 retreat: kilo.ai + bodegaone.ai reporting.
- OSS cohort: cline.bot funding post (Jul 31 2025); Roo shutdown: The New Stack + blog.kilo.ai "Thank you, Roo!" (Apr 21 2026); Continue acquisition/shutdown: The New Stack + Dealroom (Jun 2026).
- First-party margins: The Information via Investing.com (Jan 22 2026) — Anthropic −94% 2024 GM, ~40% 2025 target, 77% 2028 target; $14k-compute-per-$200-sub: SemiAnalysis via secondary summary (Jun 2026).

### What could not be verified (kept out of the load-bearing claims)

- Cursor's −23% gross margin quarter (single analyst X post, unfetchable directly) — used only with its UNVERIFIED label.
- Exact 2026 self-serve tier tables for Devin, Factory, Kilo, OpenCode Zen (aggregator-sourced; primary pricing pages unreachable or 429 during research).
- Enterprise share of Cognition's $492M; Copilot's revenue (only a wide modeled range exists); Augment's ~$20M revenue (Tracxn estimate); "60% of Fortune 500 use Cursor" (SEO aggregators only).
- Amp's ad-supported model status as of Aug 2026 (sources conflict on whether ads/training-mode opt-in still gate the free tier).
