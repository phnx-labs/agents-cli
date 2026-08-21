---
kind: report
template: report.v1
title: 'The adjacent categories: CLI proxies, browser agents, computer use — and the combination nobody ships'
summary: 'Follow-up to the GTM report, answering "who else is doing this?" across the three categories agi-cli touches. The proxy category splits into a real API-gateway market (OpenRouter at $140M annualized revenue) and a subscription-arbitrage graveyard Anthropic actively enforces against. Browser and computer use are being commoditized by the incumbents into their own desktop apps, while no funded company sells the local, your-own-machine variant. And no product anywhere combines multi-harness orchestration with built-in browser and desktop control.'
status: draft
human: author
host: fleet-worker
session: n/a
links:
  - label: 'Companion: agi-cli GTM report (same date)'
    url: 'https://github.com/phnx-labs/agents-cli/blob/main/.agents/artifacts/2026-08-20/gtm-strategy.md'
  - label: 'Companion: why the biggest orchestrators died'
    url: 'https://github.com/phnx-labs/agents-cli/blob/main/.agents/artifacts/2026-08-20/why-orchestrators-die.md'
  - label: 'RUSH-2834 — launch: freeze the name, run the 48-hour ignition'
    url: 'https://linear.app/phnx/issue/RUSH-2834'
---

## Summary

This answers the question that closed the GTM session: *"can you dig deeper and
find other products that are similar, like CLI proxy?"* — plus the two categories
that ride along with it (browser automation and computer use), and whether anyone
combines all three.

Four findings, one per section:

1. **"CLI proxy" is two categories wearing one name.** API-key gateways
   (OpenRouter, LiteLLM, Portkey) are a real, monetized, acquired-at-a-premium
   market. Subscription-token proxies (claude-code-router's credential pools,
   relay services) are a donation-funded grey zone that Anthropic has been
   actively shutting down since February 2026. The tell is what flows through
   the proxy: API keys you pay for, or consumer OAuth tokens you multiplex.
2. **Browser automation for agents consolidated into two survivable shapes** —
   cloud infrastructure sold per browser-hour (Browserbase leads), and browser
   control bundled into the incumbents' own subscriptions (Claude for Chrome,
   ChatGPT agent mode). Nobody funded sells the third shape, the one `agents
   browser` ships: local automation of the user's own logged-in browser. The
   only serious analog is Vercel's open-source agent-browser, which is free.
3. **Computer use hit its production inflection in 2026** (Fable 5 at 85%
   OSWorld-Verified vs a ~72% human baseline), and the crowded lane is cloud
   screenshot loops. Local accessibility-tree control as a developer primitive
   is nearly empty: the closest projects are two small macOS apps (319 and 577
   stars) and a record-replay tool. Nothing is CLI-driven, cross-platform, and
   wired into a coding-agent workflow.
4. **The three-legged combination does not exist anywhere else.** Claude Code
   and Codex now bundle browser + desktop control, but desktop-app-only and
   single-model by construction. Manus and Devin run both legs in a cloud VM.
   Nothing else is multi-harness. The moat claim from the GTM report survives
   this deeper pass, sharpened: the moat is not any one leg — the incumbents
   are commoditizing legs 2 and 3 in real time — it is the combination, local,
   under one CLI, across 17 active harnesses.

The strategic consequence is in Recommendations: this evidence strengthens the
corpus thesis rather than replacing it, and it puts a date on how long the
tool-surface lead lasts.

## Findings

Every number marked ★ was read live from the GitHub or npm API on 2026-08-20;
unmarked traction and revenue figures come from secondary sources (trade press,
Sacra, Dealroom) and are not independently verified.

### 1. CLI proxies and model routers — the direct answer

**The API-gateway side is a real market:**

| Product | What it is | Traction | Money | Outcome |
| --- | --- | --- | --- | --- |
| OpenRouter | One API over 374+ models, 5% markup | 8M developers, 8.4T tokens/mo | $140M annualized rev (Jul 2026), $174M raised | Stripe acquisition reported at $7B+ (unconfirmed by either party) |
| Portkey | AI gateway + observability | 24k+ orgs, 125M req/day | $18M raised | **Acquired by Palo Alto Networks, 2026-05-29** |
| LiteLLM (BerriAI) | OSS gateway, 100+ providers | 56,861★ GitHub | $7M ARR, open-core ($250/mo → $30k/yr enterprise) | Independent, YC-backed |

