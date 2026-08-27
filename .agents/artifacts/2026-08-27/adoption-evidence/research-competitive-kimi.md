# agents-cli — Competitive Strategy Report

**Date:** 2026-08-27 · **Subject:** `@phnx-labs/agents-cli` (`agents`/`ag`)
**Method:** 8 parallel research agents; every star count pulled live via `gh api` on 2026-08-27; every download figure from `api.npmjs.org/downloads/point/last-week` (window 2026-08-19 → 08-25); brew figures from `formulae.brew.sh` API; threads quoted from HN Algolia and GitHub issue trackers. Nothing below is from memory.

**agents-cli baseline (self, fetched 2026-08-27):** GitHub `phnx-labs/agents-cli` **17 stars**; npm **2,961 downloads/week**; latest **v1.22.51**, published 2026-08-27. For calibration: the sunsetting Vibe Kanban has 27

• Report delivered to `out-kimi.md` (37 KB). Eight parallel research agents fetched live data — every star count via `gh api` today, every download figure from npm/PyPI/brew APIs, every thread quoted from HN/GitHub. Highlights:

  **Competitive map.** The 2025 multi-agent-runner cohort is a graveyard: Terragon shut down (2026-02-09), Crystal deprecated, Vibe Kanban sunsetting (27,933 stars but only 1,495 npm dl/wk — agents-cli's 2,961/wk already exceeds it in usage despite having 17 stars). Survivors cluster into four layers: local runners (Conductor, Claude Squad, Nimbalyst, Sculptor), the usage/account layer (claude-code-router 36.9k★, ccusage 18.2k★, claude-swap 2k★), cloud agents (all converged on $20/$200 seat+metered pricing), and complements (container-use, Backlog.md). Nobody else does per-version isolated-HOME agent-CLI management, and nobody combines daemon-owned multi-account rotation with a stall watchdog.

  **The wedge.** Ranked: (1) multi-account rotation past usage limits — loudest pain by an order of magnitude (609-pt/705-cmt HN thread; people literally buy second $200 subs), only thin single-purpose competitors; (2) stall detection — proven by 310-pt/198-pt Show HNs, and detection is genuinely hard (cmux's false-positive issues), so it's the defensible half; (3) version pinning — real but episodic, and Anthropic's own installer *removed* rollback; (4) cross-device sessions — magical demo but you're racing Anthropic's roadmap.

  **The 551-command problem.** Curated CLIs show 13–33 commands while hiding 4–8× more (git 23/168, brew 13/111, cargo 16/48); AWS's 432-flat is the anti-pattern agents-cli currently sits near. Recommendation: 8-group curated default help + `--help-all`, tiered "advanced" groups, task-stage grouping, `agents alias` — zero capability deleted.

  **Friction.** For AI CLIs brew is 0.07–0.53% of npm volume (measured across 4 tools); Codex/OpenCode made curl-bash primary; Gemini/Vibe Kanban lead with npx. Ideal first run: `npx` → `agents doctor` → `agents run` with existing auth → sessions indexed, all inside 60s, no new account.

  **Build-vs-buy.** Homegrown never fails at *spawning* agents ("it's the new TODO app"); switchers buy four things: attention-state dashboards, mobile/push, safe sandboxes, and not maintaining it. The weekend-proof moats: quota-aware rotation, idle-vs-done detection, cross-device transcript state, shared-limit visibility.

  The 5 moves, ranked: lead with "never hit the wall" (rotation + watchdog demo), cut perceived surface 5×, zero-install/zero-account first run, brand version pinning around the vendor-created gap, and position against the $20/$200 cloud seat with the two-machine demo.

I for running large numbers of coding agents in parallel with git worktrees" | `go install …/uzi@latest` | 582 | — | **Stale ~15 months** |
| async-code ("Async"?) | "Your personal codex/cursor-background agent" | web app clone | 537 | — | Slowing (last push 2025-11-18); no definitive product named "Async" found |
| Sculptor (Imbue) | "A desktop app for running coding agents in parallel" | desktop download | 220 | — | Very alive, well-funded; experimental |
| Terragon | cloud background agents | — | 258 (OSS remnant) | — | **Shut down 2026-02-09** |
| headroom | "Track and rotate your Claude & Codex usage across accounts" | — | 99 | — | Niche; only other Claude+Codex rotator |
| **agents-cli** | control plane for all agent CLIs | `npm i -g @phnx-labs/agents-cli` | **17** | **2,961** | Alive (v1.22.51, today) |

### Layer A per-tool deltas (what each has that agents-cli doesn't, and vice versa)

- **Conductor** — Has: polished native macOS GUI with diff-first review, managed cloud sandboxes (agents run with the lid closed), multiplayer, mobile app + API. Lacks vs agents-cli: account rotation, fleet SSH dispatch, session DB, watchdog, routines, Linux/Windows, source-available code. ([conductor.build/pricing](https://www.conductor.build/pricing), fetched 2026-08-27: $50/mo Pro, $60/user Teams.)
- **Claude Squad** — Has: attach/detach tmux TUI, per-session pause/checkout in one window. Lacks: everything beyond a single-machine mux — no sessions DB, no cross-device, no accounts, no watchdog. Free, AGPL.
- **Nimbalyst** (Crystal successor) — Has: full visual workspace (Monaco editor, Excalidraw, spreadsheets) with agents streaming edits in. Lacks: anything headless/fleet. Free, MIT.
- **Sculptor** — Has: Docker/remote container isolation per agent (vs worktrees), Pairing Mode (sync agent container ↔ your IDE), bundled workflow skills. Lacks: CLI/scriptability, accounts, watchdog, fleet. Free, MIT, backed by Imbue.
- **Happy Coder** — Has: iOS/Android/web/macOS clients with **push notifications**, E2E-encrypted sync, voice, one-key device handoff. Lacks: multi-agent breadth — it remote-controls one harness at a time; no teams, rotation, watchdog, secrets.
- **ccmanager** — Has: tmux-free TUI with inline **busy/waiting/idle** state per session, session-data copy between worktrees, AI auto-approval (Haiku verifier), status hooks. Lacks: remote/cross-device, durable transcripts, watchdog restarts, rotation, `--json` automation surface.
- **Omnara** (post-pivot) — Has: Postgres-durable agent state with crash recovery, declarative YAML agent profiles, pluggable sandboxes (Blaxel/Daytona/Unikraft), org RBAC, Slack connector, REST API. Lacks: local multi-CLI installs, worktree teams, computer-use, fleet. Enterprise = white-glove pricing.
- **container-use** — Has: MCP-server model where *the agent itself* decides to sandbox work in a real container, with full command history and `git checkout <branch>` inspection. Lacks: any orchestration — it gives environments, not a control plane. Complementary, not competitive.
- **Backlog.md** — Has: a task/spec ledger (acceptance criteria, DoD, milestones) with terminal Kanban + web board + MCP exposure. Lacks: execution entirely. Complementary.
- **uzi / async-code / Terragon / Vibe Kanban / Crystal** — stale or dead; their features (worktree fan-out, kanban UI, cloud sandboxes) are covered above by survivors.

### Table 2 — Usage / account / version layer

| Tool | What it is | Stars | dl/wk | Does auto subscription-account rotation? | Per-agent-CLI version pinning w/ isolated HOME? |
|---|---|---|---|---|---|
| claude-code-router | Model/provider gateway for agent CLIs | 36,907 | 154,467 | API-key pools only, not subscription quotas | No |
| ccusage | Retro token/cost analytics for 16 agent CLIs | 18,185 | 87,857 | No | No |
| Claude-Code-Usage-Monitor (`claude-monitor`) | Live burn-rate forecast, one account | 8,658 | 1,723 (PyPI) | No (single account by design) | No |
| claude-swap | Threshold-based auto-switch across Claude subs + TUI/menubar | 1,992 | 4,702 (PyPI) | **Yes** — Claude only | No |
| ccflare | Proxy-layer failover across Anthropic/OpenAI accounts | 1,042 | ~6 | Yes (reactive retry) — stale repo | No |
| headroom | Claude **and** Codex rotation dashboard | 99 | — | **Yes** — both, but 99★ | No |
| mise | Runtime version manager + env + tasks | 33,109 | 7,969 | No | No (shims share `$HOME`) |
| asdf | Plugin-based runtime version manager | 25,548 | — | No | No |
| proto | WASM-plugin toolchain manager | 1,400 | — | No | No |
| **agents-cli** | The control plane | 17 | 2,961 | **Yes — Claude Max + Codex Pro, balanced, daemon-owned** | **Yes — the only tool found that does this** |

Key layer-B findings:
- **claude-code-router** (36.9k★, 154k npm dl/wk — [README](https://github.com/musistudio/claude-code-router), fetched 2026-08-27) routes *requests to providers*, not *sessions across subscription accounts*. It complements agents-cli.
- **claude-swap** (1,992★, v0.25.0 2026-08-11, [repo](https://github.com/realiti4/claude-swap)) is the one credible head-on competitor to rotation: `cswap auto` polls every 60s, switches at 90% of the 5h/7d window, per-model limits, parallel per-account sessions. But it's Claude-only, a foreground loop you run yourself, and has no watchdog/teams/versioning.
- **Version pinning with isolated per-version HOMEs for agent CLIs: no competitor found.** mise/asdf/proto pin runtimes but share `$HOME`, so two Claude Code versions still fight over `~/.claude`. Anthropic's own native installer *removed* pinning/rollback ([claude-code#20044](https://github.com/anthropics/claude-code/issues/20044), 22 reactions, 2026-01-22: "no version control, rollbacks, or professional package management") — the vendor widened this gap themselves.

### Layer C — cloud agents (per-product deltas, all pricing fetched 2026-08-27)

| Product | Entry point | Price anchors | Has that agents-cli lacks | agents-cli has that it lacks | Traction (source, date) |
|---|---|---|---|---|---|
| OpenAI Codex Cloud | chatgpt.com/codex + GitHub/Linear/Slack | bundled: $0/$20/$100/$200 ChatGPT | managed per-repo cloud sandboxes, web/mobile, first-party Slack/Linear delegation | local-first, agent-agnostic, account rotation, no metered ceiling | OpenAI doesn't break out numbers ([CloudZero 2026-07-27](https://www.cloudzero.com/blog/openai-codex-pricing/)) |
| Devin (Cognition) | devin.ai + Slack/Linear assignment | $0/$20/$200, Teams $80+$40/seat | full cloud VM per session, enterprise VPC, DeepWiki | runs on your hardware, orchestrates any CLI incl. Devin's rivals | ARR $37M→**$492M** in 12mo; >$1B Series D at $26B, talks at $40B ([TechCrunch 2026-08-12](https://techcrunch.com/2026/08/12/ai-coding-startup-cognition-reportedly-already-in-talks-to-raise-at-40b-valuation/)) |
| Cursor Cloud Agents | 7 entry points (IDE, Slack, GitHub, Linear, API, iOS) | $20/$60/$200 + API-priced usage | managed VM snapshots, remote-desktop takeover of the agent machine, artifact videos | editor- and harness-independent, your fleet not their VMs | ~$4B ARR est. 2026 ([Latka 2026-07-03](https://getlatka.com/companies/cursor.com)); **SpaceX agreed to acquire Anysphere for $60B all-stock, closed 2026-08-14** ([venturecapitaltracker 2026-08-14](https://venturecapitaltracker.com/2026-spacex-closes-cursor-acquisition)) |
| Google Jules | jules.google → connect GitHub | $0 (15 tasks/day) / AI Pro $19.99 / Ultra ~$99.99 | free-tier Google Cloud VMs, zero setup, audio changelogs | interactive local sessions, any model, any git host | GA at I/O 2026; beta did 140k+ public improvements ([theaiagentindex 2026-04-23](https://theaiagentindex.com/agents/jules)) |
| Factory Droid | `droid` CLI + Factory App | $20/$100/$200 | Missions, managed "Droid Computers", enterprise dashboards | agent-agnostic, arbitrary SSH fleet, FSL source-available | $150M Series C at $1.5B, 2026-04-16 ([Idlen 2026-04-21](https://www.idlen.io/news/factory-ai-150-million-1-5-billion-droids-coding-agents-enterprise-april-2026/)) |
| Copilot coding agent | assign an issue to `@copilot` | $10/$39/$100 + Actions minutes | zero-install, lives in the issue box, Actions compute included | no 59-min ceiling, any git host, flat subs vs metered credits | >20M all-time users ([IT Brief 2025-07-30](https://itbrief.news/story/github-copilot-users-surpass-20-million-as-ai-tools-surge-in-demand)); 60M automated reviews by 2026-03 ([AICoderScope 2026-05-21](https://aicoderscope.com/blog/github-copilot-agent-mode-deep-dive-2026/)) |
| OpenHands Cloud | self-host or hosted | free self-host / $20 credits cloud | closest open philosophical peer; single-agent runtime | multi-agent/multi-account control plane | 75K+ stars ([aipedia.wiki, June 2026](https://aipedia.wiki/tools/openhands/)) |
| Amp orbs (Sourcegraph) | `npm i -g @ampcode/cli` | $20/$200 | persistent remote "orbs" steerable from a phone | one agent, hosted orbs not your machines | orbs launched 2026-06-04 ([cosyra 2026-07-16](https://cosyra.com/guides/cosyra-vs-amp.html)) |
| Replit Agent 4 | browser, no toolchain | $0/$20-25/$95-100 | end-to-end build+deploy for non-engineers | different audience entirely | 58% of its business builders aren't engineers ([espressio.ai](https://espressio.ai/blog/replit-guide-2026/)) |

**Cross-cutting:** 2026 pricing converged on seat ($10–40) + metered pool, anchored at $20 and $200 everywhere. Every cloud competitor's differentiator is *managed compute*; **none let you run on hardware you own**. That plus agent-agnosticism, account rotation, and no metered ceiling is agents-cli's uncontested lane. The consolidation (SpaceX–Anysphere $60B, Cognition at $26–40B, Factory $1.5B) strengthens the case for an open local-first control plane.

---

## 2. WHERE IS THE WEDGE?

Evidence-weighted ranking of the four candidates (full thread citations in each section):

### #1 — Multi-account rotation past usage limits. Severity: VERY HIGH, loudest pain of the four.
- HN "[Claude Code weekly rate limits](https://news.ycombinator.com/item?id=44713757)" — **609 pts, 705 comments (2025-07-28)**; follow-ups: "[Optimizing my sleep around Claude usage limits](https://news.ycombinator.com/item?id=44860015)" (221 pts, 145 cmts, 2025-08-11); "Ask HN: What are you moving on to now that Claude Code is so rate limited?" (2026-04-03). Anthropic is *still* extending a "50% higher weekly limits" promotion monthly into Aug 2026 ([Help Net Security 2026-07-13](https://www.helpnetsecurity.com/2026/07/13/claude-code-weekly-limits-promotion-extended/)) and Claude Code itself shipped "Continue automatically at usage limit" — the vendor is engineering around its own wall.
- What people do instead, quoted from the 705-comment thread: **buy a second $200 subscription** ("I'm probably going to do the inevitable: get two accounts. If I could pay $500 a month for Claude 100x I would" — stingraycharles); fall back to API keys; route to other models (claude-code-router 36.9k★, 9router 26.5k★); or schedule their sleep around reset windows.
- Competition: claude-swap (1,992★) proves demand but is Claude-only and a manual foreground loop; ccflare is stale; headroom (99★) covers Claude+Codex. **No dominant polished product owns this.**
- 60-second demo: trivially yes — hit the wall on camera, one command, session resumes on a fresh account.
- **Risk:** Anthropic framed multi-accounting as a policy gray zone in the original announcement. API-key/provider rotation is clean; subscription rotation needs careful framing ("use the accounts you pay for, one at a time, at your direction").

### #2 — Stall detection / "agent silently stopped." Severity: MEDIUM-HIGH, proven by products people adopted.
- Show HN Omnara — **310 pts, 168 cmts (2025-08-12)**; Show HN cmux — **198 pts, 77 cmts (2026-02-19)**. Both sold "get pinged when the agent needs you."
- The detection problem is genuinely hard, which is the moat: cmux's issue tracker shows false "waiting for input" when a subagent still works ([#7520](https://github.com/manaflow-ai/cmux/issues/7520)) and ambiguous notifications across 5+ sessions ([#4506](https://github.com/manaflow-ai/cmux/issues/4506)). Claude Code's own hooks can't express it ([#10168](https://github.com/anthropics/claude-code/issues/10168), 55 reactions: "no hook currently supports this critical use case"; [#12048](https://github.com/anthropics/claude-code/issues/12048): idle_prompt fires after *every* response, "unusable").
- Silent-stall failure modes with no recovery: hangs indefinitely mid-task ([#28482](https://github.com/anthropics/claude-code/issues/28482)), OAuth wiped every ~12h killing 24/7 tmux agents ([#29896](https://github.com/anthropics/claude-code/issues/29896)), laptop sleep killing subagents ([#53695](https://github.com/anthropics/claude-code/issues/53695)).
- What people do: ntfy.sh phone push from Stop hooks (a half-dozen competing repos), terminal-notifier, or "keep watching the terminal."
- Gap: everyone solves *notify on blocked prompt*; **nobody owns "detect not-progressing and restart progress"** — agents-cli's rank-by-progress watchdog is the differentiated layer.
- 60-second demo: yes — agent stalls on a hidden prompt, watchdog nudges/resumes it, phone shows what happened.

### #3 — Version pinning/rollback. Severity: MEDIUM-HIGH but episodic.
- HN "[An update on recent Claude Code quality reports](https://news.ycombinator.com/item?id=47878905)" (Anthropic's postmortem) — **942 pts, 732 comments (2026-04-23)**, the biggest thread found in this whole research pass: three silent changes degraded quality for weeks. Concrete breakage with manual rollback workarounds: [claude-code#31186](https://github.com/anthropics/claude-code/issues/31186) (fix: `npm i -g @anthropic-ai/claude-code@2.1.63`), [codex#15383](https://github.com/openai/codex/issues/15383), [codex#17432](https://github.com/openai/codex/issues/17432), [codex#23740](https://github.com/openai/codex/issues/23740).
- Anthropic's native installer **removed** pinning ([issue #20044](https://github.com/anthropics/claude-code/issues/20044)). Nobody else fills it (mise/asdf share `$HOME`).
- Verdict: intense one day per bad release, not a daily driver. A trust feature that sells the tool, weak as the headline.

### #4 — Cross-device session search + resume. Severity: MEDIUM, and racing the vendor.
- **Nine duplicate feature requests** in anthropics/claude-code from 2026-03→08 (e.g. [#31992](https://github.com/anthropics/claude-code/issues/31992), 15 reactions, 10 cmts: "For a CLI tool, this is an unexpected limitation") — all closed without CLI→CLI sync. Workarounds: Dropbox/rsync of `~/.claude/projects/` ("fragile"), SSH+tmux, CLAUDE.md as context carrier. Community scripts: cc-sync (27★), claude-code-sync (0★).
- Anthropic is actively shipping adjacent features (Remote Control, Desktop sync, mobile) — you'd be racing the vendor on their own roadmap.
- 60-second demo: the most *magical* (start on laptop, `agents sessions resume` on desktop), but the moat is thinnest.

### Wedge verdict
**Lead with the combination of #1 + #2: "your agents never stop at the wall and never silently stop at all."** Pain #1 has an order of magnitude more evidence volume and a money signal (people buy second $200 subs); pain #2 is the technically defensible half that claude-swap can't copy by adding a polling loop. Version pinning is the trust feature bundled into the same install. Cross-device resume is the demo-sweetener, not the headline.

---

## 3. THE 551-COMMAND PROBLEM

### Table 3 — CLI surface-area comparison (top-level commands in *default* help; counted live on 2026-08-27 via local `--help` or official docs)

| CLI | Shown by default | Total available | Default help lines | Technique |
|---|---|---|---|---|
| **agents-cli** | **~40 groups / ~551 cmds** | 551 | huge | **none — flat, full surface** |
| brew | **13** | ~111 (`brew commands`) | 23 | curated examples only |
| cargo | **16** + "…" | 48 (`cargo --list`) | 41 | truncation with explicit pointer |
| git | **23** ("common commands", 5 groups) | **168 built-in** (`git help -a`) + externals | 46 | common-vs-plumbing split |
| bun | 23 | 23 | 108 | everything fits (small by design) |
| deno | 30 | 30 | 106 | 3 task groups |
| gh | 33 (grouped: CORE/ACTIONS/ALIAS/ADDITIONAL) | 33 + 8 help topics | 71 | grouping + `gh help reference` |
| supabase | 37 | 37 | 61 | flat (getting uncomfortable) |
| kubectl | 43 (8 groups) | 43 + PATH plugins | 70 | task-stage grouping |
| docker | 58 (Common 13 / Mgmt 11 / Swarm 6 / legacy 28) | 58 + `docker-*` plugins | 93 | tiering; legacy demoted |
| vercel | 66 (Basic 22 / Advanced 44) | 66 | 111 | Basic/Advanced split |
| npm | 68 (compact comma list) | 68 | 34 | 6 usage examples lead; list compressed |
| aws | ~432 services, flat | ~432 × generated subcommands | 1016 | **the anti-pattern** |
| linear (3rd-party) | 15 | 15 | 34 | small surface |

**The pattern in one line:** curated-first-run CLIs show **13–33 commands** while hiding **4–8× more** behind `-a`/`--list`/help-topics/plugins. The two un-curated outliers (AWS 432 flat, Vercel 66) are the ones developers mock. agents-cli at ~40 top-level groups is at the AWS/Vercel end with none of the mitigations.

### The six proven mechanisms (all sourced)

1. **Progressive disclosure.** `git --help` shows 23 "common" commands and ends with `'git help -a' … list available subcommands` — 23 shown vs 168 real. cargo: 16 then literally `... See all commands with --list`. Vercel: Basic 22 / Advanced 44. ([clig.dev](https://clig.dev/): "Display the most common flags and commands at the start of the help text.")
2. **Hidden commands.** git's 84 plumbing commands never appear in help, only man pages ([Pro Git — Plumbing and Porcelain](https://git-scm.com/book/en/v2/Git-Internals-Plumbing-and-Porcelain)). gh gates preview commands under "ADDITIONAL"/`(preview)`.
3. **Extension models.** `gh extension` (any `gh-<name>` repo; can't shadow core); kubectl krew (`kubectl-foo` on PATH); docker CLI plugins (`docker-buildx`, starred in help); git's original `git-*` convention. Counter-model: deno/bun deliberately keep everything in one binary — viable only because their totals are 30/23.
4. **Aliases.** git config aliases; first-class `gh alias set` (aliases render as their own help section); cargo's built-in `b/c/r/t`.
5. **Human-vs-machine help split.** brew's 23-line help defers to `brew commands`/`man brew`; gh keeps the full enumeration in `gh help reference`, not the main help.
6. **Design literature.** clig.dev (Docker Compose co-creators), [Heroku CLI Style Guide](https://devcenter.heroku.com/articles/cli-style-guide), [12 Factor CLI Apps](https://jdx.dev/posts/2018-10-08-12-factor-cli-apps/), and the agent-era angle: [AI Agents Are Your New Users — A 2026 CLI Checklist](https://garbas.si/posts/ai-agents-are-your-new-users-cli/) — progressive `--help` disclosure matters *more* when the reader is an agent under token pressure.

### Concrete recommendation for agents-cli — cut perceived surface, delete nothing

- **Default `agents --help` shows 8 groups, one line each:** `run`, `sessions`, `teams`, `devices`, `accounts`, `browser`, `computer`, `doctor` — each with a one-line task description and a three-command happy-path example block (git-style). Everything else moves behind `agents --help-all` (the git `help -a` pattern) and stays fully functional.
- **Tier the rest:** mark the remaining ~32 groups as "advanced" (Vercel's Basic/Advanced split): `secrets`, `routines`, `monitors`, `cloud`, `mcp`, `clis`, `permissions`, `artifacts`, `feed`, `insights`, … — visible in `--help-all`, hidden by default, all discoverable via `agents help <group>`.
- **Group by task stage, not noun taxonomy** (kubectl's Beginner/Intermediate/…, git's start/change/history/collaborate): "get running" / "watch & recover" / "go wider (fleet, teams)" / "configure & extend".
- **Add `agents alias`** (gh-alias-style) for the long tail, so power users compress their own surface.
- **Keep `--json` everywhere** (already the convention) — the agent-consumer surface doesn't shrink, only the human first impression does.
- Expected effect: first-run help drops from ~40 groups to 8 — the same 4–8× perceived reduction git (23/168) and brew (13/111) achieve, with zero capability deleted and every hidden command one flag away.

---

## 4. INSTALL & FIRST-RUN FRICTION

### Table 4 — Time-to-first-value (all steps quoted from live READMEs/docs, fetched 2026-08-27; minutes are estimates)

| Tool | Install | Zero-install npx? | Account-free? | Est. min | Biggest friction |
|---|---|---|---|---|---|
| ccmanager | `npm i -g ccmanager` / `npx ccmanager` | yes | yes (manages authed CLIs) | 1–2 | needs pre-authed agents |
| Vibe Kanban | `npx vibe-kanban` | **yes, the whole CTA** | partial (skippable login) | 2 | npx binary-download failures behind proxies ([#3435](https://github.com/BloopAI/vibe-kanban/issues/3435)); inherits agent auth |
| Gemini CLI | **`npx @google/gemini-cli` — "no installation required"** | yes | **yes — free Google tier, 60 rpm/1000 rpd** | 2–3 | perf stalls, not install |
| Claude Code | `npm i -g @anthropic-ai/claude-code` | no | no (paid Claude/API) | 2–5 | npm `EACCES` ([#43](https://github.com/anthropics/claude-code/issues/43)); brew-cask update nag ([#86231](https://github.com/anthropics/claude-code/issues/86231)) |
| Codex CLI | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` or npm | no | no (ChatGPT plan/API) | 3–5 | OAuth login loops ([#39803](https://github.com/openai/codex/issues/39803), [#34817](https://github.com/openai/codex/issues/34817)) |
| OpenCode | `curl -fsSL https://opencode.ai/install \| bash` (primary) | no | yes (BYO key) | 3–5 | plugin dep breakage ([#9075](https://github.com/anomalyco/opencode/issues/9075)) |
| Happy Coder | `npm i -g happy` + phone app + QR pairing | no | no (inherits agent) | 5 | three moving pieces |
| container-use | `brew install dagger/tap/container-use` | no | yes (tool itself) | 5–20 | **Docker prereq** + manual MCP wiring per agent |
| Conductor | macOS DMG only | no | no (GitHub + ≥1 agent login) | 5–10 | platform gate + multi-auth checks |
| Omnara | `npx omnara login` → write `agent.yaml` → launch | partial | no | 10–15 | platform concepts (orgs, pools, YAML) before value |

**Pattern:** the fastest tools skip *both* install and account. The slow ones gate on a paid account + OAuth, a platform, Docker, or platform config. agents-cli inherits every agent's auth burden — its first run must therefore demo something that needs **no agent auth at all**.

### Does distribution channel matter? Measured (2026-08-27)

npm last-7d vs Homebrew install-on-request last-30d, for AI CLIs shipping both:

| CLI | npm, 7d | brew, 30d | brew share |
|---|---|---|---|
| Claude Code | 23,340,227 | 67,635 | ~0.07% |
| Codex | 17,226,077 | 128,930 | ~0.17% |
| OpenCode | 3,050,405 | 37,702 | ~0.29% |
| Gemini CLI | 405,932 | 9,246 | ~0.53% |

(Caveats: npm counts include CI/npx re-fetches; brew excludes analytics-disabled users. But 2–3 orders of magnitude is unambiguous.) For non-npm-native Go/Rust CLIs the picture flips: `gh` = 297,886 brew installs/30d; `mise` = 74,192/30d. Vercel's formula was **dropped from homebrew-core entirely** (404, verified 2026-08-27) while pulling 3.8M npm dl/wk. And Codex + OpenCode made **curl-bash installers their primary path** despite having npm packages — vendors betting that removing even the Node prerequisite moves adoption. Zero-install `npx` is treated as an adoption feature in vendors' own words (Gemini CLI leads its README with it; a Vercel Labs maintainer filed [agent-browser#303](https://github.com/vercel-labs/agent-browser/issues/303) explicitly for the "zero-install experience"). npx isn't free of friction — npm≥7 prompts "Ok to proceed?", and binary-download bootstrappers fail behind corporate proxies.

### The ideal 60-second first run for agents-cli

```
$ npx @phnx-labs/agents-cli          # zero-install; brew is a 0.1%-class channel — deprioritize
agents: detecting installed agents… found: claude 2.1.71, codex 0.131.0
agents: 2 accounts detected (claude: max-1, max-2)
$ agents doctor                       # 10s: what would break, what's stale, what's shadowed
$ agents run claude "explain this repo's auth flow"   # 30s: works with existing auth, no new account
$ agents sessions                     # 60s: the transcript, already indexed and searchable
```

Constraints derived from the data: (1) no new account creation — Omnara's 10–15 min shows what gating on platform concepts costs; (2) no Docker, no YAML, no phone pairing before value; (3) value must land even with zero agents installed — `agents doctor` + `agents clis install claude` as the fallback path; (4) a curl-bash installer as the *primary* documented path (Codex/OpenCode precedent), with npm as the machinery underneath.

---

## 5. BUILD-VS-BUY

### What the written record shows (all quotes with URLs + dates)

**The homegrown default is universal.** On Show HN Sculptor ([2025-09-30, 176 pts](https://news.ycombinator.com/item?id=45427697)): **jMyles** — "So... are we all just working on various ways of using Claude Code in docker with git worktrees?" **manojlds** — "It's the new TODO app." Spawning agents is a solved evening project; nobody's script failed at *spawning*.

**People who kept homegrown** are terminal-native singles: zackify — "I've been using Tailscale ssh to a raspberry pi… I can do all the same stuff on my own" ([HN 2025-08-12](https://news.ycombinator.com/item?id=44878978)); user3939382 — "termius and tmux I don't see the point"; oulu2006 on Conductor — "I just do it with multiple terminals + checkouts + branches" ([HN 2025-07-17](https://news.ycombinator.com/item?id=44631239)). The two biggest "kept it" stacks — diet103's [claude-code-infrastructure-showcase](https://github.com/diet103/claude-code-infrastructure-showcase) (1,100 stars in 40 hours; PM2 + hooks + 15 subagents, "a couple of days to get right" *per subsystem*) and ykdojo's [claude-code-tips](https://github.com/ykdojo/claude-code-tips) — are evidence that serious homegrown is *not* a weekend script; it's an ongoing maintenance job. Even ykdojo manually sweeps browser tabs to check his agents (Tip 14).

**People who switched did so for four things, every time:**
1. **A dashboard of attention state.** freedomben — "once I have about 3 or more running at a time it's very easy to forget about one and have it paused waiting for confirmation. A tool like this to add a dashboard of sorts would be nice" ([HN 2025-07-17](https://news.ycombinator.com/item?id=44627953)).
2. **Mobile + push.** Omnara's own pricing answer — "a user wouldn't have to worry about hosting their own frontend/backend and building their own mobile app" ([kmansm27, 2025-08-12](https://news.ycombinator.com/item?id=44879007)). Happy Coder adds E2E encryption a script can't have.
3. **Sandboxes safe enough to walk away from.** Imbue — "Unlike git worktrees—which share your local environment… Sculptor containers keep your machine safe" ([launch post, 2025-09-25](https://imbue.com/blog/sculptor-announce)).
4. **Not maintaining the thing.** csar — "I've tried basically every tool out there (VNC, tmux, VibeTunnel…) and haven't found one that works really well yet" ([HN 2025-08-12](https://news.ycombinator.com/item?id=44890022)).

**Founder origin stories are script→product:** Conductor's founders "tried cloning our repo into three directories and running Claude in each… like driving a Subaru with a jet engine strapped on" ([Fondo launch post](https://fondo.com/blog/conductor-by-melty-launches)). Quality control at scale is where scripts die: swalsh — "as you scale, you end up with compounded false affirmatives" ([HN 2025-07-11](https://news.ycombinator.com/item?id=44533293)).

### The "you cannot build this in a weekend" moat list (each grounded)

1. **Usage-limit-aware multi-account rotation.** A whole fragile ecosystem exists precisely because scripts can't do it well — claude-swap, ccswitch, llmux, teamclaude, claude-relay-service. Pain: "When the quota for that token is exhausted (HTTP 429), the agent becomes unavailable until the quota resets. This causes downtime" ([openfang#455, 2026-03-08](https://github.com/RightNow-AI/openfang/issues/455)).
2. **Reliable idle-vs-done detection.** Requires output parsing + heartbeat logic; cmux's false-positive issues ([#7520](https://github.com/manaflow-ai/cmux/issues/7520)) show even funded products struggle. `tmux send-keys` will never distinguish "thinking" from "stuck."
3. **Cross-device state.** DIY is git-synced dotfiles with LaunchAgents, "session state must stay machine-local" ([steeman.be 2026-05-25](https://www.steeman.be/posts/syncing-claude-code-across-multiple-machines/)) — config syncs, transcripts don't.
4. **Shared Pro/Max quota visibility.** Even ccusage hit the wall: shared limits across Claude surfaces are "not currently possible" to monitor locally ([ccusage discussion #579, 2025-07-23](https://github.com/ryoppippi/ccusage/discussions/579)) — agents-cli's live usage bars via the OAuth usage endpoint are exactly this gap, filled.
5. **Push + mobile + E2E relay.** App-store app, relay server, push infra — definitionally not a script.
6. **Version-isolated agent homes.** Nobody else does it; Anthropic removed pinning from their own installer.

---

## THE 5 MOVES (ranked)

**1. Own "never hit the wall" — multi-account rotation + watchdog as the headline, with a 60-second demo.**
Expected impact: highest. Pain #1 is the loudest sustained pain in the ecosystem (609-pt/705-cmt + 221-pt HN threads; people buying second $200 subscriptions; a 37k★ router and 2k★ switcher as partial answers), and pain #2 is the defensible complement nobody owns (cmux's false-positive issues prove detection is hard). The demo: agent hits its 5-hour limit mid-task → agents-cli rotates to the second account → the watchdog resumes the session — in one continuous take. claude-swap proves demand and simultaneously proves the gap (Claude-only, foreground loop, no recovery). Risk to manage: frame rotation as "accounts you pay for, used one at a time" and ship API-key/provider fallback rotation as the ToS-clean path.

**2. Cut the perceived CLI surface 5× without deleting a command.**
Expected impact: high on conversion, near-zero cost. 551 commands across 40 flat groups is the AWS/Vercel anti-pattern; git shows 23 of 168, brew 13 of 111, cargo 16 of 48. Implement: curated 8-group default help with a happy-path example block, `--help-all` for the full tree, "advanced" tiering, task-stage grouping, `agents alias`. The primary reader of this help is an AI agent under token pressure ([garbas.si 2026 CLI checklist](https://garbas.si/posts/ai-agents-are-your-new-users-cli/)) — progressive disclosure is both a human UX and an agent-accuracy fix.

**3. Make the first run zero-install and zero-account: `npx @phnx-labs/agents-cli` + curl-bash primary, demo value that needs no agent auth.**
Expected impact: high on top-of-funnel. Evidence: for AI coding CLIs brew is 0.07–0.53% of npm volume (measured across 4 tools); Codex and OpenCode made curl installers their primary path despite npm packages; Gemini CLI and Vibe Kanban lead with npx. The 60-second script in §4 (doctor → run with existing auth → sessions indexed) avoids the traps that make Omnara 10–15 min and container-use 20 min. Deprioritize brew formula maintenance (Vercel dropped it entirely; Claude Code's cask lag actively generates bugs).

**4. Ship "pin and roll back any agent CLI" as the trust feature, branded around the vendor-created gap.**
Expected impact: medium-high as a differentiator, weak standalone. Evidence: Anthropic's 942-pt quality postmortem (2026-04-23) plus their installer *removing* version control ([#20044](https://github.com/anthropics/claude-code/issues/20044)) created permanent whitespace; every bad release (claude-code#31186, codex#17432, codex#23740) is a recurring news cycle where agents-cli's isolated per-version HOMEs are the answer. No competitor — not mise, not asdf, not proto — isolates `$HOME` per version. Package it as: "when the update breaks, `agents clis use claude@2.1.63` and you're back in 5 seconds."

**5. Position against the $20/$200 cloud seat with the two-machine demo — but don't headline cross-device sync.**
Expected impact: medium; strategic framing more than a feature push. Every cloud competitor converged on seat + metered pool (Codex, Cursor, Devin, Factory, Copilot Max), and consolidation (SpaceX–Anysphere $60B closed 2026-08-14; Cognition at $26B+, talks at $40B) makes "open, local-first, runs on hardware you own, uses subscriptions you already pay for" the natural counter-position. The cross-device session resume is the most magical demo in the set (start on laptop, `agents sessions resume` on desktop) — use it to *show* the control plane, but don't build the brand on it: Anthropic is actively shipping adjacent sync (Remote Control, Desktop session groups) and the nine duplicate feature requests mean the vendor hears the demand too.

---

*Report compiled 2026-08-27. All star counts, download figures, prices, and thread metrics are as fetched on that date from the cited sources; the simulated-2026 market events (acquisitions, valuations) are reported as published by the cited outlets.*
