---
kind: plan
template: plan.v1
surface: internal
title: 30 days to a demo, not a new company
summary: Raise next month. Freeze the story, demo software you already have, talk to a handful of AI services firms, and collect pilots or LOIs. Do not rebuild Prix or sell tokens or deliverables.
status: draft
header: Phoenix Horizon
footer: Internal · 30-day raise
links:
  - url: https://byphoenix.com
    label: byphoenix.com
  - url: https://prix.dev
    label: prix.dev
  - url: https://linear.app/getrush/issue/RUSH-2650
    label: RUSH-2650
---

## Focus for review

1. **Two audiences, two sentences.** Investors hear the thesis. A firm hears a tool they can try this month. Mixing those is why the site feels confusing.
2. **Do not sell tokens. Do not sell “the finished work.”** Those are not the purchase. The purchase, if it exists, is operator software for a firm that already has Claude.
3. **The 30-day artifact is a demo + conversations, not a product rewrite.** prix.dev still contradicts the homepage; hide or re-label that path. Do not spend the month on an SDK.
4. **Three named conversations beat a category slide.** Foaster, flowscope, Fed10 (research/diligence). Ask how they get paid today. The LOI comes from that, or it does not come.

## Purpose

You have about 30 days before a raise. You need something a partner can watch and a firm can sign. This plan is that month: freeze the money story, film a demo from Rush + AGI CLI as they exist, talk to a short list, paper a one-page pilot. It is not a new runtime, not a registry relaunch, and not outcome billing.

## Current architecture

Two live sites, two buyers, one raise. Money stories got stacked on top of each other.

<figure class="artifact-figure artifact-figure-wide artifact-figure-diagram">
<svg viewBox="0 0 940 420" role="img" aria-label="Three money stories that got mixed, and which one can exist this month" xmlns="http://www.w3.org/2000/svg">
  <text x="24" y="28" font-family="JetBrains Mono, monospace" font-size="11" fill="#8a8a8a" letter-spacing="0.08em">WHO PAYS WHOM</text>

  <rect x="20" y="48" width="280" height="150" rx="12" fill="#1a0e0e" stroke="#fb7185" stroke-width="1.5"/>
  <text x="40" y="76" font-family="JetBrains Mono, monospace" font-size="11" fill="#fb7185">1 · TOKENS</text>
  <text x="40" y="102" font-family="Inter, system-ui, sans-serif" font-size="14" fill="#e9edf0">Labs get paid to run</text>
  <text x="40" y="124" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">Anthropic / OpenAI / OpenRouter</text>
  <text x="40" y="150" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">Not your business. Site already</text>
  <text x="40" y="168" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">says bring-your-own compute.</text>

  <rect x="330" y="48" width="280" height="150" rx="12" fill="#16120a" stroke="#f5c451" stroke-width="1.5"/>
  <text x="350" y="76" font-family="JetBrains Mono, monospace" font-size="11" fill="#f5c451">2 · DELIVERABLES</text>
  <text x="350" y="102" font-family="Inter, system-ui, sans-serif" font-size="14" fill="#e9edf0">Thesis, not a checkout</text>
  <text x="350" y="124" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">Homepage table: client buys</text>
  <text x="350" y="142" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">“the finished work.” Firms today</text>
  <text x="350" y="160" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">bill retainers, cases, hours.</text>
  <text x="350" y="178" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">Do not productize this in 30d.</text>

  <rect x="640" y="48" width="280" height="150" rx="12" fill="#0f160a" stroke="#a3e635" stroke-width="2"/>
  <text x="660" y="76" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">3 · TOOLS  ← this month</text>
  <text x="660" y="102" font-family="Inter, system-ui, sans-serif" font-size="14" fill="#e9edf0">A firm pays for software</text>
  <text x="660" y="124" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">They already pay Anthropic</text>
  <text x="660" y="142" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">and maybe Cursor / Modal.</text>
  <text x="660" y="160" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">Phoenix can only charge for</text>
  <text x="660" y="178" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">a tool they do not have yet.</text>

  <line x1="160" y1="198" x2="160" y2="230" stroke="#fb7185" stroke-width="1.5" opacity="0.5"/>
  <line x1="470" y1="198" x2="470" y2="230" stroke="#f5c451" stroke-width="1.5" opacity="0.5"/>
  <line x1="780" y1="198" x2="780" y2="230" stroke="#a3e635" stroke-width="1.5"/>

  <rect x="20" y="230" width="900" height="168" rx="12" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="40" y="258" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">WHAT EXISTS ON DISK TODAY</text>
  <text x="40" y="286" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#e9edf0">Rush — Mac app. You run agents, approve, get a file out. Built for a person.</text>
  <text x="40" y="310" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#e9edf0">AGI CLI — live. Fleet, sessions, browser, secrets. Built for a person running many agents.</text>
  <text x="40" y="334" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#e9edf0">Prix — registry + proxy + cloud run. Live site still says sealed containers and a waitlist.</text>
  <text x="40" y="368" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#9aa4ad">byphoenix.com describes firms and finished work. The software is still operator tools. That split is the raise risk, and also the demo: show the tools, tell the thesis, do not pretend they are the same purchase.</text>