The pattern across all three: the OSS or cheap tier is distribution; revenue is
enterprise controls (SSO, audit, RBAC, SLAs) or a usage markup. Nobody here
charges developers a seat fee — consistent with the graveyard finding in the
companion report.

**The subscription-proxy side has traction without a business:**

| Project | What it is | Traction | Money |
| --- | --- | --- | --- |
| musistudio/claude-code-router | Local proxy in front of Claude Code; per-scenario routing; credential pools | 36,773★, 470,355 npm downloads/mo ★ | Donations + AI-lab sponsors |
| Wei-Shaw/claude-relay-service | Relay pooling Claude/OpenAI/Gemini subscription tokens, explicit cost-splitting ("拼车") | 12,537★ ★ | None (operators resell) |
| claude-swap | Rotates between CLAUDE_CONFIG_DIR profiles on rate-limit | 1,861★ ★ | None |
| teamclaude | Multi-account quota-rotation proxy | 258★ ★ | None |
| pal-mcp-server (ex zen-mcp) | MCP server for cross-model calls mid-session, own API keys | 11,726★ ★ | None |

A 36k-star router with 470k monthly downloads and a donations link is the
category in one line: enormous demand, no monetization surface, because the
value being captured is someone else's subscription pricing.

### 2. The enforcement timeline is the proxy category's ceiling

Assembled from secondary sources (a policy explainer, a ToS analysis, and trade
coverage — links in Evidence); the two dated policy events are corroborated
across multiple independent writeups:

- **Sep 2025 – Feb 2026:** progressive tightening — entity restrictions, phone
  verification, then a February ban wave against 24/7 multi-account use,
  account sharing, and resale, reportedly without warning.
- **2026-04-04:** Anthropic blocks consumer OAuth tokens in third-party tools
  at the server. OpenClaw was the named casualty; Goose, Roo Code, and OpenCode
  clients were also cut off. Using the *official* `claude` binary anywhere
  (local, VPS, CI) remained permitted.
- **2026-06-15 (reported):** billing bifurcation — headless/agentic usage
  (`claude -p`, Agent SDK, GitHub Actions) reportedly moved off subscription
  quota onto dollar-denominated credits at API list prices, with interactive
  terminal sessions staying on subscription. Sourced to one blog analysis;
  verify against Anthropic's own billing docs before relying on it.

The architectural line Anthropic has drawn, per the analysis that named it: a
**relay server** multiplexing extracted OAuth tokens gets banned; **N separate
official-client installs, each with its own documented `CLAUDE_CONFIG_DIR`**
was acknowledged as legitimate in anthropics/claude-code#261. agi-cli's
balanced rotation is the second architecture — owned accounts, official
binaries, per-profile isolation, no relay. That is the defensible side of the
line, but two exposures remain: automated rotation could be framed as limit
evasion in a future ban wave, and if the June billing split is accurate, the
fleet's headless workloads already pay API-equivalent prices — meaning
rotation's remaining value is rate-limit smoothing on interactive sessions, not
price arbitrage. The GTM report's advice not to build the business on rotation
gets independent confirmation here.

### 3. Browser automation — cloud infra or bundled incumbent, nothing local

