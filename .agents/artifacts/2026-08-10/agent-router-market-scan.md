---
kind: report
title: Agent Router — Market Scan
surface: cli
kicker: agents-cli · who else is building meta-harness routing
---

# Agent Router — Market Scan

## Summary

The market has split into **three distinct routing layers**, and only one of them is
crowded. Confusing them is the main way this analysis goes wrong.

| Layer | What it picks | Crowding | Best-in-class today |
|---|---|---|---|
| **L1 — Model gateway** | which *model/provider* answers one API request | saturated (56k-star incumbent) | LiteLLM, OpenRouter, Portkey, Ramp Router |
| **L2 — CLI proxy router** | which *model* a coding CLI talks to, via a local endpoint | crowded, one dominant repo | claude-code-router (36.5k) |
| **L3 — Meta-harness router** | which *harness × account × model × device* runs a task | nearly empty — **one real competitor** | Claudexor (400 stars, 10 weeks old) |

`agents-cli`'s router spec is **L3**. That layer has exactly one credible other
implementation, it is 10 weeks old, and it converged on the same two hard
constraints (native-CLI execution, no credential transfer) independently. That is
the strongest validation signal in this scan — and the tightest deadline.

## 1. Focus for review

- **L3 is real and contested by exactly one team.** Claudexor already ships
  quota-aware rotation across multiple Claude/Codex subscriptions, native-CLI
  execution, and SSH-remote hosts with credentials pinned to their origin machine.
  That is the agent-router spec, shipped.
- **Nobody owns "routing across *subscription accounts*."** L1/L2 tools all assume
  API keys. Subscription-seat routing (Max/Pro/Team plans, 5h/7d quota windows) is
  where agents-cli already has real inventory and nobody else has a moat.
- **The framework question has a boring answer.** There is no agent-routing
  framework to adopt. Everyone hand-rolls policy; the only reusable pieces are
  gateways (LiteLLM/Portkey) at L1 and classifier models (RouteLLM, Arch/plano) for
  prompt→model scoring.
- **YC shipped a structural competitor to the whole harness layer**, not just the
  router: QM (MIT, July 31 2026) — pluggable agent drivers + scopes + keychains +
  crons + skills grants. 13k stars in 10 days.
- **Cost-routing skepticism is the loudest counter-argument in public.** The
  best-attended HN thread on router products (216 pts) is mostly developers arguing
  routing *loses* money via cache misses and retry loops.

## Findings

### L1 — Model gateways (do not build here)

Mature, commoditized, and orthogonal to what agents-cli does. Worth reading for
scoring mechanics, not worth competing with.

