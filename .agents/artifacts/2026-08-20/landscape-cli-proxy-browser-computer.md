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

Five findings, one per section:

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
4. **The stack under all of this has nine layers, and the one directly
   beneath the tool surfaces has commoditized.** Three sandbox vendors — E2B,
   Daytona and Blaxel — quote the identical `$0.0828`/hour for 1 vCPU / 2 GB
   while running three different isolation technologies, and the 150x spread
   across the layer is a product spread, not an efficiency one: what separates
   a $1 agent from a $152 one is idle policy, not hardware. Section 7 maps
   every layer, normalizes fourteen vendors' published rates to one comparable
   unit, and decomposes how a $1/mo agent price is actually constructed.
5. **The three-legged combination does not exist anywhere else.** Claude Code
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
| OpenRouter | One API over 374+ models; `no markup on inference pricing`, a `5.5% ($0.80 minimum)` fee on credit purchases | 8M developers, 8.4T tokens/mo | $140M annualized rev (Jul 2026), $174M raised | Stripe acquisition reported at $7B+ (unconfirmed by either party) |
| Portkey | AI gateway + observability | 24k+ orgs, 125M req/day | $18M raised | Reported acquired by Palo Alto Networks (single aggregator source, uncorroborated — see Evidence) |
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

### 7. The full stack — nine layers, and what each one actually sells

The five sections above answer "who else does what we do?" one category at a
time. This one zooms out to the whole stack, because two of the categories
above (browser, computer use) only make sense as *tool surfaces* sitting on top
of layers this report had not yet named — and because the layer directly under
them, sandbox compute, has quietly converged on a single price.