<figure>
<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Three shapes of browser automation in 2026">
  <rect x="10" y="30" width="235" height="270" rx="8" fill="none" stroke="#888888" stroke-width="1" stroke-dasharray="4 3"/>
  <rect x="262" y="30" width="235" height="270" rx="8" fill="none" stroke="#888888" stroke-width="1" stroke-dasharray="4 3"/>
  <rect x="514" y="30" width="235" height="270" rx="8" fill="none" stroke="#888888" stroke-width="1" stroke-dasharray="4 3"/>
  <text x="24" y="20" font-family="monospace" font-size="14" font-weight="600" fill="#84a929">CLOUD INFRA (funded)</text>
  <text x="276" y="20" font-family="monospace" font-size="14" font-weight="600" fill="#84a929">BUNDLED (incumbents)</text>
  <text x="528" y="20" font-family="monospace" font-size="14" font-weight="600" fill="#84a929">LOCAL CLI (unfunded)</text>
  <text x="24" y="60" font-family="monospace" font-size="15" font-weight="700" fill="currentColor">Browserbase</text>
  <text x="24" y="80" font-size="13" fill="currentColor">$300M val · $3M+ ARR</text>
  <text x="24" y="98" font-size="13" fill="currentColor">50M sessions/yr</text>
  <text x="24" y="126" font-family="monospace" font-size="15" font-weight="700" fill="currentColor">Steel.dev</text>
  <text x="24" y="146" font-size="13" fill="currentColor">$17M raised · ~$3.5M ARR</text>
  <text x="24" y="174" font-family="monospace" font-size="15" font-weight="700" fill="currentColor">Hyperbrowser · Anchor</text>
  <text x="24" y="194" font-size="13" fill="currentColor">YC W25 · $6M seed</text>
  <text x="24" y="222" font-size="12" fill="#888888">Sell browser-hours ($0.10/hr).</text>
  <text x="24" y="240" font-size="12" fill="#888888">Moat: fingerprinting, CAPTCHA,</text>
  <text x="24" y="258" font-size="12" fill="#888888">anti-bot. Cloud-only by design.</text>
  <text x="276" y="60" font-family="monospace" font-size="15" font-weight="700" fill="currentColor">Claude for Chrome</text>
  <text x="276" y="80" font-size="13" fill="currentColor">bundled in Max/Team</text>
  <text x="276" y="108" font-family="monospace" font-size="15" font-weight="700" fill="currentColor">ChatGPT agent mode</text>
  <text x="276" y="128" font-size="13" fill="currentColor">Atlas browser killed 2026-08,</text>
  <text x="276" y="146" font-size="13" fill="currentColor">folded into ChatGPT Work</text>
  <text x="276" y="174" font-family="monospace" font-size="15" font-weight="700" fill="currentColor">Perplexity Comet</text>
  <text x="276" y="194" font-size="13" fill="currentColor">$200M raised, consumer bet</text>
  <text x="276" y="222" font-size="12" fill="#888888">Browser control as a feature of</text>
  <text x="276" y="240" font-size="12" fill="#888888">a subscription you already pay.</text>
  <text x="276" y="258" font-size="12" fill="#888888">Standalone browsers are dying.</text>
  <text x="528" y="60" font-family="monospace" font-size="15" font-weight="700" fill="currentColor">agent-browser (Vercel)</text>
  <text x="528" y="80" font-size="13" fill="currentColor">~41k★ · Rust CLI · free</text>
  <text x="528" y="98" font-size="13" fill="currentColor">a11y-tree refs, local Chrome</text>
  <text x="528" y="126" font-family="monospace" font-size="15" font-weight="700" fill="currentColor">browser-use (the library)</text>
  <text x="528" y="146" font-size="13" fill="currentColor">97k★ · local CDP path exists,</text>
  <text x="528" y="164" font-size="13" fill="currentColor">commercial push is cloud</text>
  <text x="528" y="192" font-family="monospace" font-size="15" font-weight="700" fill="currentColor">agents browser</text>
  <text x="528" y="212" font-size="13" fill="currentColor">this repo — user's own</text>
  <text x="528" y="230" font-size="13" fill="currentColor">logged-in profiles</text>
  <text x="528" y="258" font-size="12" fill="#888888">No funded company here.</text>
  <text x="528" y="276" font-size="12" fill="#888888">Open-source territory.</text>
</svg>
<figcaption>The 2026 browser-automation map: every funded startup sells cloud browser-hours; the incumbents bundle browser control into subscriptions; the local lane — automating the user's own logged-in browser from a CLI — has no commercial occupant.</figcaption>
</figure>

The category's 2026 story in three moves:

- **The standalone agent browser died.** OpenAI's Atlas launched mid-2025 and
  was deprecated 2026-08-09, folded into ChatGPT Work. Browser control survives
  as a *feature* of an existing subscription, not a product.
- **Cloud infra survived but narrowed.** Browserbase ($68M raised, $300M
  valuation, 1,000+ paying companies, 50M sessions in 2025, >$3M ARR) leads;
  Steel and Hyperbrowser are real but smaller. Their differentiation is
  exactly what local automation doesn't need: stealth fingerprinting, CAPTCHA
  solving, IP rotation.
- **The local lane is open-source, not venture.** Vercel's agent-browser (~41k
  stars) validates the exact design `agents browser` uses — accessibility-tree
  refs instead of raw DOM, local Chrome, CLI-first — and it is free. For
  logged-in SaaS work, internal tools, and coding workflows, local wins on
  cost, latency, and privacy; that is the segment agi-cli occupies, and it is
  a segment nobody monetizes directly.