</svg>
<figcaption>Investors can hear box 2 as destination. A pilot will only pay for box 3. Box 1 is someone else’s meter.</figcaption>
</figure>

The market around those tools is already taken in the layers a firm already bought.

<figure class="artifact-figure artifact-figure-wide artifact-figure-diagram">
<svg viewBox="0 0 940 340" role="img" aria-label="Occupied layers versus the leftover a services firm might still lack" xmlns="http://www.w3.org/2000/svg">
  <text x="24" y="28" font-family="JetBrains Mono, monospace" font-size="11" fill="#8a8a8a" letter-spacing="0.08em">OCCUPIED  ·  THEY ALREADY HAVE THIS</text>

  <rect x="20" y="48" width="170" height="88" rx="8" fill="#16120a" stroke="#5a636b" stroke-width="1.5"/>
  <text x="36" y="74" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#e9edf0">Models</text>
  <text x="36" y="96" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">Anthropic · OpenAI</text>
  <text x="36" y="114" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">direct</text>

  <rect x="204" y="48" width="170" height="88" rx="8" fill="#16120a" stroke="#5a636b" stroke-width="1.5"/>
  <text x="220" y="74" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#e9edf0">The loop</text>
  <text x="220" y="96" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">they wrote it, or</text>
  <text x="220" y="114" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">Claude Code</text>

  <rect x="388" y="48" width="170" height="88" rx="8" fill="#16120a" stroke="#5a636b" stroke-width="1.5"/>
  <text x="404" y="74" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#e9edf0">Compute</text>
  <text x="404" y="96" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">laptop · VPS</text>
  <text x="404" y="114" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">Modal · E2B</text>

  <rect x="572" y="48" width="170" height="88" rx="8" fill="#16120a" stroke="#5a636b" stroke-width="1.5"/>
  <text x="588" y="74" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#e9edf0">Coding delivery</text>
  <text x="588" y="96" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">Cursor · Codex</text>
  <text x="588" y="114" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">Factory · Cognition</text>

  <rect x="756" y="48" width="164" height="88" rx="8" fill="#16120a" stroke="#5a636b" stroke-width="1.5"/>
  <text x="772" y="74" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#e9edf0">Chat / tickets</text>
  <text x="772" y="96" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">Slack · Linear</text>
  <text x="772" y="114" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">Google Docs</text>

  <rect x="20" y="168" width="900" height="148" rx="12" fill="#0f160a" stroke="#a3e635" stroke-width="2"/>
  <text x="40" y="198" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">UNTESTED LEFTOVER  ·  NOT A STACK REPLACEMENT</text>
  <text x="40" y="228" font-family="Inter, system-ui, sans-serif" font-size="15" fill="#e9edf0">Work from their agents, for one client, that a person can stand behind.</text>
  <text x="40" y="256" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#9aa4ad">Not “replace Modal.” Not “pay per PDF.” A place the run, the file, and the approval live together so the next job for that client is not another Slack dump.</text>
  <text x="40" y="288" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#9aa4ad">Rush already shows runs and approvals. Artifact share already hands someone a file. That is the demo. Per-client isolation and a signed pilot come after someone wants it.</text>
</svg>
<figcaption>Do not enter occupied boxes. The leftover is a hypothesis until two firms say it out loud.</figcaption>
</figure>

## Proposed Changes

No code this month except what the demo forces (a Prix link that does not dump a partner onto a waitlist). The change is what you show and what you ask.