<figure>
<svg viewBox="0 0 760 400" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="The nine-layer agent stack in 2026 and the key players occupying each layer">
  <rect x="588" y="34" width="162" height="330" rx="8" fill="none" stroke="#888888" stroke-width="1" stroke-dasharray="4 3"/>
  <text x="598" y="26" font-family="monospace" font-size="11" font-weight="600" fill="#84a929">CROSS-CUTTING</text>
  <text x="598" y="62" font-family="monospace" font-size="12" font-weight="700" fill="currentColor">MEMORY</text>
  <text x="598" y="80" font-size="11" fill="currentColor">Mem0 · Zep · Letta</text>
  <text x="598" y="96" font-size="11" fill="currentColor">Supermemory</text>
  <text x="598" y="132" font-family="monospace" font-size="12" font-weight="700" fill="currentColor">OBSERVABILITY</text>
  <text x="598" y="150" font-size="11" fill="currentColor">LangSmith · Langfuse</text>
  <text x="598" y="166" font-size="11" fill="currentColor">Braintrust · Helicone</text>
  <text x="598" y="182" font-size="11" fill="currentColor">Arize · W&amp;B Weave</text>
  <text x="598" y="222" font-size="11" fill="#888888">Both layers attach at</text>
  <text x="598" y="238" font-size="11" fill="#888888">every tier, and both are</text>
  <text x="598" y="254" font-size="11" fill="#888888">the most likely to be</text>
  <text x="598" y="270" font-size="11" fill="#888888">absorbed into the model</text>
  <text x="598" y="286" font-size="11" fill="#888888">providers' own platforms.</text>
  <text x="20" y="26" font-family="monospace" font-size="11" font-weight="600" fill="#84a929">CLOSEST TO THE USER</text>

  <rect x="10" y="34" width="566" height="30" rx="4" fill="none" stroke="#84a929" stroke-width="1.5"/>
  <text x="22" y="53" font-family="monospace" font-size="12" font-weight="700" fill="#84a929">ORCHESTRATION</text>
  <text x="200" y="53" font-size="12" fill="currentColor">agi-cli · Conductor · Terragon · Sculptor · (Vibe Kanban)</text>

  <rect x="10" y="70" width="566" height="30" rx="4" fill="none" stroke="#84a929" stroke-width="1.5"/>
  <text x="22" y="89" font-family="monospace" font-size="12" font-weight="700" fill="#84a929">TOOL SURFACES</text>
  <text x="200" y="89" font-size="12" fill="currentColor">Browserbase · Steel · agent-browser · UI-TARS · H Company</text>

  <rect x="10" y="106" width="566" height="30" rx="4" fill="none" stroke="#888888" stroke-width="1"/>
  <text x="22" y="125" font-family="monospace" font-size="12" font-weight="700" fill="currentColor">HARNESSES</text>
  <text x="200" y="125" font-size="12" fill="currentColor">Claude Code · Codex · Gemini CLI · Cursor · Droid</text>

  <rect x="10" y="142" width="566" height="30" rx="4" fill="none" stroke="#888888" stroke-width="1"/>
  <text x="22" y="161" font-family="monospace" font-size="12" font-weight="700" fill="currentColor">FRAMEWORKS</text>
  <text x="200" y="161" font-size="12" fill="currentColor">LangGraph · CrewAI · OpenAI Agents SDK · Mastra</text>

  <rect x="10" y="178" width="566" height="30" rx="4" fill="none" stroke="#888888" stroke-width="1"/>
  <text x="22" y="197" font-family="monospace" font-size="12" font-weight="700" fill="currentColor">GATEWAYS</text>
  <text x="200" y="197" font-size="12" fill="currentColor">OpenRouter · LiteLLM · Portkey · Requesty · CF AI Gateway</text>

  <rect x="10" y="214" width="566" height="30" rx="4" fill="none" stroke="#888888" stroke-width="1"/>
  <text x="22" y="233" font-family="monospace" font-size="12" font-weight="700" fill="currentColor">MODELS</text>
  <text x="200" y="233" font-size="12" fill="currentColor">Anthropic · OpenAI · Google · xAI · DeepSeek · Qwen</text>

  <rect x="10" y="250" width="566" height="30" rx="4" fill="none" stroke="#888888" stroke-width="1"/>
  <text x="22" y="269" font-family="monospace" font-size="12" font-weight="700" fill="currentColor">AGENT HOSTING</text>
  <text x="200" y="269" font-size="12" fill="currentColor">Maritime · Bedrock AgentCore · CF Agents/DO · Blaxel</text>

  <rect x="10" y="286" width="566" height="30" rx="4" fill="none" stroke="#888888" stroke-width="1"/>
  <text x="22" y="305" font-family="monospace" font-size="12" font-weight="700" fill="currentColor">SANDBOX RUNTIME</text>
  <text x="200" y="305" font-size="12" fill="currentColor">E2B · Daytona · Modal · Fly · Vercel · Northflank</text>

  <rect x="10" y="322" width="566" height="30" rx="4" fill="none" stroke="#888888" stroke-width="1"/>
  <text x="22" y="341" font-family="monospace" font-size="12" font-weight="700" fill="currentColor">CLOUD &amp; SILICON</text>
  <text x="200" y="341" font-size="12" fill="currentColor">AWS · GCP · Azure · Hetzner · Railway Metal</text>

  <text x="20" y="374" font-size="11" fill="#84a929">Lime border = the two layers agi-cli occupies. It consumes the seven below and sells none of them.</text>
</svg>
<figcaption>The 2026 agent stack. Value concentrates at the model layer and at the two ends; the middle layers are either commoditizing on price (sandbox), consolidating by acquisition (gateways), or unmonetized (frameworks, orchestration).</figcaption>
</figure>

| Layer | What it sells | How it's priced | State in 2026 |
| --- | --- | --- | --- |
| Orchestration | Running *many* agents at once | Mostly nothing — OSS | Thin, unmonetized, high mortality |
| Tool surfaces | Browser-hours, desktop control | $/hour, or bundled free | Being absorbed by the incumbents (§3, §4) |
| Harnesses | The coding agent itself | Seat subscription, `$20`/mo anchor | Incumbent-dominated, model-vendor-owned |
| Frameworks | Authoring abstractions | Free (OSS) | Monetized one layer up, not here |
| Gateways | One API + spend control | % markup or seat | **Consolidating by acquisition** (§1) |
| Models | Tokens | $/M tokens | Oligopoly; the profit pool |
| Agent hosting | "Your agent stays reachable" | Flat/agent or usage | Fragmenting; hyperscalers entering |
| Sandbox runtime | Isolated execution | $/vCPU-hr + $/GB-hr | **Price-converged, commoditizing** |
| Cloud & silicon | Raw capacity | $/instance-hr | Commodity |

