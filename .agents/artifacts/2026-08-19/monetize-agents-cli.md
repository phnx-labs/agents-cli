---
kind: visual
title: "Monetizing agents-cli: the fleet control plane play"
summary: >
  Keep the CLI free and MIT — it is the distribution engine devs already love.
  Charge for the layer labs won't build and the multiplexers can't: a hosted
  team/fleet control plane with cross-vendor + cross-machine cost, audit, and
  governance. Meter the two hosted surfaces you already run.
status: draft
context: agents-cli monetization strategy · competitive landscape 2026
surface: internal
facts:
  - "Herdr: OSS Rust agent multiplexer, ~15-25k GitHub stars, #1 Trending Jun 30 2026"
  - "Codex: 5M weekly active users, PAYG team seats + Enterprise audit/RBAC"
  - "Prism / herm.run (YC S25, ex-Stripe/Greptile/Palantir) sells the hosted version of your substrate"
  - "Empty operational layer: spend enforcement heat 92 / audit heat 88 / 0 vendors sell decision audit"
  - "vibe-kanban died at 27k stars — orchestration UI is commoditizable, do not build it as the product"
---

## Story

**The ask.** How does the agency monetize agents-cli — a tool developers already love?

**The one-line answer.** Do **not** monetize the thing devs love (the free CLI) or the thing everyone is racing to give away (the multiplexer UI). Monetize the layer that is structurally out of reach for both your competitor types: a hosted **team/fleet control plane** that turns *N machines x M vendors* into one governed, auditable, cost-capped agent workforce. Keep the CLI MIT and free — it is the funnel, not the product.

**Why this, and why now.** Your own market-landscape research already found the shape of the opportunity: the model layer is solved and overcrowded (339 runtime companies), while the **operational layer is nearly empty** — spend enforcement (heat 92, ~4 vendors), decision audit (heat 88, *zero* vendors), isolation + kill-switch (heat 100, 3 vendors), cross-provider composition. agents-cli already touches **all four** locally. The gap between "we do this on one box" and "we sell this to a team across a fleet" is the entire business.

Three forces box in every competitor except you:

