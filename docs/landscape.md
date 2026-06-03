# The CLI Agent Toolchain

Research synthesis: what a toolchain for CLI coding agents looks like, grounded in actual pain points and the competitive landscape as of April 2026.

---

## The shape

The right analogy is `nvm + npm + tsc + pm2` -- not one tool, one layered stack where each layer solves a different class of problem. The unit being managed isn't a language runtime; it's an *agent surface* (Claude Code, Codex, Gemini, Cursor, OpenCode, Droid, OpenClaw), each with its own binary, config format, memory file, session storage, MCP registry, and auth model.

### The 9 layers

| Layer | Purpose | Analog |
|---|---|---|
| 1. Version manager | Install / pin / rollback agent CLIs per repo | nvm, pyenv |
| 2. Config source-of-truth | One memory file, rules, skills, commands, hooks fan out to every agent | tsconfig, .editorconfig |
| 3. Resource registry | Install MCP servers, skills, subagents, permission bundles once; share via git | npm, pip |
| 4. Profile system | Bind host CLI + endpoint + model + keychain auth (e.g. Kimi-on-Claude-Code via OpenRouter) | .nvmrc + .env |
| 5. Session / memory plane | Normalize Claude JSONL + Codex JSONL + Gemini JSON; cross-agent resume; shared project memory | git log |
| 6. Secrets manager | Keychain-backed, scoped per profile, no `.env` leakage | 1Password, keyring |
| 7. Local runner | `run <any-agent> <prompt>` -- one command, translates mode / effort / perms per agent | bun run, make |
| 8. Cloud dispatch | Single interface routes to Rush / Codex Cloud / Factory, shared task index | kubectl |
| 9. Scheduler | Cron-style routines with sandboxed permissions | systemd timers |

---

## Why this shape -- grounded in actual pain

Pain points pulled from Reddit, HN, GitHub, and blog posts over the last three months.

### Top 12 pain points (ranked)

