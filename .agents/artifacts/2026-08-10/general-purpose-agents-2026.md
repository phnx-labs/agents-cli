---
kind: report
title: Best General-Purpose Agents — OpenClaw, Hermes, Cursor (Aug 2026)
summary: Evidence-backed comparison of always-on personal agents (OpenClaw, Hermes) versus coding agents (Cursor, Claude Code), with GitHub stats, recent releases, community likes/dislikes, and the models people actually run.
header: Phoenix Labs / Research
footer: Community + repo audit · not a product endorsement
project: agents-cli
context: agent landscape research
repository: phnx-labs/agents-cli
branch: artifact-gp-agents-report
status: research complete
harness: cursor
agent: composer
host: yosemite-s0
date: "2026-08-10"
facts:
  - OpenClaw ~385k stars · Hermes ~225k stars
  - Category split coding vs always-on personal
  - Kilo ~1,300 Reddit comments analyzed
  - Models verified via GitHub + OpenRouter + community
links:
  - url: https://github.com/openclaw/openclaw
    label: openclaw/openclaw
  - url: https://github.com/NousResearch/hermes-agent
    label: hermes-agent
  - url: https://kilo.ai/openclaw/vs-hermes
    label: Kilo Reddit analysis
  - url: https://docs.openclaw.ai
    label: OpenClaw docs
  - url: https://hermes-agent.nousresearch.com/docs/
    label: Hermes docs
---

## Summary

There is no single best general-purpose agent. The market has split into two product classes that share branding but not jobs:

| Job | Best fit | Why |
| --- | --- | --- |
| Interactive coding in an IDE | **Cursor Agent** | Best day-one editor UX; Cloud Agents for async PRs |
| Deep terminal coding | **Claude Code** | Strongest long-horizon coding quality in most 2026 reviews |
| Always-on personal agent | **Hermes or OpenClaw** | Model-agnostic gateways with messaging, cron, memory |
| Background self-improving loops | **Hermes** (edge) | Learning loop + memory are the core pitch |
| Largest skill marketplace / channels | **OpenClaw** (edge) | ClawHub + broadest messaging surface |

Experienced operators converge on a stack, not a winner: **Cursor or Claude Code for code**, plus **Hermes and/or OpenClaw for everything else**.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg class="artifact-diagram" viewBox="0 0 1080 420" role="img" aria-label="Agent landscape map splitting coding agents from always-on personal agents">
  <rect x="20" y="20" width="1040" height="380" rx="14" fill="#090c0f" stroke="#303840" stroke-width="1.5"/>

  <text x="50" y="55" font-family="JetBrains Mono, monospace" font-size="12" fill="#38bdf8">CODING AGENTS</text>
  <rect x="50" y="70" width="300" height="130" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="70" y="100" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">Cursor Agent</text>
  <text x="70" y="122" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">IDE · autocomplete · Cloud Agents / PRs</text>
  <text x="70" y="142" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">best day-one coding UX</text>
  <text x="70" y="172" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">Claude Code</text>
  <text x="70" y="194" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">terminal · deep multi-file · MCP</text>

  <text x="390" y="55" font-family="JetBrains Mono, monospace" font-size="12" fill="#a3e635">ALWAYS-ON PERSONAL</text>
  <rect x="390" y="70" width="300" height="130" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="410" y="100" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">OpenClaw</text>
  <text x="410" y="122" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">~385k★ · ClawHub · multi-channel</text>
  <text x="410" y="142" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">ecosystem breadth · update fragility</text>
  <text x="410" y="172" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">Hermes Agent</text>
  <text x="410" y="194" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">~225k★ · learning loop · memory</text>

  <text x="730" y="55" font-family="JetBrains Mono, monospace" font-size="12" fill="#f59e0b">OPERATOR STACK</text>
  <rect x="730" y="70" width="300" height="130" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="750" y="105" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">1. Code with Cursor / Claude Code</text>
  <text x="750" y="130" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">2. Live ops via Hermes / OpenClaw</text>
  <text x="750" y="155" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">3. Route models by cost × quality</text>
  <text x="750" y="180" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">~20% of Reddit power users run both gateways</text>

  <path d="M350 135 L390 135" stroke="#38bdf8" stroke-width="2" stroke-dasharray="5 5" opacity="0.8"/>
  <path d="M690 135 L730 135" stroke="#a3e635" stroke-width="2" stroke-dasharray="5 5" opacity="0.8"/>

  <text x="50" y="240" font-family="JetBrains Mono, monospace" font-size="11" fill="#8a8a8a">COMMUNITY SPLIT (r/openclaw · ~1,300 comments · Kilo)</text>
  <rect x="50" y="255" width="230" height="110" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="70" y="290" font-family="Inter, system-ui, sans-serif" font-size="22" fill="#a3e635">35%</text>
  <text x="70" y="320" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">stay on OpenClaw</text>
  <text x="70" y="340" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">skills · cron · ecosystem</text>

  <rect x="300" y="255" width="230" height="110" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="320" y="290" font-family="Inter, system-ui, sans-serif" font-size="22" fill="#f59e0b">30%</text>
  <text x="320" y="320" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">switched to Hermes</text>
  <text x="320" y="340" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">setup · memory · fewer breaks</text>

  <rect x="550" y="255" width="230" height="110" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="570" y="290" font-family="Inter, system-ui, sans-serif" font-size="22" fill="#38bdf8">20%</text>
  <text x="570" y="320" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">run both</text>
  <text x="570" y="340" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">orchestrate + execute</text>

  <rect x="800" y="255" width="230" height="110" rx="8" fill="#1a1010" stroke="#ff6b6b" stroke-width="1.5"/>
  <text x="820" y="290" font-family="Inter, system-ui, sans-serif" font-size="22" fill="#ff6b6b">15%</text>
  <text x="820" y="320" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">distrust Hermes</text>
  <text x="820" y="340" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">astroturf / hype noise</text>