#### 7a. The sandbox layer has converged on one price

Normalizing every published rate to the same unit — **1 vCPU / 2 GB RAM, run
continuously for a 730-hour month** — makes the convergence visible. Rates were
read from each vendor's own pricing page on 2026-08-20 and the monthly figure
is arithmetic on the quoted rate, not a vendor claim.

| Vendor | Isolation | $/hour | $/month | Idle behavior |
| --- | --- | --- | --- | --- |
| Maritime | Undisclosed (site says micro-VM, docs say containers) | — | **$1.00** | Sleeps; always-on add-on is `$20/agent/month` |
| Northflank | Kata / gVisor | $0.033 | **$24.33** | Pause-stops-billing not published |
| Fly Machines (`performance-1x`) | Firecracker | $0.045 | **$32.19**† | Stopped/suspended = storage only |
| Morph | Undisclosed | $0.050 | **$36.50** | Scale-to-zero; `under 250ms` live-VM branch |
| CodeSandbox SDK (Together) | microVM (secondary source) | $0.074 | **$54.31** | Hibernates; billing-stop unconfirmed |
| Daytona | **Linux containers by default** | $0.083 | **$60.44** | Stopped/paused = reserved disk only |
| Blaxel | Firecracker | $0.083 | **$60.44** | Suspend stops billing; `about 25ms` resume |
| E2B | Firecracker | $0.083 | **$60.44** usage-only | Pause stops compute; 1-hr session cap off Pro pushes real cost to **~$210** |
| LangGraph Platform (LangSmith Deployment) | Managed (n/a) | $0.086 | **$62.42** + `$39` seat | Standby billed per minute — not scale-to-zero |
| Cloudflare Containers | VM, hypervisor undisclosed | $0.090 | **$65.70**‡ + `$5` plan | `Charges stop after the container instance goes to sleep` |
| Bedrock AgentCore | Firecracker | $0.108 | **$79.13** | `I/O wait and idle time is free` — memory still billed for the session |
| Modal Sandbox | **gVisor** | $0.119–$0.190 | **$86.85–$138.65** | Scales to zero; no pause/resume for Sandboxes |
| Vercel Sandbox | Firecracker | $0.042–$0.170 | **$30.95–$124.39** | Active-CPU only — LLM wait time is not metered |
| Railway Sandboxes | Undisclosed | $0.208 | **$152.08** | `Idle sandboxes still consume resources that we bill for` |

† Fly publishes this figure itself, on its own 720-hour billing month; at the
730 hours every other row uses it is $32.85. ‡ The rate alone gives $65.70;
Cloudflare's included allowances (375 vCPU-minutes and 25 GiB-hours a month)
net some of that back, so a real bill lands slightly under it. Every other row
is the quoted rate times 730, and the $/hour column is rounded to three
decimals for reading — the monthly figures are computed from the unrounded
rate, so re-multiplying the displayed hourly reproduces them only to within
about half a percent.

Modal and Vercel carry ranges for opposite reasons: Modal bills *physical cores*
and never publishes the core-to-vCPU ratio, so the row is genuinely ambiguous;
Vercel bills only CPU cycles actually burned, so its floor is a memory-only
charge and its ceiling assumes 100% CPU. For an agent that spends its life
waiting on a model, Vercel's floor is the realistic number and its headline is
not.

Three things fall out of that table:

- **Three vendors land on exactly $0.0828/hour** — E2B, Daytona, and Blaxel,
  identical to the fourth decimal (`$0.0504`/vCPU-hr + `$0.0162`/GiB-hr). They
  do not share an implementation: E2B and Blaxel run Firecracker microVMs,
  Daytona's own docs say `Sandboxes run as Linux containers by default`. The
  price converged even though the technology did not, which is the clearest
  possible signal that the buyer is not choosing on isolation.