1. **Usage limits and opaque quota burn.** Since March 23, 2026, Claude Max users reported 5-hour windows "depleting in as little as 19 minutes"; one Redditor said a single word "Morning" burned 15% of their quota. Anthropic admitted users were hitting limits "way faster than expected." Root causes spanned caching bugs, peak-hour throttling, and a silent `reasoning_effort` downgrade. ([The Register](https://www.theregister.com/2026/03/31/anthropic_claude_code_limits/), [yage.ai](https://yage.ai/share/claude-code-runtime-regression-en-20260407.html))

2. **Config sprawl across CLAUDE.md / AGENTS.md / .cursorrules / copilot-instructions.** Teams copy-paste the same rules into four files and they drift within a day. Common workaround: symlink `CLAUDE.md -> AGENTS.md` or `@AGENTS.md` include. ([contextarch.ai](https://contextarch.ai/blog/agents-md-vs-claude-md-confusion-2026), [kau.sh](https://kau.sh/blog/agents-md/))

3. **MCP server duplication and tool overload.** Each agent needs MCP re-registered; as servers stack up, "you find yourself blowing up your context window." A GitHub issue documents `.mcp.json` auto-discovery breaking unrelated workflows when a single MCP fails to boot. ([PulseMCP](https://www.pulsemcp.com/posts/agentic-mcp-configuration), [github/gh-aw #21813](https://github.com/github/gh-aw/issues/21813))

4. **No shared memory / context across agents.** Developers want to start on Claude Code and continue on Codex without re-briefing. Multiple projects have sprung up to patch this: Memorix, claude-mem, agentmemory, MemClaw. ([Memorix](https://github.com/AVIDS2/memorix), [Cognition](https://www.cognitionus.com/blog/agentmemory-guide))

5. **Session resume is broken across agents.** HN Show: "Ctx -- a /resume that works across Claude Code and Codex" -- author says native `/resume` lists "aren't always clear about which session to pick back up" and only work inside one tool. ([HN 47836740](https://news.ycombinator.com/item?id=47836740))

6. **Version management is primitive and dangerous.** `claude update` lexicographically "upgraded" 2.1.19 -> 2.1.7. Regressions like the Windows subprocess bug in 2.1.114 left users with no easy rollback path. ([claude-code #16705](https://github.com/anthropics/claude-code/issues/16705), [#50559](https://github.com/anthropics/claude-code/issues/50559))

7. **Credential / secret sprawl and auto-ingestion.** Claude Code silently reads `.env` / `.env.local`. Knostic: "credentials accumulating across multiple agents, extensions, MCP tools and integrations... high-risk sprawl." ([Knostic credential sprawl](https://www.knostic.ai/blog/credential-management-coding-agents), [Knostic .env blog](https://www.knostic.ai/blog/claude-loads-secrets-without-permission))

8. **Parallel agent chaos -- worktree + review burden.** Simon Willison: "reviewing code that lands on your desk out of nowhere is a lot of work." Consensus: 3-5 concurrent agents is the ceiling before merge conflicts and review cost swamp gains. ([simonwillison.net](https://simonwillison.net/2025/Oct/5/parallel-coding-agents/), [patrickdap.com](https://www.patrickdap.com/post/how-to-run-multiple-agents/))

9. **Cloud vs local confusion and cost cliff.** Codex Cloud costs ~5x local ("7 credits vs 34 credits" for the same GPT-5.4 task). No unified way to dispatch to Rush / Codex / Factory from one CLI. ([codex.danielvaughan.com](https://codex.danielvaughan.com/2026/03/27/codex-cloud-vs-local-when-to-run-in-cloud/))

10. **Billing conflicts between harness and provider.** "Pi billing conflict with Anthropic... users pay API rates plus Max subscription simultaneously -- forcing double payment." ([thoughts.jock.pl](https://thoughts.jock.pl/p/ai-coding-harness-agents-2026))

11. **Harness surface fragmentation.** Power users want terminal (Claude Code), web (Codex Cloud), IDE (Cursor), and mobile (Factory Droid) all pointed at the same project -- but memory, sessions, and permissions don't follow. ([decodingai.com](https://www.decodingai.com/p/agentic-harness-engineering), [firecrawl.dev](https://www.firecrawl.dev/blog/why-clis-are-better-for-agents))

12. **No cross-agent todo / task layer.** Direct HN quote: users want "a todo list tailored to agentic coding that will work with CC, Codex, Gemini, etc. Simple, but more than markdown." ([HN 47750069](https://news.ycombinator.com/item?id=47750069))

---

## The competitive gap

Every existing product is **vertical**, not horizontal.

| Product | Scope | What it owns | What it misses |
|---|---|---|---|
| **Factory droid** | Single agent, local + cloud | BYO compute via `droid computer register`; Managed Computers; Slack / Linear hooks | Can't run Claude Code or Codex through droid; no version pinning; no cross-agent config |
| **Devin 2.0** | Single proprietary agent, cloud-only | $20/mo Core (PAYG ACUs), $500/mo Team, Enterprise VPC | No CLI, no BYO-agent |
| **Rivet** | Multi-agent, server-side | Sandbox Agent SDK runs Claude / Codex / OpenCode / Amp / Pi via ACP with universal transcripts | No local-workstation tooling, no version pinning, no skill / MCP sync |
| **Codex Cloud** | OpenAI only | Parallel worktrees, Slack triggers, schedule-able tasks | OpenAI-only, no cross-agent orchestration |
| **Claude Agent SDK** | Anthropic only | 101 plugins in official marketplace | Claude-only |
| **mise / asdf** | Generic runtimes | Version pinning | No agent awareness, no config isolation per version |
| **Cursor 3 "Glass" / Zed** | IDE-bound | ACP-based external agents, self-hosted cloud agents via K8s CRD | Not CLI-first |
| **Conductor / Crystal / FleetCode / agent-of-empires** | Parallel runners | tmux + worktrees for 6+ agents | No version / config / cloud layer |
| **agentgateway** (Linux Foundation) | Network proxy | JWT, RBAC, PreRouting policies | Not a workstation toolchain |
| **Memorix / claude-mem / agentmemory / MemClaw** | Cross-agent memory only | Shared context across agents | Single-feature patches |
| **Agentloom / Microsoft APM / Skild / skills.sh** | Config / skill sync | Fan out skills, MCP, rules across 7-18 agents | Not version-aware |
| **cass** | Session search only | BM25 + semantic across 11 agents | No lifecycle / resume |
| **Dispatch (withdispatch.dev)** | Single cloud backend | Phone -> desktop dispatch | Siloed |

**Nobody owns the horizontal workstation toolchain that treats every CLI agent as interchangeable.** That's the slot.

---

## Does agents-cli meet the criteria?

Every layer of the toolchain maps to a concrete implementation in the codebase.

| Layer | agents-cli feature | Evidence |
|---|---|---|
| 1. Versions | `agents add/use/prune claude@2.0.65` -> `~/.agents/versions/{agent}/{version}/home/`, symlink swap + auto-backup to `~/.agents/backups/{agent}/{timestamp}/` on switch | `src/lib/versions.ts`, `src/lib/shims.ts` |
| 2. Config source-of-truth | Central `AGENTS.md` symlinked to CLAUDE.md / GEMINI.md / .cursorrules; `memory-compile.ts` inlines `@path` imports for agents without native support | `src/lib/memory.ts:37-58`, `src/lib/memory-compile.ts:20-24` |
| 3. Resource registry | 8 resource types: commands, skills, hooks, memory, mcp, permissions, subagents, plugins. `agents install mcp:com.notion/mcp` fans out to all agents; git-tracked via `agents repo push` / `agents repo pull` (per-repo) and `agents secrets push` / `agents secrets pull` (bundle sync) | `src/lib/types.ts:288`, `src/commands/mcp.ts` |
| 4. Profiles | Presets for Kimi, DeepSeek, Qwen, GLM, MiniMax; `agents run kimi "..."` resolves to Claude Code host + `ANTHROPIC_BASE_URL` + keychain auth at spawn time | `src/lib/profiles.ts:6-32`, `src/lib/profiles-presets.ts`, `src/commands/exec.ts:154-167` |
| 5. Sessions | SQLite + FTS5 index at `~/.agents/sessions/sessions.db`, normalizes Claude / Codex / Gemini / OpenCode formats, ~100ms warm reads | `src/lib/session/*`, `src/commands/sessions.ts` |
| 6. Secrets | macOS Keychain (`agents-cli.<provider>.token`, `agents-cli.secrets.<bundle>.<KEY>`); YAML on disk holds refs only; merge order profile < bundle < `--env K=V` | `src/lib/profiles-keychain.ts`, `src/commands/exec.ts:229-249` |
| 7. Local run | `agents run <agent\|profile> <prompt>` with `--mode plan/edit/full`, `--effort low/.../max`, `--rotate` for LRU accounts, `--fallback codex,gemini` cascade on rate-limit with `/continue <id>` | `src/commands/exec.ts:61-145`, `src/lib/exec.ts:244-329` |
| 8. Cloud dispatch | Unified `agents cloud run/list/status/logs/cancel/message` across Rush / Codex / Factory, shared SQLite task index, SSE streaming | `src/lib/cloud/*`, `src/commands/cloud.ts:57-100` |
| 9. Scheduler | `agents routines add daily-digest --schedule "0 9 * * 1-5"`, sandboxed runner, daemon auto-start | `src/lib/scheduler.ts`, `src/lib/runner.ts`, `src/commands/routines.ts` |

**Verdict:** yes -- agents-cli is the shape. Every one of the 9 layers is implemented, and every top-10 pain point from the research maps to an existing feature.

---

## Honest gaps -- what's missing vs a complete pitch

Three holes remain. Nobody else has filled them either.

1. **Cost / quota observability across providers.** Research flagged this hard (Claude quota burning in 19 min, Codex Cloud 5x cost). agents-cli tracks cloud tasks but has no unified "you burned $N today across Claude + Codex + Rush" view. This is the next visible hole -- and the one competitors will notice last.

2. **Cross-agent session resume.** `agents sessions` reads and searches across agents but doesn't port state from a Claude session into a Codex one. This is what Ctx and Memorix are bolting on as single-feature products.

3. **Billing / quota-aware routing.** `--rotate` and `--fallback` handle rate limits, but don't pick the cheapest provider for the task class. A routing layer that reads current quota state and price per task would close the loop.

Those three are the interesting things to build next. Everything else the research identified is already shipped.