- **Labs go up-market but stay single-vendor.** Codex now sells pay-as-you-go team seats and Enterprise with audit logs, RBAC, and data controls — at 5M weekly actives. It will never manage *Claude + Gemini + Kimi + Codex* in one pane. Cross-vendor is the one thing a lab cannot ship.
- **Multiplexers compete on single-machine UI — the commoditizable layer.** Herd (desktop agent IDE, VC-backed), Herdr (OSS Rust TUI, ~15-25k stars, #1 Trending), HerdOS, CodeAgentSwarm, cmux, Claude Squad. vibe-kanban reached 27k stars and **died** — its founder said the labs commoditized the surface out from under it. Do not stand where the labs and a free Rust TUI are both standing.
- **Managed agent-infra is the real monetization competitor — and it validates the thesis.** **Prism / herm.run** (YC S25; founders ex-Stripe, ex-Greptile, ex-Palantir) sells "secure infrastructure for agents: memory, sessions, tools, sandboxes, permissions, observability, scheduled runs — out of the box." That is a **hosted, funded version of your local substrate.** Someone raised money to sell what you already built. Your edge over them: cross-vendor breadth, cross-machine fleet SSH, local-first trust (keychain, worktrees), and a distribution engine they don't have.

## Figure

<figure>
<figcaption>Where agents-cli sits — the four competitor types, and the only quadrant with no incumbent</figcaption>
<svg viewBox="0 0 920 560" role="img" aria-label="Competitive positioning: single-vendor to cross-vendor on the x-axis, single-machine to fleet on the y-axis" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="currentColor"/></marker>
    <linearGradient id="glow" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#22d3ee" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="#22d3ee" stop-opacity="0.04"/>
    </linearGradient>
  </defs>
  <!-- axes -->
  <line x1="90" y1="500" x2="880" y2="500" stroke="currentColor" stroke-opacity="0.35" marker-end="url(#arrow)"/>
  <line x1="90" y1="500" x2="90" y2="40" stroke="currentColor" stroke-opacity="0.35" marker-end="url(#arrow)"/>
  <text x="470" y="536" text-anchor="middle" font-size="15" opacity="0.7">single-vendor  &#8594;  cross-vendor</text>
  <text x="34" y="270" text-anchor="middle" font-size="15" opacity="0.7" transform="rotate(-90 34 270)">single-machine  &#8594;  fleet</text>
  <!-- winning quadrant highlight (top-right) -->
  <rect x="500" y="60" width="360" height="200" rx="14" fill="url(#glow)" stroke="#22d3ee" stroke-opacity="0.5" stroke-dasharray="5 5"/>
  <text x="680" y="86" text-anchor="middle" font-size="13" fill="#22d3ee" font-weight="700">EMPTY — no incumbent</text>
  <!-- agents-cli node -->
  <g>
    <circle cx="690" cy="165" r="46" fill="#22d3ee" fill-opacity="0.18" stroke="#22d3ee" stroke-width="2"><animate attributeName="r" values="44;50;44" dur="3s" repeatCount="indefinite"/></circle>
    <text x="690" y="160" text-anchor="middle" font-size="15" font-weight="800">agents-cli</text>
    <text x="690" y="180" text-anchor="middle" font-size="11" opacity="0.8">the control plane</text>
  </g>
  <!-- labs: single-vendor, moving up (right-ish but locked left of center) -->
  <g>
    <circle cx="250" cy="150" r="40" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="250" y="146" text-anchor="middle" font-size="13" font-weight="700">Labs</text>
    <text x="250" y="164" text-anchor="middle" font-size="10" opacity="0.7">Codex / Claude</text>
    <text x="250" y="98" text-anchor="middle" font-size="10" opacity="0.55">up-market, single-vendor</text>
  </g>
  <!-- managed infra: cross-vendor-ish, fleet-ish (the real rival) -->
  <g>
    <circle cx="560" cy="330" r="40" fill="#f59e0b" fill-opacity="0.10" stroke="#f59e0b" stroke-opacity="0.6"/>
    <text x="560" y="326" text-anchor="middle" font-size="13" font-weight="700">Prism</text>
    <text x="560" y="344" text-anchor="middle" font-size="10" opacity="0.75">herm.run · YC</text>
    <text x="560" y="392" text-anchor="middle" font-size="10" opacity="0.55">hosted substrate — the rival</text>
  </g>
  <!-- multiplexers: single-machine, cross-vendor -->
  <g>
    <circle cx="700" cy="440" r="44" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.35"/>
    <text x="700" y="430" text-anchor="middle" font-size="13" font-weight="700">Multiplexers</text>
    <text x="700" y="448" text-anchor="middle" font-size="10" opacity="0.7">Herd · Herdr · cmux</text>
    <text x="700" y="464" text-anchor="middle" font-size="10" opacity="0.5">free / commoditized</text>
  </g>
  <!-- vibe-kanban tombstone -->
  <g opacity="0.5">
    <rect x="300" y="410" width="120" height="60" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.3" stroke-dasharray="3 3"/>
    <text x="360" y="436" text-anchor="middle" font-size="11" font-weight="600">vibe-kanban</text>
    <text x="360" y="454" text-anchor="middle" font-size="10">27k stars, dead</text>
  </g>
</svg>
</figure>

## The empty operational layer

Your landscape research ranked the market's pain by *community heat* against *vendor coverage*. The bars below are where heat is highest and coverage is thinnest — and each maps to something agents-cli already does on a single box (`budget`/`enforce`, `sessions`/`events`, keychain `secrets` + worktrees). The product is turning each local capability into a team-wide, cross-vendor service.

<figure>
<figcaption>Heat vs vendor coverage — the four openings, and what agents-cli already ships locally</figcaption>
<svg viewBox="0 0 900 340" role="img" aria-label="Bar chart of community heat against vendor coverage for four opportunity areas" xmlns="http://www.w3.org/2000/svg">
  <g font-size="12">
    <!-- rows -->
    <!-- Spend enforcement -->
    <text x="10" y="52" font-weight="700">Spend enforcement</text>
    <text x="10" y="68" opacity="0.6">you have: budget · enforce · ledger</text>
    <rect x="300" y="34" width="516" height="20" rx="4" fill="currentColor" fill-opacity="0.08"/>
    <rect x="300" y="34" width="470" height="20" rx="4" fill="#ef4444" fill-opacity="0.75"><animate attributeName="width" from="0" to="470" dur="0.9s" fill="freeze"/></rect>
    <text x="826" y="49" font-size="11" opacity="0.8">heat 92 · ~4 vendors</text>
    <!-- Decision audit -->
    <text x="10" y="122" font-weight="700">Decision audit / accountability</text>
    <text x="10" y="138" opacity="0.6">you have: sessions · events · feed</text>
    <rect x="300" y="104" width="516" height="20" rx="4" fill="currentColor" fill-opacity="0.08"/>
    <rect x="300" y="104" width="449" height="20" rx="4" fill="#f59e0b" fill-opacity="0.85"><animate attributeName="width" from="0" to="449" dur="0.9s" fill="freeze"/></rect>
    <text x="826" y="119" font-size="11" opacity="0.8">heat 88 · 0 vendors</text>
    <!-- Isolation + kill switch -->
    <text x="10" y="192" font-weight="700">Isolation + kill-switch</text>
    <text x="10" y="208" opacity="0.6">you have: worktrees · keychain secrets</text>
    <rect x="300" y="174" width="516" height="20" rx="4" fill="currentColor" fill-opacity="0.08"/>
    <rect x="300" y="174" width="510" height="20" rx="4" fill="#ef4444" fill-opacity="0.9"><animate attributeName="width" from="0" to="510" dur="0.9s" fill="freeze"/></rect>
    <text x="826" y="189" font-size="11" opacity="0.8">heat 100 · 3 vendors</text>
    <!-- Cross-provider composition -->
    <text x="10" y="262" font-weight="700">Cross-provider composition</text>
    <text x="10" y="278" opacity="0.6">you have: every harness + fleet SSH + teams</text>
    <rect x="300" y="244" width="516" height="20" rx="4" fill="currentColor" fill-opacity="0.08"/>
    <rect x="300" y="244" width="420" height="20" rx="4" fill="#22d3ee" fill-opacity="0.85"><animate attributeName="width" from="0" to="420" dur="0.9s" fill="freeze"/></rect>
    <text x="826" y="259" font-size="11" opacity="0.8">the moat labs can't build</text>
  </g>
  <line x1="300" y1="24" x2="300" y2="300" stroke="currentColor" stroke-opacity="0.2"/>
  <text x="300" y="318" font-size="11" opacity="0.6">bar length = community heat · label = vendors serving it</text>
</svg>
</figure>

## Monetization paths — ranked

| # | Play | What you sell | To whom | Pricing shape | Already built | Defensibility |
|---|------|---------------|---------|---------------|---------------|---------------|
| **1** | **Team / Enterprise control plane** (open-core SaaS) | Hosted fleet dashboard: cross-vendor + cross-machine session/cost/audit aggregation, RBAC, SSO, org-wide budget caps + kill-switch, centrally-managed guardrails | Teams & orgs running agent fleets | Per-seat Team (~$20-40/dev/mo) + Enterprise custom (SSO, SOC2, on-prem, SLA) | secrets · budget/enforce · sessions · events · teams · feed | **High** — cross-vendor + cross-machine + governance is the empty quadrant |
| **2** | **Meter the hosted surfaces you already run** | Managed `artifacts share` (custom domains, analytics, private/access-gated, team galleries) + `agents cloud` dispatch | Existing CLI users, self-serve | Freemium + usage (GB-months, cloud-minutes/task) | share.agents-cli.sh on your R2 · cloud dispatch | **Medium** — convenience + margin; low lift to bill |
| **3** | **Spend-governance product** (highest-heat wedge) | Standalone: org budget caps, per-repo/model/session limits, runaway-loop kill-switch, cross-vendor spend analytics + chargeback | Even single-vendor shops (they run 2+ vendors) | Usage-based or flat per-org | budget · enforce · ledger · preflight | **Medium-High** — heat 92, "$3/day &#8594; $400 in an afternoon" |
| **4** | **Managed fleet / agency** (services-as-software) | Run your agent workforce on our control plane; or done-for-you outcomes | Companies without fleet ops | Retainer / outcome-based | the whole factory you already operate | **High touch** — funds the product, not CLI-scale |
| **5** | **Ecosystem** | Premium skills/plugins/subrule packs, verified providers, sponsorship tiers | Community + power users | Marketplace rev-share + Sponsors | .agents plugin/skill system | **Low ceiling** — good funnel, community goodwill |

## The account is the keystone — three products people will pay for

The three features worth charging for are not three bets. They are three faces of **one primitive agents-cli does not have yet: a user account.** Today "identity" is a git checkout — `~/.agents/` is a repo you clone, and config resolves `project → user → extras → system` via `agents sync` / `agents repo pull`. Onboarding a new agent or a new box means cloning a repo by hand. That is the "pretty bad" mechanism. Add an account and the same keystone unlocks all three features below — plus billing, RBAC, and audit come along for free.

<figure>
<figcaption>One account, three paid surfaces — and the control plane, billing, and SSO all hang off the same keystone</figcaption>
<svg viewBox="0 0 900 380" role="img" aria-label="Hub and spoke: a user account at the center connects to config sync, rent-a-box, and team artifacts" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="s3" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="currentColor" fill-opacity="0.5"/></marker></defs>
  <!-- faded outer ring: what the account also unlocks -->
  <ellipse cx="450" cy="190" rx="430" ry="168" fill="none" stroke="currentColor" stroke-opacity="0.15" stroke-dasharray="4 6"/>
  <text x="450" y="34" text-anchor="middle" font-size="11" opacity="0.5">+ billing · RBAC · SSO · org-wide audit — all hang off the same account</text>
  <!-- spokes -->
  <line x1="450" y1="190" x2="185" y2="190" stroke="currentColor" stroke-opacity="0.4" marker-end="url(#s3)"/>
  <line x1="450" y1="190" x2="450" y2="322" stroke="currentColor" stroke-opacity="0.4" marker-end="url(#s3)"/>
  <line x1="450" y1="190" x2="715" y2="190" stroke="currentColor" stroke-opacity="0.4" marker-end="url(#s3)"/>
  <!-- center: account -->
  <circle cx="450" cy="190" r="58" fill="#22d3ee" fill-opacity="0.16" stroke="#22d3ee" stroke-width="2"><animate attributeName="r" values="56;61;56" dur="3s" repeatCount="indefinite"/></circle>
  <text x="450" y="185" text-anchor="middle" font-size="16" font-weight="800">Account</text>
  <text x="450" y="204" text-anchor="middle" font-size="10" opacity="0.75">the keystone</text>
  <!-- left: config sync -->
  <g>
    <rect x="20" y="150" width="165" height="82" rx="12" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="102" y="180" text-anchor="middle" font-size="13" font-weight="700">Config sync</text>
    <text x="102" y="200" text-anchor="middle" font-size="10" opacity="0.7">sign in — setup</text>
    <text x="102" y="214" text-anchor="middle" font-size="10" opacity="0.7">follows every agent/box</text>
  </g>
  <!-- bottom: rent a box -->
  <g>
    <rect x="360" y="322" width="180" height="48" rx="12" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="450" y="343" text-anchor="middle" font-size="13" font-weight="700">Rent-a-box</text>
    <text x="450" y="360" text-anchor="middle" font-size="10" opacity="0.7">1 laptop &#8594; N agents, pre-provisioned</text>
  </g>
  <!-- right: team artifacts -->
  <g>
    <rect x="715" y="150" width="165" height="82" rx="12" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="797" y="180" text-anchor="middle" font-size="13" font-weight="700">Team artifacts</text>
    <text x="797" y="200" text-anchor="middle" font-size="10" opacity="0.7">managed hosting +</text>
    <text x="797" y="214" text-anchor="middle" font-size="10" opacity="0.7">real access control</text>
  </g>
</svg>
</figure>

| Feature (your words) | Today — grounded in the code | What to build | Why they pay | Risk to manage |
|---|---|---|---|---|
| **Setup sync to any new agent/box** | Git layer `project→user→extras→system`; a new box = clone a repo + `agents sync` by hand | Account-backed sync: sign in, config/skills/rules/commands/hooks follow you. Git stays the self-host escape hatch | "Never reconfigure a new machine again" — VoC's **81-upvote** iCloud moment | **Secrets must be client-side encrypted** (we can't read them) or you lose the exact skeptics you want |
| **Rent a box to scale agents** | Fleet SSH + `agents devices` + `--device` — but **BYO hardware**, useless to the 90% with one laptop | On-demand worker, pre-provisioned from their account (setup already there); **credential tier gates cloud-eligibility** (see below) | 1 laptop &#8594; N agents in one command | **Decided:** never custody a subscription login into the cloud — the tier rule below makes this structural, not a policy you have to enforce by hand |
| **Team artifact sharing + permissions** | `agents artifacts share` on their **own** R2, public-unlisted or "private" — but unlisted **is not** access control (R2 reads are public to any URL holder) | Managed hosting + auth-gated reads + team membership + per-artifact perms | Safe team sharing; fixes a **real privacy gap** | Cleanest to build, clearest willingness-to-pay — **ship this first** |