- **The 150× spread — $1 at Maritime to $152.08 at Railway — is a product
  spread, not an efficiency one.** (Among the metered vendors alone, Northflank
  to Railway is 6.25×; the rest of the gap is Maritime's flat sleep price.)
  Nobody is 150× more efficient than anyone else. Northflank and Fly sell raw
  provisioned-VM hours with no agent premium; Railway prices its sandbox tier at
  2.5–5× its own standard compute; Vercel and AgentCore meter only active CPU;
  and Maritime sells the *sleep* rather than the compute.
- **Idle policy is the whole ballgame, and Railway is the outlier.** An agent
  spends most of its wall-clock waiting on a model, so the vendors that don't
  bill that wait are cheaper in practice than their headline. Railway is the
  only one of the fourteen with **no pause primitive at all** — its idle timeout
  *destroys* the sandbox rather than suspending it. That is not a footnote for
  the next section: if Maritime runs on Railway Sandboxes, then
  checkpoint-destroy-restore is not a clever optimization it chose, it is the
  only shape Railway offers.

#### 7b. How a $1 agent is actually constructed

Maritime is the useful worked example, because its price looks impossible until
you decompose it. Measured on 2026-08-20: `maritime.sh` and `api.maritime.sh`
both resolve to `*.up.railway.app` and answer with `server: railway-hikari` and
`x-railway-edge: lax1` on **AS400940 Railway** — its control plane is a Next.js
app on Railway, not AWS. Its advertised agent is `1 vCPU, 2 GB RAM, 5 GB SSD`,
which on Railway Sandboxes' own `$50/month per GB of memory or vCPU` is **$150 a
month run continuously**. It sells for $1.

The gap is closed by three things, and they generalize to the whole hosting
layer:

1. **You bring your own model key.** The expensive part of running an agent is
   never on the hosting bill. Every vendor in this layer is selling a socket and
   a filesystem, not inference.
2. **Sleeping is nearly free, and Railway ships the primitive.** Railway
   Sandboxes support *checkpoints* — `a named snapshot of a sandbox's disk,
   stored server-side` — so the pattern is checkpoint, destroy, and boot from
   the checkpoint on the next webhook. $150/mo × 0.7% duty cycle ≈ $1, and 0.7%
   is about ten minutes a day: exactly a low-traffic webhook bot.
3. **The flat price is an average, not a cost.** It is gym-membership pricing,
   and the vendor prices the exception honestly: turning off sleep costs
   `$20/agent/month`, a **20x** step up from the $1 headline. That ratio is the
   duty-cycle assumption made visible. It is also why the tiers meter agent
   count rather than compute.

One correction this decomposition forces: a disk checkpoint is not a memory
snapshot. Firecracker-style restore resumes a process mid-execution; booting
from a disk image re-runs the framework's init. So nothing in RAM survives a
sleep, and the real wake latency for a heavy agent is its own Python imports and
graph construction, not the ~1s the platform advertises. Vendors that publish a
sub-second wake are measuring the hypervisor, not your agent.

#### 7c. The cross-cutting layers: one is being bought, one is still unsolved

Memory and observability attach at every tier of the figure, and in 2026 they
are moving in opposite directions.

**Observability is being absorbed — by telemetry incumbents, not by the model
labs.** Arize was acquired by Dynatrace on 2026-08-13 for `$915 million`
(~`$815 million in cash` plus replacement equity, per Dynatrace's own release);
Langfuse was acquired by ClickHouse in January 2026; Helicone went to Mintlify
in March 2026. The buyers are data and APM platforms folding LLM traces into an
existing one-pane-of-glass product — the same absorption that happened to APM a
decade ago. Braintrust is the notable holdout, independent after an `$80M`
Series B at a reported `$800 million` valuation.

**Memory is the one layer nobody has consolidated**, and six incompatible
architectures are alive simultaneously: an extraction-and-dedup layer above the
vector store (Mem0, `$24M` raised, 63.7k stars), a bi-temporal knowledge graph
(Zep/Graphiti), OS-style editable memory blocks (Letta, `$10 million seed`), a
storage-agnostic SDK (LangMem), a hybrid memory graph (Supermemory), and a
freshly funded three-layer unifier (Cognee, `$7.5 million seed`, February 2026).
Fresh seed money still entering on genuinely different designs is the signal
that the problem is unsettled rather than won.

The ordering matters for anyone building here: **observability > gateways >
memory**, most consolidated to least. Two of those three are being bought by
incumbents who already own an adjacent platform — which is the same dynamic
§7d describes at the orchestration layer, and §3 and §4 describe at the tool
surfaces. The pattern repeats at every layer that lacks its own metered unit.

#### 7d. The orchestration layer's mortality rate is the thesis, stated by the dead

The top row of the figure is the thinnest, and 2026 supplied the obituaries.
Vibe Kanban — a Kanban UI dispatching work to Claude Code, Codex, Gemini CLI and
Copilot — shut down on 2026-04-10, and its own post names the cause without
hedging: `the vast majority are free users and we couldn't find a business model
that we could get excited about`. Terragon, the cloud equivalent, went earlier;
its repo now carries the banner `This repository is an open-source snapshot of
Terragon at the time of shutdown`, snapshot dated 2026-01-16, and describes
itself in the past tense.

| Product | Shape | Status |
| --- | --- | --- |
| Vibe Kanban | Hosted UI + cloud tier | **Sunset 2026-04-10**; survives as a community fork |
| Terragon | Cloud orchestrator, sandboxes + auto-PR | **Sunset**, snapshot 2026-01-16 |
| Windsurf | IDE | **Absorbed** — `windsurf.com/pricing` 308-redirects to `devin.ai/pricing` |
| Conductor | Mac app, local worktrees, BYO subscription | Alive |
| Sculptor (Imbue) | Mac app, local Docker containers | Alive, `free while in beta` |
| Dagger container-use | OSS MCP server, per-agent containers | Alive |

The survivors share one trait the casualties lacked: **they run no hosted
backend**. Conductor, Sculptor, and container-use are thin local wrappers over
agents the user already pays for somewhere else, so they carry no infrastructure
cost to fund and offer nothing for a vendor to switch off. Everything in this
layer that owned real cloud spend either died or was bought.

Meanwhile the frontier labs are absorbing the function natively — Claude Code
now ships its own subagents and parallel agent teams — which removes the reason
to buy a third-party orchestrator at all. That is the same commoditization
pressure §3 and §4 documented for browser and desktop control, arriving one
layer higher.

This is the honest counterweight to §6's whitespace finding. The orchestration
layer is empty of funded competitors, and the reason is visible in the
obituaries: it is empty because it is hard to charge for, not because nobody
thought of it. A local-first, no-backend posture is what the survivors have in
common, and it is the posture agi-cli already has.

#### 7e. Where agi-cli sits

Two layers, and it sells neither of the seven beneath it. It occupies
**orchestration** (running many harnesses at once, §5) and the local half of
**tool surfaces** (§3, §4). It does not sell sandbox compute, hosting, gateway
routing, or memory — it consumes them, or runs on hardware the user already
owns, which is the same thing from a cost perspective.

The layer immediately below orchestration shows what happens when a layer has
no unit to sell. CrewAI removed its `$25/month` Professional tier in spring 2026,
leaving a free tier capped at `50 workflow executions/month` and an
Enterprise contact-sales path with nothing in between; LangChain, on $260M
raised and a $1.25B valuation, monetizes not the framework but the seats and
compute units *around* it. Frameworks are distribution, not revenue.

That is a deliberate position with one real consequence worth stating: the
layers with money in them (models, gateways, sandbox compute) are all layers
agi-cli routes *around* rather than taxes. The stack map does not change the
whitespace finding in §6 — it explains why the whitespace was left open. Nobody
funded builds at the orchestration layer because there is no metered unit to
sell there, and the tool surfaces below it are being given away by companies
that monetize elsewhere.


## Evidence

### How the numbers were gathered

Section 7 addendum (2026-08-20): every rate in the normalized sandbox table
was read from the vendor's own published pricing page that day — e2b.dev/pricing,
modal.com/pricing, daytona.io/pricing, fly.io/docs/about/pricing,
developers.cloudflare.com/containers/pricing, vercel.com/docs/sandbox/pricing,
docs.railway.com/sandboxes, aws.amazon.com/bedrock/agentcore/pricing,
langchain.com/pricing, maritime.sh/pricing. The $/hour and $/month columns are
arithmetic on those quoted rates at 730 hours, not vendor claims. Maritime's
infrastructure was measured directly by DNS and HTTP header probe
(`up.railway.app` CNAMEs, `server: railway-hikari`, `x-railway-edge: lax1`,
AS400940) rather than taken from any disclosure.

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
- **Section 7 gaps.** Morph's `$36.50` is computed from its published MCU
  formula (`MCUs = max(vCPUs, ceil(RAM/4GiB), ceil(disk/16GiB))` at a
  `standard MCU rate of $0.05`), not a vendor-published instance price. Modal's
  row is the shakiest in the table: it bills physical cores and does not publish
  a core-to-vCPU ratio. CodeSandbox SDK's isolation and cold-start profile rest
  on one secondary source because codesandbox.io returned 403.
- **Isolation columns are asymmetric in strength.** Firecracker is confirmed by
  first-party docs for E2B, Fly, Vercel, Blaxel and AgentCore, and gVisor for
  Modal. Daytona's `Linux containers by default` is its own docs. Railway,
  Cloudflare and Morph name no hypervisor at all.
- **Neither Railway nor Maritime discloses a hypervisor.** Railway documents a
  "virtual machine primitive" with server-side disk checkpoints and names no
  hypervisor; Maritime's marketing says micro-VM while its own docs say
  "serverless containers." That Maritime runs agent compute on Railway
  Sandboxes is an inference that fits every observable (control plane measured
  on Railway, checkpoint primitive, SSH claim, the $150→$1 duty-cycle math) —
  it is not confirmed by either company.
- **§7c's acquisitions vary in source strength.** Dynatrace/Arize (`$915
  million`, 2026-08-13) is from Dynatrace's own press release and is primary.
  ClickHouse/Langfuse and Mintlify/Helicone come from trade coverage and were
  not re-confirmed against the acquirers' releases.
- **§1's Portkey line was overstated and is now hedged.** The Palo Alto Networks
  acquisition is carried by a single aggregator (Tracxn) and could not be
  corroborated on PANW's own press page in this pass; the date also differs
  between sources (2026-05-29 vs 2026-06-01). Treat it as reported, not
  confirmed.
- **OpenRouter's fee was restated in §1.** It publishes `there is no markup on
  inference pricing` and charges `5.5% ($0.80 minimum)` on credit purchases —
  a different mechanism from the inference markup the earlier draft implied.
- **Orchestration acquisitions are reported, not primary.** OpenAI/Ona,
  Cursor/Continue, and a reported SpaceX-Cursor transaction all come from trade
  coverage in this pass and were not confirmed against either party; they are
  omitted from §7d's table for that reason. The three status claims that *are*
  primary — Vibe Kanban's shutdown post, Terragon's repo banner, and the live
  `windsurf.com` 308 redirect — are the ones quoted.
- Harness seat prices (`$20`/mo anchor) were read from vendor pricing pages,
  but several second-tier figures in that sweep (Cursor Pro+/Ultra, Gemini Code
  Assist paid tiers, Copilot Business) resolved only to aggregators; no
  individual harness price is relied on in §7 beyond the anchor.
- LangGraph Platform's per-node and per-minute standby rates circulate via a
  third-party blog; `docs.langchain.com/langsmith/pricing` 404'd. The LCU/LSU
  rates quoted in §7a are from langchain.com/pricing and are primary.

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