</svg>
<figcaption>Read left to right: coding agents and personal gateways are different jobs; the Reddit sample is split, not crowned.</figcaption>
</figure>

<section class="artifact-grid artifact-grid-3">
  <div class="artifact-stat">
    <span class="artifact-stat-value">~385k</span>
    <span class="artifact-stat-label">OpenClaw GitHub stars (Aug 2026)</span>
  </div>
  <div class="artifact-stat">
    <span class="artifact-stat-value">~225k</span>
    <span class="artifact-stat-label">Hermes GitHub stars (Aug 2026)</span>
  </div>
  <div class="artifact-stat">
    <span class="artifact-stat-value">#1</span>
    <span class="artifact-stat-label">Hermes on OpenRouter daily tokens (May 2026 peak)</span>
  </div>
</section>

<div class="artifact-callout"><strong>Bottom line:</strong> for a new always-on personal agent, start with <strong>Hermes</strong> (memory + setup + recent reliability story). Keep or add <strong>OpenClaw</strong> when you need ClawHub skills or channel breadth. Do not replace Cursor / Claude Code with either for production coding.</div>

## Findings

### Category mistake to avoid

Cursor Agent, Hermes, and OpenClaw are often compared as peers. They are not. Cursor (and Claude Code / Codex) optimize for software engineering loops. Hermes and OpenClaw optimize for persistent, multi-channel, scheduled personal/ops agents. Ranking them on one axis produces a wrong answer.

### Live repo snapshot (GitHub API, Aug 2026)