| Tool | Stars | What it is |
|---|---|---|
| [LiteLLM](https://github.com/BerriAI/litellm) | 56,052 | The default OSS gateway. 100+ providers behind one API, fallbacks, budgets |
| [Portkey Gateway](https://github.com/Portkey-AI/gateway) | 12,683 | 1,600+ models, guardrails, conditional routing |
| [plano (Katanemo)](https://github.com/katanemo/plano) | 6,995 | Rust proxy/data plane; ships **Arch-Router**, a preference-aligned routing model |
| [vllm semantic-router](https://github.com/vllm-project/semantic-router) | 5,132 | Mixture-of-Models router for heterogeneous inference |
| [RouteLLM](https://github.com/lm-sys/RouteLLM) | 5,322 | The academic reference — strong/weak router trained on preference data. **Unmaintained since 2024** |
| [OpenRouter Auto](https://openrouter.ai/blog/insights/model-routing/) | — | 500+ models, `cost_quality_tradeoff` dial 0–10, no surcharge |
| [Ramp Router](https://builders.ramp.com/post/thompson-sampling-model-routing) | — | Internal router opened to public July 2026; Thompson sampling + EWMA over live latency/failure; claims 25–30% spend cut |

**The one genuinely transferable idea:** Ramp's routing is *failure-aware and
online* — Thompson sampling over live latency/error distributions, not a static
scoring table. The spec's `weights` config is a static prior; Ramp's result says
the win comes from updating it from observed outcomes.

### L2 — CLI proxy routers (adjacent, one dominant player)

These intercept the coding CLI's API traffic and swap the model behind it.

| Tool | Stars | Note |
|---|---|---|
| [claude-code-router](https://github.com/musistudio/claude-code-router) | **36,553** | The category king. One local endpoint for Claude Code, Codex, Grok, Kimi, OpenCode, Pi; provider presets incl. subscription passthrough |
| [ClawRouter](https://github.com/BlockRunAI/ClawRouter) | 6,608 | Agent-native, 66 models, <1ms local routing |
| [Weave Router](https://news.ycombinator.com/item?id=48688700) | — | Show HN, 216 pts / 113 comments. RL model over agent traces; claims 40% token savings |
| [CC-Router](https://github.com/VictorMinemu/CC-Router) | 24 | Round-robin proxy over 2–20 Claude Max seats with OAuth rotation — the *narrow* version of agents-cli's account layer |

**Architectural fork in the road:** L2 proxies the wire. agents-cli and Claudexor
run the **native CLI**. Proxying gives per-request granularity but breaks harness
features (native auth, agent-side caching, vendor session state); native execution
keeps them but makes routing a per-*task* decision, not per-request. The spec picks
native — same as Claudexor. That is the defensible choice and should be stated as
one.

### L3 — Meta-harness routers (the actual competitive set)

| Tool | Stars | Created | Overlap with the spec |
|---|---|---|---|
| **[Claudexor](https://github.com/razzant/claudexor)** | 400 | 2026-06-05 | **Near-total.** Multi-harness control plane (Claude Code, Codex, Cursor, OpenCode); quota-aware rotation across multiple Claude/Codex subscriptions; native-CLI execution; SSH remote hosts; credentials never leave their machine |
| [QM (Y Combinator)](https://github.com/yc-software/qm) | 12,955 | 2026-07-31 | Harness layer, not router: pluggable drivers (Claude Code, OpenCode, Codex, Pi) + scopes, keychains, crons, skills grants, admin policy. MIT |
| OMK | — | 2026 | "Provider-neutral CLI control plane for coding agents" |
| [vibe-kanban](https://github.com/BloopAI/vibe-kanban) | 27,736 | 2025 | Task board over agents — *placement*, not scored routing. **No push since April** |
| Superset (YC S26) | — | 2026 | Terminal that coordinates parallel agent sessions |

Everything else in the ecosystem — and there are **150+ tools** catalogued in
[awesome-cli-coding-agents](https://github.com/bradAGI/awesome-cli-coding-agents) —
is a *runner*: worktrees, tmux panes, kanban boards, dashboards. They put agents
side by side. They do not **choose** between them on task shape, quota headroom,
and cost.

## 3. Where Claudexor lands vs. the spec

Read this as a diff against the merged `agent-router-spec.md`, not as a scoreboard.

| Spec requirement | Claudexor | Read |
|---|---|---|
| Named, reusable routers (allowlist of harness × model × accounts) | **No** — routing is `pool + --primary-harness + --routing-goal auto\|quality\|economy` | **The open gap.** Their routing is per-invocation flags; the spec's named-router-as-resource is a real differentiator |
| Quota-aware account rotation | **Yes** — per-profile from the vendor's own `oauth/usage`, 5h/7d/per-model percentages | Parity. They rotate only on typed vendor-limit signals or headroom breach, never on network errors — a detail worth copying |
| Native-CLI execution, not API proxy | **Yes** | Parity, and independent convergence |
| No credential transfer across machines | **Yes** — creds stay on the origin host, reached over SSH local forwarding | Parity with the spec's no-cred-transfer constraint |
| Remote/device routing | **Yes** — SSH alias, signed no-sudo remote runtime | Parity |
| `--explain` / non-executing dry run | **Partial** — `apply --dry-run`, all write commands default to inspection | The spec's scoreboard-style `--explain` is better; ship it as a wedge |
| Cross-harness fallback on rate limit | **Yes** — `limit_action: fail\|ask\|rotate` | Parity; theirs is config-declared, matching spec Group D |
| Cross-harness delegation | **Yes** — `agent --delegate`, `best-of` races N candidates with review | **Ahead.** RUSH-2573/2574 are still Backlog here |

Two things they do that the spec does not, and both are cheap to fold in:
`best-of` (race N harnesses on one task, review the winners) and `plan --council`
(multi-harness planning drafts). Those are the demos that sell a meta-harness
router — a scoring table is not a demo.

## 4. The strongest public counter-argument

The Weave Router [Show HN](https://news.ycombinator.com/item?id=48688700) is the
most-attended public debate on this idea, and the room was hostile. The three
arguments that landed:

1. **Cache destruction.** Switching models invalidates prompt cache; the saving is
   often smaller than the cache miss. *Mitigation in their product: cache-aware
   routing raises the switch threshold.*
2. **The agent already knows.** Routing outside the agent breaks its feedback loop —
   the router "doesn't know it just tried DeepSeek and failed, so try Opus."
3. **Cheap models cost more.** Weak models fail, loop, and need rescuing, so
   naive cost-routing can *increase* spend.

**Why this matters less at L3:** all three are per-*request* objections. Routing a
whole task to a harness+account keeps the cache warm inside that session, keeps the
agent's loop intact, and makes the fallback a session-level event. The spec should
say this explicitly — it is the reason meta-harness routing survives the critique
that model routing does not.

## 5. Recommendation

**Do not adopt a framework.** There isn't one at L3. LiteLLM/Portkey solve a
different layer, and wiring one in would force the API-proxy architecture the spec
deliberately rejected.

**Do borrow four specific things:**

| Borrow | From | Where it lands |
|---|---|---|
| Online, failure-aware weighting (Thompson sampling / EWMA over observed outcomes) instead of static weights | Ramp Router | RUSH-2570 (`scoreCandidates(weights)`) |
| Rotate only on *typed* vendor-limit signals, never on generic errors | Claudexor | RUSH-2571 (cross-harness fallback) |
| `best-of` — race N harnesses on one task, review the results | Claudexor | new ticket; this is the demo |
| Cache-awareness as an explicit non-goal at L3, stated in the spec | Weave Router HN thread | spec §counter-arguments |

**Ship the differentiator first.** The named router as a *resource kind*
(RUSH-2562/2563) is the one thing no competitor has — Claudexor routes with
per-invocation flags, claude-code-router routes with a global config. A reusable,
shareable, task-typed router that layers project > user > system is a genuinely
new surface, and it is the least-built part of the spec.

**Timing is the risk.** Claudexor went 0 → 400 stars and shipped this entire
feature set in ten weeks; QM took 13k stars in ten days. The L3 window is open now
and will not stay open.

## Evidence

Searched: GitHub repository search (star/push filters, `gh api`), Hacker News
threads, YC company directory, vendor engineering blogs, and the
`awesome-cli-coding-agents` catalogue (150+ tools). Star counts and push dates were
read from the GitHub API on 2026-08-10, not from prose. Claims about Claudexor's
architecture come from its README; claims about QM from YC's release coverage.

## Tracking

- Epic: RUSH-2555 — Agent Router (meta-harness routing)
- Spec: `.agents/artifacts/2026-08-10/agent-router-spec.md` (PR #2641, merged)
