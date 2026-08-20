---
kind: visual
template: visual.v1
title: 'Why the biggest agent orchestrators died at their peak'
summary: 'Vibe Kanban had 27,867 stars, 30,000 monthly users and a $30/seat paid tier, and still shut down. All three casualties charged money before they died. Its founder named the reason onstage: "Everyone who is making money is doing 2 things: selling to enterprise, and reselling tokens. We were doing neither."'
status: draft
human: author
host: fleet-worker
session: n/a
links:
  - label: 'Vibe Kanban shutdown notice'
    url: 'https://www.vibekanban.com/blog/shutdown'
  - label: 'Terragon shutdown notice'
    url: 'https://docs.terragonlabs.com/docs/resources/shutdown'
  - label: 'phnx-labs/agi-cli'
    url: 'https://github.com/phnx-labs/agi-cli'
---

## Story

Three products in this exact category shut down in the first half of 2026. Two of
them were among the most-starred repositories in it. That is the fact worth
staring at: **in agent orchestration, stars have not predicted survival**, and the
reason is not execution quality.

Vibe Kanban reached **27,867 stars** on $7.4M raised and shut down on 2026-04-10.
Roo Code **archived its repository** on 2026-05-15 at 24,332 stars and more than
three million installs. Terragon closed in February. In the same eighteen months,
Conductor raised $22M, Factory raised $150M at a $1.5B valuation, and Cognition
went from $37M to $492M ARR.

**None of them died from failing to charge.** All three had shipped a paid tier
before they shut down: Vibe Kanban at **$30/user/month** (Pro, plus a custom
Enterprise tier — refunds were issued to paying customers on the way out),
Terragon at **$25 and $50/month**, and Roo Code through its paid Cloud and Router
products. They died with revenue, not without it.

The founder of Vibe Kanban said why, onstage at AI Engineer Europe, while shutting
the company down live with 30,000 monthly active users:

> "Everyone who is making money is doing 2 things: selling to enterprise, and
> reselling tokens. **We were doing neither.**"

This quote is reported second-hand from a talk, via a tweet — it is not in the
shutdown post linked above, and it is the weakest-sourced claim carrying the most
weight in this document. A secondary write-up of the same talk puts the mechanism
plainly: it "was not a
coding agent itself — it was a button that helped users spend thousands of dollars
on other agents like Codex while collecting a $30 subscription."

That is the whole finding. The failure was not the absence of a price. It was
**attaching the price to orchestration convenience** — a seat fee sitting next to
a token bill an order of magnitude larger, charged for a layer the user could fork
or the model vendor could absorb.

Note what this does *not* say. Reselling tokens is a working model — OpenRouter
does exactly that. The constraint is narrower than "orchestrators cannot charge":
an orchestrator that **hands off to the user's own subscription** has surrendered
the token margin by design. `README.md:1494` describes agi-cli in those terms —
*"We hand off to the original CLI process — use your existing subscription or API
key"* — which is the right call for users and also forecloses one of the two
mechanisms that work.

Four consequences follow:

1. **No inference margin — though metering itself is still possible.** The
   pattern that monetized every comparable OSS infrastructure company — Vercel
   ($340M ARR), Modal ($60M→$300M annualized), Supabase ($170M ARR) — requires
   sitting in the request path and marking it up, which a BYO-subscription
   orchestrator has given up on purpose. But note the narrower truth: OpenRouter
   charges 5% even in bring-your-own-key mode — *"5% of what the same
   model/provider would cost normally"* — metering the **value of traffic routed**
   without holding the payment. Metering survives; the margin does not.
2. **The budget is already spent.** Users pay $20–200/month to the model vendor,
   and per Anthropic's own disclosed figures $150–250/dev/month in practice. An
   orchestrator asks for *incremental* budget on top of a bill the buyer already
   finds high.
3. **The platform absorbs the feature.** Every capability an orchestrator adds is
   a roadmap item for the model vendor, who ships it free to defend a subscription
   worth an order of magnitude more. Parallel agents, cloud dispatch and
   background runs all arrived inside the first-party products.
4. **The audience is the least willing to pay for glue.** The developer running
   five agents at once is exactly the one who will write their own tmux script.

So of the two mechanisms that work, one is foreclosed by the architecture. That
leaves **selling to enterprise** — and the survivors confirm it. Cline states the
doctrine outright: *"Our thesis is simple: inference cannot be the business model"*
— it sells inference at cost and jumps straight from free to a custom Enterprise
tier (SSO, RBAC, audit logs, team dashboard) with no prosumer seat in between.
opencode sells its Zen gateway *"at cost; so the only markup is to cover our
processing fees"* and runs an unpriced enterprise motion on top of 16M monthly
developers.