**The keystone insight:** the account is also what the Team control plane (path 1), spend governance (path 3), billing, and enterprise SSO all hang off. You build identity once, and every paid surface becomes an upsell on top of it rather than a separate product.

### Decided — the credential tier decides where a harness runs

The "do we hold credentials?" fork is resolved without becoming a custodian: **where a harness may run is a function of its credential type, not a trust decision you enforce by hand.** This is the exact line the codebase is already drawing — PR #2668 / RUSH-2359, *"stop Rush Cloud reading interactive Claude login — setup-token only."*

| Credential the user connects | Runs where | Why it is safe |
|---|---|---|
| **API key** (metered, per-token: Anthropic / OpenAI / Google) | Local **and** cloud / rented box | Fair use — billing is metered, nothing is seat-shared |
| **Cloud-permitted token** (e.g. a `setup-token` whose ToS allows headless / CI) | Local **and** cloud | The token *class* explicitly permits headless & remote use |
| **Interactive subscription login** (Claude Max, ChatGPT Plus, Gemini) | **Local only** | Running a seat login headless on a rented box is account-sharing — the "all accounts banned, 403" trap |

So "scale to the cloud" provisions **only cloud-eligible credentials** onto a box; a local-only login is refused with a clear path — *"add an API key to run this harness on a rented box."* You never push a subscription login into the cloud, which is simultaneously the ToS-safe rule **and** the zero-knowledge, skeptic-proof posture. "Cloud" here just means a box / VM, not a multi-tenant runtime you have to build.