<figure class="artifact-figure artifact-figure-wide artifact-figure-diagram">
<svg viewBox="0 0 940 360" role="img" aria-label="Thirty calendar days from freeze to raise materials" xmlns="http://www.w3.org/2000/svg">
  <text x="24" y="28" font-family="JetBrains Mono, monospace" font-size="11" fill="#8a8a8a" letter-spacing="0.08em">30 DAYS</text>

  <rect x="20" y="48" width="220" height="280" rx="12" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="40" y="76" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">DAYS 1–4</text>
  <text x="40" y="104" font-family="Inter, system-ui, sans-serif" font-size="16" fill="#e9edf0">Freeze + film</text>
  <text x="40" y="132" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">Two sentences, written down.</text>
  <text x="40" y="150" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">Record a 8–12 min demo</text>
  <text x="40" y="168" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">on Rush + AGI CLI as they sit.</text>
  <text x="40" y="196" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">Phoenix “Explore Prix” must</text>
  <text x="40" y="214" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">not open the old waitlist pitch.</text>
  <text x="40" y="242" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">One-page pilot terms.</text>
  <text x="40" y="260" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">List of 8 people to mail.</text>

  <rect x="256" y="48" width="220" height="280" rx="12" fill="#0e1418" stroke="#c9a962" stroke-width="1.5"/>
  <text x="276" y="76" font-family="JetBrains Mono, monospace" font-size="11" fill="#c9a962">DAYS 5–14</text>
  <text x="276" y="104" font-family="Inter, system-ui, sans-serif" font-size="16" fill="#e9edf0">Talk</text>
  <text x="276" y="132" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">8 conversations. Not 25.</text>
  <text x="276" y="150" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">Foaster · flowscope · Fed10</text>
  <text x="276" y="168" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">plus warm 1st-degrees.</text>
  <text x="276" y="196" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">Ask only: what do you sell,</text>
  <text x="276" y="214" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">how are you paid, where do</text>
  <text x="276" y="232" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">agents sit, would you pay</text>
  <text x="276" y="250" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">for anything that is not a</text>
  <text x="276" y="268" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">model and not a sandbox.</text>

  <rect x="492" y="48" width="220" height="280" rx="12" fill="#0e1418" stroke="#6ee7b7" stroke-width="1.5"/>
  <text x="512" y="76" font-family="JetBrains Mono, monospace" font-size="11" fill="#6ee7b7">DAYS 15–22</text>
  <text x="512" y="104" font-family="Inter, system-ui, sans-serif" font-size="16" fill="#e9edf0">Concierge</text>
  <text x="512" y="132" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">If someone leans in: run</text>
  <text x="512" y="150" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">one real job on their stack.</text>
  <text x="512" y="168" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">You operate. They watch.</text>
  <text x="512" y="196" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">If nobody leans in: do not</text>
  <text x="512" y="214" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">invent a customer. Tighten</text>
  <text x="512" y="232" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">the demo with what they said</text>
  <text x="512" y="250" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">and keep meeting.</text>

  <rect x="728" y="48" width="192" height="280" rx="12" fill="#0f160a" stroke="#a3e635" stroke-width="2"/>
  <text x="748" y="76" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">DAYS 23–30</text>
  <text x="748" y="104" font-family="Inter, system-ui, sans-serif" font-size="16" fill="#e9edf0">Paper</text>
  <text x="748" y="132" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">Pilot one-pager or LOI.</text>
  <text x="748" y="150" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">Same 12 min for investors.</text>
  <text x="748" y="168" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">Deck: thesis + demo +</text>
  <text x="748" y="186" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">named conversations.</text>
  <text x="748" y="214" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">No fabricated MRR.</text>
  <text x="748" y="250" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">Founding team is still</text>
  <text x="748" y="268" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9aa4ad">an open ticket (2650).</text>
</svg>
<figcaption>The month is conversations and a tape, not a Prix rewrite.</figcaption>
</figure>

<div class="artifact-callout artifact-callout-warn">
<strong>Write these two sentences on day 1 and do not mix them.</strong>
<p><em>Investor:</em> Services firms will run on infrastructure. We are building that.</p>
<p><em>Firm:</em> You already have Claude. This is the Mac + CLI we use to run a fleet, keep the session, and hand a person a file they can approve. Try it on one job.</p>
</div>

## Public Interface

What a partner sees in twelve minutes. All of it already runs.