| | OpenClaw | Hermes |
| --- | --- | --- |
| Repo | [openclaw/openclaw](https://github.com/openclaw/openclaw) | [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) |
| Stars | ~385,049 | ~224,884 |
| Forks | ~80,934 | ~43,570 |
| Language | TypeScript | Python |
| Latest stable | `v2026.7.1` (Jul 13) | `v0.20.0` / `v2026.8.3` (Aug 3, Herald) |
| Latest pre | `v2026.7.2-beta.7` (Aug 2) | — |
| License | MIT-style | MIT |

OpenClaw still has the larger installed base. Hermes has been catching up on OpenRouter token volume (reported ~224B tokens/day vs OpenClaw ~186B around May 10, 2026).

### What people like and hate

<section class="artifact-grid artifact-grid-2">
  <article class="artifact-panel">
    <h3>OpenClaw — likes</h3>
    <ul>
      <li>Largest skill ecosystem (ClawHub ~13k+ skills)</li>
      <li>Meets you in WhatsApp / Telegram / Discord / Slack / Signal / iMessage</li>
      <li>Native iOS / Android / macOS apps + Control UI feel productized</li>
      <li>Deterministic cron praised by long-time users</li>
      <li>Coding-agent bridges (<code>openclaw attach</code>, Codex / Copilot delegation)</li>
    </ul>
  </article>
  <article class="artifact-panel">
    <h3>OpenClaw — hates</h3>
    <ul>
      <li>Update fragility (top Reddit complaint; ~25% break risk quoted by users)</li>
      <li>Security history (early-2026 CVE wave; exposed gateways; ClawHub malware audits)</li>
      <li>Docs lag during fast ship weeks</li>
      <li>Runaway cost / retry loops; gateway memory leaks in open issues</li>
      <li>Silent failures when you are not watching</li>
    </ul>
  </article>
  <article class="artifact-panel">
    <h3>Hermes — likes</h3>
    <ul>
      <li>Leaner day-one setup (“finally get things done instead of debugging”)</li>
      <li>Memory continuity out of the box (biggest migration reason)</li>
      <li>Checkpoint / rollback before file mutations</li>
      <li>Model-agnostic + OpenRouter-first; learning loop that creates skills</li>
      <li>Cleaner public security track so far; explicit <code>hermes claw migrate</code></li>
    </ul>
  </article>
  <article class="artifact-panel">
    <h3>Hermes — hates</h3>
    <ul>
      <li>Astroturfing suspicion (~15% of Kilo sample distrust the hype)</li>
      <li>Overconfident self-improvement (“always thinks it did a good job”)</li>
      <li>Smaller skill ecosystem vs ClawHub</li>
      <li>High fixed token overhead (~14k tokens cited in open issues)</li>
      <li>Not a coding agent — Claude Code / Cursor win for production code</li>
    </ul>
  </article>
</section>

### Models people actually run

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg class="artifact-diagram" viewBox="0 0 1080 280" role="img" aria-label="Model tiering for OpenClaw and Hermes workloads">
  <rect x="20" y="20" width="1040" height="240" rx="14" fill="#090c0f" stroke="#303840" stroke-width="1.5"/>
  <text x="50" y="55" font-family="JetBrains Mono, monospace" font-size="12" fill="#a3e635">QUALITY CEILING</text>
  <rect x="50" y="70" width="230" height="150" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="70" y="110" font-family="Inter, system-ui, sans-serif" font-size="14" fill="#c8c8c8">Claude Opus</text>
  <text x="70" y="135" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">4.6 / 4.7 / 4.8</text>
  <text x="70" y="160" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">best agentic quality</text>
  <text x="70" y="185" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">expensive · ban pressure</text>

  <text x="310" y="55" font-family="JetBrains Mono, monospace" font-size="12" fill="#38bdf8">DAILY DRIVERS</text>
  <rect x="310" y="70" width="230" height="150" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="330" y="105" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">Claude Sonnet</text>
  <text x="330" y="130" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">GPT-5.4</text>
  <text x="330" y="155" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">MiniMax M2.7</text>
  <text x="330" y="190" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">Hermes default: Sonnet via OR</text>

  <text x="570" y="55" font-family="JetBrains Mono, monospace" font-size="12" fill="#f59e0b">HIGH VOLUME / BUDGET</text>
  <rect x="570" y="70" width="230" height="150" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="590" y="105" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">Qwen 3.5 / 3.6</text>
  <text x="590" y="130" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">GLM · Kimi K2.5</text>
  <text x="590" y="155" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">DeepSeek / Flash</text>
  <text x="590" y="190" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">often free / flat-rate on OR</text>

  <text x="830" y="55" font-family="JetBrains Mono, monospace" font-size="12" fill="#8a8a8a">LOCAL</text>
  <rect x="830" y="70" width="200" height="150" rx="8" fill="#121212" stroke="#555" stroke-width="1.5"/>
  <text x="850" y="110" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">Ollama / Qwen3</text>
  <text x="850" y="140" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">fine for light tasks</text>
  <text x="850" y="165" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">&lt;14B often fails</text>
  <text x="850" y="185" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">multi-step tools</text>
</svg>
<figcaption>Community model routing for OpenClaw / Hermes: Opus for hard reasoning, Sonnet/GPT-5.4/MiniMax for daily loops, Qwen-class for volume.</figcaption>
</figure>

Trend: Anthropic account bans and per-token burn are pushing operators toward flat-rate MiniMax / Ollama Pro Cloud and free OpenRouter Qwen for routine automation.

## Evidence

### OpenClaw — recent shipments

**`v2026.7.1` (stable, Jul 13)** — ~3,063 contributions / 532 contributors:

- Control UI overhaul (tasks, cost/usage, pairing, approvals, gateway health)
- Major official iOS / Android / macOS app work
- Models: GPT-5.6, Tencent Hy3, Meta Muse Spark 1.1, broader Claude / Ollama / ClawRouter
- Coding bridges: `openclaw attach` for Claude Code; Codex / Copilot delegation
- Gateway crash loops leave a repair path instead of restarting forever
- Scheduled wake-on-change, remote browser tab pairing, workspace terminals

**`v2026.7.2` betas (through Aug 2)**: Claude Opus 5, Kimi K3, GPT Live realtime, in-process llama.cpp GGUF, session rewind/fork, Quick Chat on macOS/Linux, MCP Apps, cloud workers + paired-node coding sessions.

**Pain evidence from the tracker / community:**

- April `2026.4.26` cluster: Discord unresponsive, gateway 100% CPU, multi-minute latency; users rolled back / switched Hermes to primary
- Open issues cite gateway RSS growth (350MB → 15GB), runaway model-call retries billing hundreds of dollars, silent subagent completion loss
- Security timeline: CVE-2026-25253 (exposed RCE), March 2026 CVE flood, ClawHub malicious-skill audits

### Hermes — recent shipments

**`v0.19.0` Quicksilver (Jul 20)** — ~2,245 commits, ~3,300 issues closed:

- ~80% cold-start latency cut (~4.3s → ~0.9s TTFT)
- Smart approvals default (independent LLM reviews risky commands)
- Bitwarden / 1Password secret sources
- Live subagent transcripts + durable background delegation
- Delivery-obligation ledger (do not lose replies on gateway crash)
- Profile-based multi-tenant routing on one gateway

**`v0.20.0` Herald (Aug 3)** — ~3,650 commits, ~1,200 issues closed:

- Streaming conversational voice with barge-in + on-device wake words
- Grounded citations + fact-checking skill
- Signed outbound webhooks; A2A v1.0 agent-to-agent protocol
- Desktop platform: artifacts, plugin SDK, quick-entry hotkey
- CLI power tools (`!shell`, `/init`, `/diff`, `/context`, mid-turn redirects)
- Tools self-recover; iteration limit 90 → 500; smarter compression
- New models: GPT-5.6 family, grok-4.5, kimi-k3, Claude Fable/Sonnet 5, Hy3

Hermes documented OpenRouter default: `~anthropic/claude-sonnet-latest`. Axis Intelligence hands-on score: **8.2/10** for experienced developers (not non-technical users).

### Cursor Agent — placement

Cursor is not competing for the personal WhatsApp agent slot.

- Local Agent mode: best-in-class IDE autocomplete + multi-file agent
- Cloud Agents (ex-Background Agents): isolated VMs, parallel PR factory, desktop/browser verification
- Strength: day-one coding productivity and team PR workflow
- Gap vs Hermes/OpenClaw: no 24/7 messaging gateway, no life-OS memory loop

### Community verdict (Kilo · ~1,300 r/openclaw comments)

| Camp | Share | Stance |
| --- | --- | --- |
| Stay on OpenClaw | ~35% | Ecosystem + cron + skills worth the pain |
| Switched to Hermes | ~30% | Setup + memory + fewer breakages |
| Run both | ~20% | OpenClaw orchestrates; Hermes executes recurring loops |
| Distrust Hermes | ~15% | Astroturf / hype accounts |

Independent reviews (Axis, eesel, HundredTabs, Techsona, Agent Shortlist, pasqualepillitteri) land on the same pragmatic line: assign by job; do not crown an absolute winner.

## Recommendations

1. **New always-on personal agent:** start with **Hermes** (`v0.20` Herald). Prioritize memory, setup time, and recent reliability/latency work.
2. **Need ClawHub / WhatsApp-heavy / already invested:** stay on **OpenClaw**, pin known-good releases, never expose the gateway to the public internet, treat ClawHub skills as untrusted by default.
3. **Power setup:** run **both** — OpenClaw for channel breadth / skills; Hermes for long-running learned workflows. Use `hermes claw migrate` when testing a side-by-side.
4. **Coding workload:** Cursor (daily IDE) + Claude Code (deep/terminal). Do not demote either in favor of a personal gateway for production code.
5. **Model routing defaults:**
   - Hard reasoning → Claude Opus
   - Daily agent loops → Claude Sonnet or GPT-5.4 (Hermes OR default Sonnet)
   - High volume → MiniMax or Qwen via OpenRouter
   - Avoid expecting reliable multi-step tools from tiny local models (&lt;14B)

```bash
# Hermes quick path
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
hermes model   # pick provider / model
hermes gateway # Telegram / Discord / Slack / WhatsApp

# OpenClaw quick path
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw onboard --install-daemon
openclaw gateway status
```

### Sources

- GitHub API: `openclaw/openclaw`, `NousResearch/hermes-agent` (stats, READMEs, release notes)
- Releases: OpenClaw `2026.7.1` / `2026.7.2-beta.*`; Hermes `v2026.7.20` / `v2026.8.3`
- Community: [Kilo OpenClaw vs Hermes](https://kilo.ai/openclaw/vs-hermes), r/openclaw breakage threads, ClawMage Reddit roundup
- Reviews: Axis Hermes, eesel, HundredTabs, Techsona, Agent Shortlist, OpenRouter Hermes tutorial
- Security: GitHub advisories / CVE timeline writeups for OpenClaw early–mid 2026