## Sequence — don't build the SaaS before the funnel proves it

<figure>
<figcaption>The order that de-risks each stage on the one before it</figcaption>
<svg viewBox="0 0 900 150" role="img" aria-label="Four-stage sequence from free CLI to enterprise" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="currentColor"/></marker></defs>
  <g font-size="12" text-anchor="middle">
    <g><rect x="20" y="40" width="180" height="66" rx="10" fill="#22d3ee" fill-opacity="0.12" stroke="#22d3ee" stroke-opacity="0.6"/><text x="110" y="66" font-weight="700">Free MIT CLI</text><text x="110" y="86" opacity="0.7">the funnel · devs love it</text></g>
    <line x1="205" y1="73" x2="235" y2="73" stroke="currentColor" stroke-opacity="0.5" marker-end="url(#a2)"/>
    <g><rect x="240" y="40" width="180" height="66" rx="10" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.4"/><text x="330" y="66" font-weight="700">3-5 design partners</text><text x="330" y="86" opacity="0.7">teams running fleets, paid</text></g>
    <line x1="425" y1="73" x2="455" y2="73" stroke="currentColor" stroke-opacity="0.5" marker-end="url(#a2)"/>
    <g><rect x="460" y="40" width="180" height="66" rx="10" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.4"/><text x="550" y="60" font-weight="700">Team control plane</text><text x="550" y="80" opacity="0.7">per-seat + metered</text><text x="550" y="96" opacity="0.7">hosted surfaces</text></g>
    <line x1="645" y1="73" x2="675" y2="73" stroke="currentColor" stroke-opacity="0.5" marker-end="url(#a2)"/>
    <g><rect x="680" y="40" width="200" height="66" rx="10" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.4"/><text x="780" y="66" font-weight="700">Enterprise / agency</text><text x="780" y="86" opacity="0.7">SSO · SOC2 · outcomes</text></g>
  </g>