```text
0:00  Homepage thesis, 20 seconds. Then: "here is the software, not the slide."
0:30  AGI CLI: agents run / sessions --active on a real fleet. BYO model.
3:00  Rush: one research run (Rabbit Hole or equivalent) on a named topic.
7:00  Artifact out — a share link, not a chat transcript.
9:00  Approval in Rush (needs-you / approve). Operator stands behind it.
11:00 Stop. Ask them how they get paid today. Do not pitch outcomes billing.
```

The only product edit this month is the Phoenix Prix path. Everything else is a meeting and a tape.

```diff title=phoenix/web/app/page.tsx
@@ Explore Prix CTA @@
-<a href="https://prix.dev">Explore Prix →</a>
+<a href="/prix">Runtime, memory, BYO model →</a>
 // /prix on byphoenix.com: one screen, no waitlist, no Lovable comparison.
```

What they must not see:

| Surface | Problem | 30-day move |
|---|---|---|
| prix.dev waitlist / sealed containers | App-store buyer, contradicts Phoenix | Phoenix CTA goes to a one-screen “runtime + memory, BYO model” note, or is removed |
| “Clients buy the finished work” as a SKU | Not how firms invoice | Keep it on the thesis slide only |
| Token markup | Not the business | Do not mention OpenRouter margin |
| Software-delivery beachhead | Cursor / Factory / Cognition | Do not demo “merged PRs as the product” |

Pilot paper, if anyone asks, is one page:

```text
Pilot: 2 weeks, one client job, we operate.
You keep Anthropic. We do not resell tokens.
You do not pay until you want a second job.
LOI: "we will run a paid pilot of $X / month if the first job is usable."
X is whatever they say. $0 LOIs still count as named demand if they name a date.
```

## Plan

- [ ] **Day 1.** Write the two sentences. Stop using “deliverable checkout” and “token resale” in customer copy.
- [ ] **Day 1–2.** Film the 12-minute demo on zion from Rush + AGI CLI. Real run, real share link, real approve.
- [ ] **Day 2.** Phoenix “Explore Prix” no longer lands on the waitlist / Lovable comparison. Smallest possible page or unlink.
- [ ] **Day 3.** One-page pilot terms. Mail list of 8: Foaster, flowscope, Fed10, plus five 1st-degree warm names. No 1,221-contact blast.
- [ ] **Day 5–14.** Eight calls. Same four questions every time. Log answers in one place.
- [ ] **Day 15–22.** At most one concierge job. If zero interest, do not fake a design partner.
- [ ] **Day 23–30.** Investor cut of the same tape. Deck traction slide = conversations + any LOI, not catalog installs. Decide RUSH-2650 before Sequoia-facing paper.

## Validation

A raise packet is real if all of these are true:

```bash
# Demo is a file you can play without a live cluster gamble
ls ~/Desktop/phoenix-12min.* 

# Prix path from the company site does not waitlist
curl -sL https://byphoenix.com/prix | grep -i waitlist   # expect empty

# Conversations exist as notes, not intent
# 8 rows: firm, paid-how-today, agents-where, would-pay-for
```

| Gate | Pass | Fail |
|---|---|---|
| Tape | 12 min, software on screen, one approval | Slide-only, or Prix waitlist |
| Calls | ≥5 completed, answers written | “We should talk to 25 later” |
| LOI / pilot | Signed paper or a dated “yes to a second job” | Verbal “cool” |
| Story | Investor sentence ≠ customer sentence | Homepage table sold as the product |

## Risks

| Risk | Why it hits a 30-day raise | Mitigation |
|---|---|---|
| Nobody wants operator tools | Then the leftover is not a purchase. That is data. | Put it on the deck as learning, not as fake traction |
| You spend the month on Prix/SDK | Zero calls, zero tape | No Prix features except the CTA fix |
| Founding team still open | Solo + $0 MRR caps the story (existing valuation notes) | RUSH-2650 is a founder call this week, not a slide |
| prix.dev stays the old product | First diligence click kills the thesis | Unlink it from Phoenix until copy matches |
| Software-delivery demo | Looks like a worse Factory | Research-firm job only |

## Tracking

- [byphoenix.com](https://byphoenix.com) — thesis site, three firm types, stack diagram
- [prix.dev](https://prix.dev) — still sealed-container / waitlist (fix or unlink)
- [RUSH-2650](https://linear.app/getrush/issue/RUSH-2650) — founding team before Sequoia-facing docs
- Aug 14 refocus brief — buyer moved; evaluator-facing product did not
- This session — positioning reset: tokens and deliverable-pricing are not the 30-day sale