### 4. Computer use — production-viable since February, and the local a11y lane is empty

The a16z data report (2026-08-10) marks the inflection: models weren't
production-viable for computer use until Opus 4.6 in February 2026; Fable 5 now
scores 85% on OSWorld-Verified against a ~72% human baseline, and deployed
agents benchmark at $6–8/hour against $10/hour offshore BPO. The market is
real as of this year, not speculative.

Who occupies it:

| Cohort | Who | State |
| --- | --- | --- |
| Cloud screenshot loops | Anthropic computer-use API, OpenAI Codex CU (desktop-app only), H Company Holo3 ($220M seed), Simular ($26.5M), e2b desktop | Active, funded, all screenshot-first, all cloud-or-app |
| Abandoned 2024 cohort | Self-Operating-Computer (10,287★ ★, last push 2025-09-19), Open Interpreter (68k★ ★ but pivoted to a coding agent) | Stalled or pivoted |
| Alive OSS | UI-TARS-desktop (38,659★ ★, ByteDance, screenshot+vision), OpenAdapt (1,690★ ★, record-replay, a11y-first, pushed 2026-08-20) | Active |
| Local accessibility-tree | Fazm (319★ ★, macOS AXUIElement + ScreenCaptureKit fallback), macOS26/Agent (577★ ★, Swift), computer-use-linux (AT-SPI, niche) | Tiny, single-platform |

The structural read: the funded players all run screenshot loops server-side,
because that is what scales to a cloud product. The accessibility-tree
approach — structured element refs, deterministic targeting, no
screenshot-per-step token bill — only exists in small local projects, and none
of them is a cross-platform CLI primitive. `agents computer` (Swift/AXUIElement
daemon on macOS, C#/UI Automation daemon on Windows, element-ref mode, driven
from the same CLI as the agents) has no direct competitor in either the funded
or the OSS cohort. The nearest things are a 319-star voice assistant and a
record-replay compiler.

### 5. The multi-harness layer — everyone stops one tier below

The ecosystem around "many coding agents" resolves into two tiers, neither of
which is what agi-cli does:

- **Tier 1, config sync:** rulesync (1,330★ ★, active, syncs rules/MCP/commands
  into 20+ tools' native formats) and the AGENTS.md standard itself (Linux
  Foundation-stewarded, 60k+ repos claimed). These write config files. They
  cannot install, version, or run anything.
- **Tier 2, model-agnostic single harnesses:** OpenCode (171k★, 75+ providers),
  Charm Crush (27,531★ ★), Pi. "Model-agnostic" here means one harness calling
  many model APIs — they *replace* Claude Code and Codex rather than manage
  them. Notably, Anthropic's OAuth enforcement cut these clients off from
  subscription accounts; they run on API keys.
- SuperClaude (23,836★ ★) is the largest config framework and is Claude
  Code-only. The "run several CLIs side by side" tools that show up in
  editorial roundups (Parallel Code, Worktrunk) either lack a verifiable
  primary source or manage worktrees, not agents.

Install + version + config-sync + execute across 17 active harnesses through
one engine — the thing `agents run` does — has no verified occupant besides
this repo, same as the 21-tool sweep in the GTM report found at the
orchestrator level.

### 6. The convergence verdict

The question that motivated this pass: does anyone combine (1) multi-harness
orchestration, (2) built-in browser automation, (3) native computer use?

| Product | Multi-harness | Browser | Computer use | Local / CLI-first |
| --- | --- | --- | --- | --- |
| Claude Code | No — Claude only | Desktop app only (Jul 2026, sandboxed clean profile) | Research preview, Pro/Max (Vercept tech) | Partial — CLI gets neither leg |
| OpenAI Codex | No — OpenAI only | Desktop app only | Desktop app only (macOS Apr, Windows May 2026) | No — CLI/Linux excluded |
| Manus | No (internal sub-agents) | Cloud VM | Partial ("My Computer", cloud-first) | No |
| Devin (Cognition) | No | Cloud sandbox | Cloud sandbox; CLI remote-controls the cloud agent | No |
| Google Antigravity CLI | No — Gemini only | Model-level (Gemini 3.5 Flash native computer use) | Model-level, desktop in testing | Partial |
| **agi-cli** | **17 active harnesses** | **CLI-native, user's own profiles** | **Native a11y daemons, both desktops** | **Yes** |