</svg>
</figure>

## Don't build

- **Account-pooling / ban-avoidance.** ToS-risky, credential-aggregation liability. It is your competitors' biggest pain (CLIProxyAPI "all accounts banned, 403"); don't enter it.
- **Client-side cost accuracy as a headline.** Structurally a guessing game — vendors hide real limits, sub-agent tokens are invisible — and labs are eating it with native `/usage`. Ship it as a *derived view* inside audit, never the pitch.
- **Orchestration UI as the product.** vibe-kanban's grave. The labs and a free Rust TUI both live here. Win on the substrate under the UI.
- **A managed layer that only wraps one vendor.** That is Prism's game and the labs' game. Your entire edge is being the one who is *not* single-vendor.

## The branding & trust signal — read the Siddarth thread

Your chat with **Siddarth** ("Siddarth Prism / Agents" in Contacts — a talented, pedigreed engineer, notifications silenced) is a live data point worth acting on, in two ways:

- **He is the ICP archetype.** You showed him the real differentiators — sub-millisecond `agents sessions` (local SQLite + FTS5, cross-device over SSH), shared memory for coding agents, `agents events` for fleet-wide debugging. His reply was a measured **"Interesting"** twice. A skeptical, high-pedigree engineer who wants these features is exactly who a design-partner motion and a technical-hire/advisor conversation should target. Pull him in.
- **He is evidence for your branding worry.** A flat "Interesting" from someone with reputation is a tell that **"AGI CLI" over-claims to serious people.** Pedigreed engineers and enterprise buyers discount hype names; they trust concrete, verifiable substrate. Position on what is demonstrably true — *"the control plane for agent fleets," "one mesh, many machines, fully wired"* — not an AGI framing. This matters for **who buys and who you can recruit**: the same skeptic reflex that made him say "Interesting" is what closes or kills an enterprise deal and a senior hire.