The uncomfortable corollary for anyone planning a ~$20–40 team seat: **that is the
price point that just failed.** Vibe Kanban's $30/user/month is the closest
comparable in the dataset, and Nimbalyst's $20/user/month is still "free during
beta," so it has not proven anything yet. The escape route is not a cheaper seat —
it is a different buyer, with the SSO/RBAC/audit surface that buyer requires.

One more lesson the survivors paid for: **permissive licensing removed the lever.**
Roo Code's own post-mortem cites *"forks redistributed our work as fast as we
shipped it"* — it had forked Cline, and Kilo Code and ZooCode then forked it. Its
successor, Roomote, abandoned Apache-2.0 for a Fair Core licence with a
license-key-enforced 10-user cap, explicitly so that *"you can't offer Roomote or
substantially similar functionality as a competing commercial product."*

## Data

Stars, archive flags and last-push dates were pulled live from the GitHub API on
2026-08-20, so the licence, star count, archive flag and last-push date are
first-hand reads. Shutdown *dates* are a different provenance: they come from each
company's own announcement — Terragon's 2026-02-09 is the service-end date it
published ("We'll keep Terragon running until February 9th, 2026"), recovered from
the Wayback archive because the live site is gone, and does not correspond to any
commit in its snapshot repo. Pricing is quoted from each company's own live or
Wayback-archived pricing page. Funding figures are the weakest link and are flagged inline where
they rest on aggregators rather than a primary source: Vibe Kanban's $7.4M comes
from Tracxn, not from bloop; Roo Code's reported $5M names no investor and is
**not** the Emergence Capital round (that is Cline's $32M); Terragon's investors
could not be confirmed at all.

| Project | Stars | Licence | State | Paid tier |
| --- | ---: | --- | --- | --- |
| opencode | 199,526 | MIT | alive, pushed today | Zen gateway **at cost** + enterprise |
| Cline | 66,548 | Apache-2.0 | alive, pushed today | free → Enterprise custom; inference at cost |
| **Vibe Kanban** | **27,867** | Apache-2.0 | **shut down 2026-04-10** (repo not archived) | **$30/user/mo + Enterprise** |
| **Roo Code** | **24,332** | Apache-2.0 | **repo archived 2026-05-15** | free ext + **paid Cloud/Router** |
| Claude Squad | 8,345 | AGPL-3.0 | alive, pushed today | none |
| container-use | 4,014 | Apache-2.0 | alive | none (Dagger-funded) |
| Crystal / Nimbalyst | 3,107 | MIT | rebranded, stale since 2026-02-26 | $20/user/mo — *free during beta* |
| Omnara | 2,750 | Apache-2.0 | alive | none |
| Uzi | 581 | MIT | stale since 2025-06-04 | none |
| **Terragon** | **256** | Apache-2.0 | **shut down 2026-02-09** | **$25 / $50 per mo** |
| Sculptor (Imbue) | 218 | MIT | alive | free beta |
| **agi-cli** | **15** | Apache-2.0 | alive, pushed today | none |

## Figure

### Star count does not predict survival

<figure class="artifact-figure artifact-figure-wide">
<svg viewBox="0 0 900 420" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Horizontal bar chart of GitHub stars on a log scale for twelve agent orchestration projects, colour-coded by whether they are dead, stale, alive and free, or alive and charging">
  <text x="16" y="24" font-family="system-ui, sans-serif" font-size="13" font-weight="700" fill="#8a8a8a">GITHUB STARS, LOG SCALE — pulled live 2026-08-20</text>

  <g stroke="#2a2a2a">
    <line x1="210" y1="44" x2="210" y2="360"/>
    <line x1="322" y1="44" x2="322" y2="360"/>
    <line x1="433" y1="44" x2="433" y2="360"/>
    <line x1="545" y1="44" x2="545" y2="360"/>
    <line x1="656" y1="44" x2="656" y2="360"/>
  </g>
  <g font-family="ui-monospace, monospace" font-size="11" fill="#5a5a5a">
    <text x="203" y="376">10</text><text x="311" y="376">100</text>
    <text x="425" y="376">1k</text><text x="537" y="376">10k</text><text x="645" y="376">100k</text>
  </g>

  <rect x="210" y="52"  width="480" height="16" rx="2" fill="#4d7c0f"/>
  <rect x="210" y="78"  width="427" height="16" rx="2" fill="#a3e635"/>
  <rect x="210" y="104" width="384" height="16" rx="2" fill="#dc2626"/>
  <rect x="210" y="130" width="378" height="16" rx="2" fill="#dc2626"/>
  <rect x="210" y="156" width="326" height="16" rx="2" fill="#4d7c0f"/>
  <rect x="210" y="182" width="291" height="16" rx="2" fill="#4d7c0f"/>
  <rect x="210" y="208" width="278" height="16" rx="2" fill="#a16207"/>
  <rect x="210" y="234" width="272" height="16" rx="2" fill="#4d7c0f"/>
  <rect x="210" y="260" width="197" height="16" rx="2" fill="#a16207"/>
  <rect x="210" y="286" width="157" height="16" rx="2" fill="#dc2626"/>
  <rect x="210" y="312" width="149" height="16" rx="2" fill="#4d7c0f"/>
  <rect x="210" y="338" width="20"  height="16" rx="2" fill="#4d7c0f"/>

  <g font-family="system-ui, sans-serif" font-size="12" fill="#c9c9c9">
    <text x="16" y="65">opencode</text>
    <text x="16" y="91">Cline</text>
    <text x="16" y="117" fill="#dc2626">Vibe Kanban</text>
    <text x="16" y="143" fill="#dc2626">Roo Code</text>
    <text x="16" y="169">Claude Squad</text>
    <text x="16" y="195">container-use</text>
    <text x="16" y="221">Crystal / Nimbalyst</text>
    <text x="16" y="247">Omnara</text>
    <text x="16" y="273">Uzi</text>
    <text x="16" y="299" fill="#dc2626">Terragon</text>
    <text x="16" y="325">Sculptor (Imbue)</text>
    <text x="16" y="351" fill="#a3e635">agi-cli</text>
  </g>

  <g font-family="ui-monospace, monospace" font-size="11" fill="#8a8a8a">
    <text x="698" y="65">199,526</text>
    <text x="645" y="91">66,548</text>
    <text x="602" y="117">27,867</text>
    <text x="596" y="143">24,332</text>
    <text x="544" y="169">8,345</text>
    <text x="509" y="195">4,014</text>
    <text x="496" y="221">3,107</text>
    <text x="490" y="247">2,750</text>
    <text x="415" y="273">581</text>
    <text x="375" y="299">256</text>
    <text x="367" y="325">218</text>
    <text x="238" y="351">15</text>
  </g>

  <g font-family="system-ui, sans-serif" font-size="11" fill="#8a8a8a">
    <rect x="16" y="398" width="11" height="11" fill="#dc2626"/><text x="34" y="408">shut down</text>
    <rect x="130" y="398" width="11" height="11" fill="#a16207"/><text x="148" y="408">stale, 6+ months</text>
    <rect x="290" y="398" width="11" height="11" fill="#4d7c0f"/><text x="308" y="408">alive, no paid tier</text>
    <rect x="470" y="398" width="11" height="11" fill="#a3e635"/><text x="488" y="408">alive, charging</text>
  </g>
</svg>
<figcaption>The two red bars near the top are the third and fourth most-starred projects in the set. Nothing about position on this axis predicts the colour.</figcaption>
</figure>

### The same eighteen months, two very different outcomes

<figure class="artifact-figure artifact-figure-wide">
<svg viewBox="0 0 900 360" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Timeline of 2026 showing three open-source shutdowns above the line and four large funding rounds for paid hosted competitors below it">
  <text x="16" y="24" font-family="system-ui, sans-serif" font-size="12" font-weight="700" fill="#dc2626">FREE AND OPEN — shut down</text>
  <text x="16" y="348" font-family="system-ui, sans-serif" font-size="12" font-weight="700" fill="#a3e635">HOSTED AND PAID — raised</text>

  <line x1="40" y1="186" x2="870" y2="186" stroke="#3a3a3a"/>
  <g font-family="system-ui, sans-serif" font-size="10" fill="#5a5a5a">
    <text x="70" y="204">FEB</text><text x="210" y="204">MAR</text><text x="350" y="204">APR</text>
    <text x="490" y="204">MAY</text><text x="630" y="204">JUN</text><text x="760" y="204">AUG 2026</text>
  </g>

  <g stroke="#dc2626" stroke-width="1.5">
    <line x1="80" y1="186" x2="80" y2="128"/>
    <line x1="360" y1="186" x2="360" y2="72"/>
    <line x1="500" y1="186" x2="500" y2="128"/>
  </g>
  <circle cx="80" cy="186" r="5" fill="#dc2626"/>
  <circle cx="360" cy="186" r="7" fill="#dc2626"/>
  <circle cx="500" cy="186" r="7" fill="#dc2626"/>

  <g font-family="system-ui, sans-serif" font-size="12" fill="#dc2626">
    <text x="46" y="120">Terragon</text>
    <text x="300" y="64">Vibe Kanban</text>
    <text x="466" y="120">Roo Code</text>
  </g>
  <g font-family="system-ui, sans-serif" font-size="10" fill="#8a8a8a">
    <text x="46" y="104">shut down Feb 9</text>
    <text x="300" y="48">27,867 stars · $7.4M raised</text>
    <text x="300" y="32">"couldn't find a business model"</text>
    <text x="466" y="104">24,332 stars · archived</text>
  </g>

  <g stroke="#a3e635" stroke-width="1.5">
    <line x1="220" y1="186" x2="220" y2="240"/>
    <line x1="370" y1="186" x2="370" y2="292"/>
    <line x1="530" y1="186" x2="530" y2="240"/>
    <line x1="770" y1="186" x2="770" y2="240"/>
  </g>
  <g fill="#a3e635">
    <circle cx="220" cy="186" r="6"/><circle cx="370" cy="186" r="6"/>
    <circle cx="530" cy="186" r="6"/><circle cx="770" cy="186" r="6"/>
  </g>
  <g font-family="system-ui, sans-serif" font-size="12" fill="#a3e635">
    <text x="186" y="258">Conductor</text>
    <text x="336" y="310">Factory</text>
    <text x="496" y="258">Cognition / Devin</text>
    <text x="720" y="258">Cognition again</text>
  </g>
  <g font-family="system-ui, sans-serif" font-size="10" fill="#8a8a8a">
    <text x="186" y="274">$22M Series A</text>
    <text x="336" y="326">$150M Series C at $1.5B</text>
    <text x="496" y="274">$492M ARR</text>
    <text x="720" y="274">talks at $40B</text>
  </g>
</svg>
<figcaption>Same category, same eighteen months. The dividing line is not quality or traction — it is whether the product sat inside the payment flow. Funding figures are from secondary sources.</figcaption>
</figure>

### Why: the orchestrator sits outside the money

<figure class="artifact-figure artifact-figure-diagram">
<svg viewBox="0 0 900 380" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Two diagrams contrasting how dollars flow through Vercel and Supabase versus how they bypass an agent orchestrator entirely">
  <defs>
    <marker id="ar" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="#a3e635"/>
    </marker>
    <marker id="arg" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="#5a5a5a"/>
    </marker>
  </defs>

  <text x="16" y="24" font-family="system-ui, sans-serif" font-size="12" font-weight="700" fill="#8a8a8a">WHAT WORKED — the dollar passes THROUGH the product</text>

  <rect x="16" y="44" width="150" height="52" rx="4" fill="#141414" stroke="#3a3a3a"/>
  <rect x="290" y="44" width="180" height="52" rx="4" fill="#1a2e05" stroke="#4d7c0f"/>
  <rect x="600" y="44" width="180" height="52" rx="4" fill="#141414" stroke="#3a3a3a"/>
  <line x1="172" y1="70" x2="282" y2="70" stroke="#a3e635" stroke-width="2" marker-end="url(#ar)"/>
  <line x1="476" y1="70" x2="592" y2="70" stroke="#5a5a5a" stroke-width="2" marker-end="url(#arg)"/>

  <g font-family="system-ui, sans-serif" font-size="12" fill="#e4e4e4">
    <text x="32" y="68">Developer</text>
    <text x="306" y="68">Vercel · Supabase</text>
    <text x="616" y="68">AWS / raw compute</text>
  </g>
  <g font-family="system-ui, sans-serif" font-size="10" fill="#8a8a8a">
    <text x="32" y="84">pays $X / month</text>
    <text x="306" y="84">keeps the margin</text>
    <text x="616" y="84">gets the remainder</text>
  </g>
  <text x="196" y="62" font-family="ui-monospace, monospace" font-size="11" fill="#a3e635">$X</text>
  <text x="500" y="62" font-family="ui-monospace, monospace" font-size="11" fill="#8a8a8a">$X − margin</text>

  <text x="16" y="152" font-family="system-ui, sans-serif" font-size="12" font-weight="700" fill="#8a8a8a">WHAT HAPPENS HERE — the dollar goes around the product</text>

  <rect x="16" y="172" width="150" height="52" rx="4" fill="#141414" stroke="#3a3a3a"/>
  <rect x="290" y="172" width="180" height="52" rx="4" fill="#1a1a1a" stroke="#3a3a3a" stroke-dasharray="3 3"/>
  <rect x="600" y="172" width="180" height="52" rx="4" fill="#141414" stroke="#3a3a3a"/>
  <line x1="476" y1="198" x2="592" y2="198" stroke="#5a5a5a" stroke-dasharray="3 3" marker-end="url(#arg)"/>
  <path d="M91,228 L91,296 L690,296 L690,230" fill="none" stroke="#a3e635" stroke-width="2" marker-end="url(#ar)"/>

  <g font-family="system-ui, sans-serif" font-size="12" fill="#e4e4e4">
    <text x="32" y="196">Developer</text>
    <text x="306" y="196">the orchestrator</text>
    <text x="616" y="196">Anthropic / OpenAI</text>
  </g>
  <g font-family="system-ui, sans-serif" font-size="10" fill="#8a8a8a">
    <text x="32" y="212">pays $200 / month</text>
    <text x="306" y="212">runs the CLI, holds no key</text>
    <text x="616" y="212">captures the subscription</text>
    <text x="486" y="184" font-size="9">spawns the process</text>
  </g>
  <text x="306" y="248" font-family="system-ui, sans-serif" font-size="11" fill="#dc2626">$0 passes through</text>
  <text x="250" y="290" font-family="ui-monospace, monospace" font-size="11" fill="#a3e635">$200 — never touches the orchestrator</text>

  <g font-family="system-ui, sans-serif" font-size="11" fill="#8a8a8a">
    <text x="16" y="336">The orchestrator improves the experience of a subscription it does not sell, bill, or resell.</text>
    <text x="16" y="356">No metered unit means the model that funded Vercel and Modal is unavailable by construction.</text>
  </g>
</svg>
<figcaption>Vercel and Modal resell compute at a margin. An agent orchestrator on BYO-subscription resells nothing — that is what "$0 passes through" describes, and it is the situation today. It is not a claim that no fee is collectable: OpenRouter charges 5% of routed value even in bring-your-own-key mode, without ever holding the payment. What the diagram forecloses is the inference margin, not metering.</figcaption>
</figure>

### The escape route: meter what only exists when there is a team

<figure class="artifact-figure artifact-figure-wide">
<svg viewBox="0 0 900 280" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Two columns comparing what one developer needs, which SSH already provides free, against what a team needs, which requires a hosted layer">
  <rect x="16" y="40" width="420" height="216" rx="6" fill="#141414" stroke="#3a3a3a"/>
  <rect x="464" y="40" width="420" height="216" rx="6" fill="#1a2e05" stroke="#4d7c0f"/>

  <text x="36" y="68" font-family="system-ui, sans-serif" font-size="13" font-weight="700" fill="#8a8a8a">ONE DEVELOPER, OWN MACHINES</text>
  <text x="484" y="68" font-family="system-ui, sans-serif" font-size="13" font-weight="700" fill="#a3e635">A TEAM OF 5–50</text>

  <g font-family="system-ui, sans-serif" font-size="11" fill="#6a6a6a">
    <text x="36" y="88">SSH already solves this. Free, Apache-2.0.</text>
    <text x="484" y="88">SSH into other people's laptops does not.</text>
    <text x="484" y="104">Hosted, ~$20–40 / seat.</text>
  </g>

  <g font-family="system-ui, sans-serif" font-size="12" fill="#c9c9c9">
    <text x="36" y="124">· run any of 17 harnesses</text>
    <text x="36" y="150">· sessions, teams, worktrees</text>
    <text x="36" y="176">· secrets in the OS keychain</text>
    <text x="36" y="202">· browser + computer control</text>
    <text x="36" y="228">· dispatch across your own boxes</text>

    <text x="484" y="132">· shared session history across people</text>
    <text x="484" y="158">· who spent what, on which repo</text>
    <text x="484" y="184">· shared secrets with a principal model</text>
    <text x="484" y="210">· audit trail of what agents did</text>
    <text x="484" y="236">· SSO</text>
  </g>

</svg>
<figcaption>The seam is not a feature line — it is the point where a second human appears. Everything on the right is coordination state, not inference, which is why the model vendors have no reason to give it away.</figcaption>
</figure>

### What this means for the number to watch

Vibe Kanban's 27,867 stars were not the achievement that mattered, and chasing the
same number is chasing the metric that preceded three shutdowns. The number that
distinguishes a survivable business here is **paying teams**, whose leading
indicator is retained multi-seat usage.

For agi-cli that reduces to one concrete target: twenty people outside this fleet
who ran it on two separate days in one week, and whom you can contact. Below that,
no pricing question is answerable. Above it, the team-tier bet becomes testable
against real humans — and `RUSH-2581` (*"No human-identity substrate: SSO/SAML
cannot attach because there is no principal model"*) is the engineering
prerequisite for every item in the right-hand column above. It currently sits in
Backlog, which is the correct priority only under the reading that agi-cli is
distribution rather than the business.