Two honest readings of this table, and both matter:

- **The whitespace is real and survived a second, deeper look.** Nothing —
  incumbent, funded startup, or OSS — ships all three legs, and nothing else
  ships *any* leg in the local, CLI-first, your-own-machine form.
- **Legs 2 and 3 are commoditizing fast, from above.** In the four months from
  April to July 2026, both Anthropic and OpenAI shipped browser and desktop
  control inside their own apps. The incumbents will not do multi-harness —
  single-model is their business model — but they are absorbing the tool
  surfaces. A moat made only of "we have browser and computer use" has a
  measurable half-life. The durable leg is the one structurally closed to
  them: being the neutral layer over *all* the harnesses, and owning the
  cross-harness session corpus that accumulates there.

## Evidence

### How the numbers were gathered

Primary reads (2026-08-20): GitHub REST API (`api.github.com/repos/...`) for
every ★-marked star count, fork count, and last-push date; npm downloads API
(`api.npmjs.org/downloads/point/last-month/@musistudio/claude-code-router` →
470,355) for router adoption. Fifteen research passes across five parallel
agents; each claim in Findings carries its source class inline.

### Secondary sources that carry weight

- Sacra (OpenRouter revenue, developer counts, acquisition report)
- Dealroom (LiteLLM ARR and seed), Yahoo Finance / Tracxn (Portkey raise and
  Palo Alto acquisition), Upstarts Media / AIM (Browserbase Series B, session
  volume), YC company pages (browser-use, Hyperbrowser)
- a16z, "Can agents use a computer yet? We've got the data" (2026-08-10) —
  OSWorld scores, production deployments, $/hour benchmarks
- dev.to/vainamoinen, "Two multi-account Claude Code architectures — one
  Anthropic accepts, one they ban" — the Architecture A/B distinction and
  anthropics/claude-code#261
- help.apiyi.com policy explainer and explainx.ai timeline (April 4 OAuth
  cutoff, February ban wave, KYC rollout)
- ppc.land and nerova.ai (Atlas deprecation into ChatGPT Work)
- apiscout.dev and TrueFoundry pricing guides (browser-hour and gateway tiers)

### What could not be verified

- OpenRouter's reported Stripe acquisition ($7B+): unconfirmed by either party.
- The 2026-06-15 subscription/API billing bifurcation: single secondary
  source; verify against Anthropic's billing docs before treating as fact.
- Star counts quoted without the ★ mark (browser-use ~97k, OpenCode 171k,
  agent-browser ~41k, UI-TARS research repo 27k) come from company pages or
  editorial coverage, not a live API read.
- Steel.dev ARR (~$3.5M) is a third-party estimate published at low confidence.
- "Parallel Code" as a multi-CLI runner: editorial mentions only; no repo or
  package was found. Treated as nonexistent for the tier analysis above.
- Claude Code's computer-use research preview and the Vercept attribution rest
  on trade coverage (devops.com), not an Anthropic changelog entry.

## Recommendations

1. **Keep the moat claim, but restate it.** The defensible sentence is not "we
   have browser and computer use" (the incumbents are shipping both) — it is
   "one CLI that runs every harness and gives all of them the same local
   browser and desktop hands, on your machines, with your logins." No product
   in either cohort can say that sentence, and the incumbents' business models
   prevent them from the first clause.
2. **Do not build revenue on rotation or any proxy mechanics.** The
   subscription-proxy side of the router category is enforcement-limited with
   a documented ban history, and the June billing split (if confirmed) removed
   the economics anyway. agi-cli's Architecture-B posture is the right side of
   the line; keep it a convenience feature, never the pitch.
3. **The tool-surface lead has a half-life measured in months, not years.**
   April → July 2026 took the incumbents from zero to bundled browser + desktop
   control in their own apps. Treat legs 2 and 3 as the demo that makes the
   launch impressive, and the cross-harness corpus (the companion report's Act
   3) as the asset the lead is supposed to buy time for.
4. **Watch agent-browser.** Vercel validating the local a11y-ref browser design
   at 41k stars is both confirmation and a warning: the nearest thing to
   `agents browser` is free, well-distributed, and one `vercel agents` launch
   away from being bundled into a bigger story. Differentiation stays at the
   combination level, not the single tool.