*Note: I could not confirm Siddarth's exact LinkedIn — his Contacts card carries no surname/URL, and the adjacent YC company Prism (herm.run) lists founders Rajit Khanna, Alex Liu, and Land Tantichot, none named Siddarth. Tell me his last name or company and I'll pull the profile and tailor the design-partner/hire angle.*

## Data

**Competitor set (2026), by type:**

| Type | Players | Monetizes how | Threat to this play |
|------|---------|---------------|---------------------|
| Labs (single-vendor) | Codex (5M WAU, PAYG seats + Enterprise audit/RBAC), Claude, Gemini | Seats + usage + Enterprise | Low — will never go cross-vendor |
| Managed agent-infra | **Prism / herm.run** (YC S25), E2B, Daytona, Kernel, Blaxel, Mem0 | Resource metering, enterprise | **High** — sells the hosted substrate |
| Multiplexers (single-machine UI) | Herd (VC), Herdr (~15-25k stars OSS), HerdOS, cmux, Claude Squad, CodeAgentSwarm | Mostly free / early | Low as rival, high as commoditizer |
| Routers / gateways | LiteLLM (56k stars), OpenRouter, Portkey | Take-rate / usage | Adjacent — a feature, not the product |

**agents-cli's uncontested surface:** cross-vendor (every harness) + cross-machine (fleet SSH, load-aware routing) + local-first trust (OS keychain secrets, worktree isolation) + sub-ms session/event index + teams DAG + monitors + routines + budget/enforce + own-R2 artifact sharing. No competitor holds all of these at once.
