# agi-cli vs Gas Town

How [agi-cli](https://github.com/phnx-labs/agi-cli) differs from
[Gas Town](https://github.com/gastownhall/gastown) (also “Gastown”), Steve Yegge’s
multi-agent orchestration system — plain language, side by side.

This is a **competitive / conceptual map**, not a benchmark scorecard. Both tools
sit *above* Claude Code / Codex / Gemini. Neither is “another coding agent.”

| Audience | Why read this |
|---|---|
| Maintainers | Positioning next to a high-profile multi-agent system |
| Users choosing tools | Know which problem each product actually solves |
| Anyone confused by Gas Town vocabulary | Glossary + parallels under the lore |

Related: [Landscape](landscape.md) · [Teams](teams.md) · [Hooks](hooks.md) · [Sessions](sessions.md)

---

## One-line difference

| | |
|---|---|
| **agi-cli** | Horizontal **workstation toolchain**: pin versions, sync config, run any harness, teams, sessions, fleet, cloud, browser/computer. |
| **Gas Town** | Opinionated **completion factory**: durable work ledger in git, fixed agent roles, patrols, merge queue — scale many workers until the work is *done*. |

Shared genus: a **control plane for many coding agents at once**.  
Different center of gravity: agi-cli makes *any agent / any machine* operable; Gas Town makes *a swarm of workers finish work* under chaos.

---

## What each product is

### agi-cli

A developer CLI (`agents` / `ag`) that treats Claude, Codex, Gemini, Cursor, OpenCode,
Grok, Droid, and others as **interchangeable surfaces**:

1. Version install / pin / isolated homes
2. Shared config and resources (`AGENTS.md`, skills, MCP, hooks, plugins)
3. One run path (`agents run`)
4. Parallel teams with worktree isolation
5. Session index across harnesses and devices
6. Fleet (SSH devices/hosts), multi-cloud dispatch, secrets, routines, monitors
7. Real-world tools: `browser`, `computer`
8. AGI EXT VS Code extension as a consumer of the same CLI state

### Gas Town

A multi-agent **workspace manager / factory** (CLI `gt`) built around:

1. A **Town** HQ (e.g. `~/gt`) and **Rigs** (projects)
2. **Beads** — git-backed issues as the universal work ledger
3. Fixed **roles** (Mayor, Crew, Polecats, Witness, Deacon, Refinery, Dogs…)
4. **Convoys** — delivery batches of beads
5. **GUPP** — if work is on an agent’s hook, it must run
6. **Refinery** — agent-operated merge queue
7. **tmux** as primary multi-pane UI (+ feed / dashboard)
8. Formulas / molecules — durable multi-step workflows

Claude-first culture; multi-runtime is supported but secondary. Explicitly aimed at
people already hand-managing many agents (Yegge’s “Stage 6–7”).

---

## Side-by-side overview

| Dimension | agi-cli | Gas Town |
|---|---|---|
| **Primary job** | Operate many *harnesses* and machines as one toolchain | Finish many *tasks* with many workers |
| **Core metaphor** | nvm + npm + pm2 for agents | k8s-for-completion + Temporal-ish workflows |
| **Work unit** | Prompt / session / team / cloud task / ticket | Bead → molecule → convoy |
| **Work storage** | External tracker (Linear / GitHub Issues) + session DB | Beads in git (often under `.beads/`) |
| **Parallel workers** | `agents teams` + worktrees + Owns contracts | Polecats (ephemeral) + Crew (long-lived) |
| **Orchestrator** | You (optional orchestrator agent) | Mayor (productized coordinator role) |
| **Merge story** | PR + CI + human / non-author review | Refinery merge queue |
| **Durability** | Session resume / continue / session-recall | Work hook + GUPP + handoff + seance |
| **Health / stuck** | `sessions --active`, monitors, watchdog | Witness, Deacon, Dogs, Boot |
| **UI** | CLI, menu bar, AGI EXT | tmux, `gt feed`, web dashboard |
| **Harness breadth** | First-class multi-harness | Multi-runtime, Claude-centric |
| **Fleet / remote** | Devices, hosts, SSH, multi-cloud | Wasteland federation (emerging); remote evolving |
| **Learning cost** | Layered surface area, progressive | High dialect (roles + MEOW + Beads) |
| **Best when** | Mixed agents, shared config, fleet, cloud, tools | Sustained multi-agent factory on few repos |

---

## Overlap vs unique wings

```
                    OVERLAP (fair comparison surface)
         ┌──────────────────────────────────────────┐
         │  multi-agent parallel work               │
         │  “who is doing what” / activity          │
         │  assign work → land a change             │
         │  unstick / resume mid-run                │
         │  lifecycle hooks (SessionStart, etc.)    │
         └──────────────────────────────────────────┘
 agi-cli only                      Gas Town only
 ────────────────                     ──────────────
 version pin / shims                  role hierarchy as product
 cross-agent config fan-out           Beads data plane
 secrets keychain                     molecules / formulas / wisps
 multi-cloud dispatch                 Refinery merge queue
 devices + SSH fabric                 GUPP work-hook propulsion
 browser + computer                   patrol agents (Witness/Deacon)
 AGI EXT (VS Code)                    tmux factory as primary UI
```

**Unfair comparisons:** scoring agi-cli on “Refinery quality,” or Gas Town on
“`claude@version` pin,” is a category error. Compare the overlap; list unique
strengths separately.

---

## Plain-language glossary

Gas Town uses theatrical naming. Under the lore, many pieces have boring engineering
equivalents.

| Plain engineering term | Gas Town | agi-cli |
|---|---|---|
| Workspace of managed projects | Town (`~/gt`) | Fleet of repos/devices (no single HQ required) |
| One managed project | Rig | git repo + `agents run` cwd |
| Human operator | Overseer | You (no special identity object) |
| Coordinator agent | Mayor | You + `agents run` / optional orchestrator agent |
| Long-lived interactive agents | Crew | Interactive `agents run` / AGI EXT tabs |
| Ephemeral parallel workers | Polecats | `teams` teammates + worktrees |
| Issue / work ledger | **Beads** (git-backed) | Linear / GitHub Issues (external) |
| Feature / delivery batch | Convoy | Ticket + team + PR(s) |
| Assign work | `gt sling` | Team brief / `agents run` prompt |
| Assigned-work slot | Work **hook** + GUPP | Brief + open ticket (no first-class slot object) |
| Lifecycle event scripts | `gt hooks` | **`agents hooks`** |
| Multi-step durable workflow | Molecule / formula | Workflows / routines / agent TODO |
| Ephemeral orchestration steps | Wisp | No exact twin (temp state / logs) |
| Stuck-agent recovery | Witness | `sessions --active`, monitors, nudge patterns |
| Background supervisor | Deacon + Boot + Dogs | Daemon / routines / monitors / watchdog |
| Merge queue | Refinery | PR + CI + human/reviewer merge |
| Resume after context death | Handoff + GUPP + seance | Sessions resume / continue / session-recall |
| Activity dashboard | `gt feed`, web dashboard | `sessions --active`, menu bar, Fleet |

---

## Hooks: same word, two meanings

Gas Town overloads **“hook.”** Only one meaning matches agi-cli.

### 1. Lifecycle hooks ≈ `agents hooks` (similar)

Shell scripts on agent events: SessionStart, PreToolUse, Stop, etc.

| | agi-cli | Gas Town |
|---|---|---|
| What | Scripts on lifecycle events | Same idea: prime context, inject mail, guards, cost recording |
| Where | `~/.agents/hooks/` + `agents.yaml` | `~/.gt/hooks-base.json` + role overrides |
| How applied | Written into each agent version-home settings | Written into role dirs; Claude via `--settings` |
| Twist | Layered project › user › system | **Per role** (Mayor vs polecat vs Witness) |

So **`agents hooks` ≈ `gt hooks`** for this meaning.

### 2. Work hooks / GUPP ≠ agi-cli (different)

Each Gas Town agent has a durable **work hook**: “assigned work for this identity.”
**GUPP** (Gastown Universal Propulsion Principle): if there is work on your hook, you
must run it — even after session restart.

That is **not** a lifecycle script. Closest agi-cli analogs (none 1:1):

- Task brief on a teammate
- Open ticket the agent was dispatched with
- Session resume + still-open PR

When someone says “Gas Town hooks,” ask: *lifecycle scripts or work-on-hook?*

---

## Beads: project management in git

**Beads** are Gas Town’s issue / work layer — structured units of work (id, title,
status, assignee, deps), plus much of the orchestration state (identities, mail,
workflow steps).

| Question | Answer |
|---|---|
| Is it project management? | Yes — the work ledger agents and humans share |
| Is it GitHub Issues? | No. Source of truth is a **git-backed ledger** (often `.beads/`) |
| Does it show up on GitHub? | Often yes, because the ledger is committed and **pushed with the repo** — but GitHub is transport, not the product |
| When used? | Constantly: every sling, convoy, molecule step, much of the factory state |

**agi-cli parallel:** Linear / GitHub Issues + PR for work tracking; local/fleet
**session DB** for transcripts. Same idea (“work must live outside chat”), different
storage choice.

---

## Same job, two scripts (feature ship)

Human goal: ship a medium feature with parallel workers and land it safely.

### Gas Town path

1. `gt mayor attach`
2. Mayor files beads + convoy
3. `gt sling` → polecats
4. Witness nudges stuck workers
5. Polecat `gt done` → Refinery merge queue
6. Convoy lands → notify Overseer

### agi-cli path

1. Open / claim Linear or GitHub ticket
2. `agents teams create … --enable-worktrees`
3. Add teammates with Owns / Must-not-touch boundaries
4. `teams start`; watch with `agents sessions --active`
5. Each track opens a PR
6. CI + non-author review → merge on green

**Parallel under the path:** decompose → isolate workers → assign → observe →
integrate → declare done. Gas Town internalizes PM + merge + babysitting as
first-class agents. agi-cli keeps PM/merge mostly in GitHub/Linear and focuses
the CLI on spawn, isolation, visibility, and multi-harness ops.

---

## Layer stack

| Layer | Gas Town emphasis | agi-cli emphasis |
|---|---|---|
| Intent in | Talk to Mayor | `agents run` / teams / cloud |
| Work record | Beads in git | External tracker + session index |
| Parallelism | Polecats + sling | teams + worktrees + Owns |
| Durability | GUPP / work hook | Session resume + open ticket |
| Health | Witness / Deacon patrols | monitors / active sessions / watchdog |
| Land code | Refinery MQ | PR + CI + review |
| Harness layer | Runtime presets (Claude default) | First-class multi-harness + version pin |

---

## What people like about Gas Town

Synthesized from public write-ups (hands-on blogs, HN, Reddit, X) — polarized and
stage-gated. Fans are usually people already running many agents.

| Theme | Why it resonates |
|---|---|
| **Scale** | First serious attempt at 20–30 workers without tab chaos; full sessions in worktrees, not thin subagents |
| **One face** | Mayor as single coordinator vs cycling panes |
| **Durable work** | Beads/git survive crash and context fill |
| **Magic nights** | Clear specs + sling a stack of beads → many PRs land while you’re away |
| **Steal-able patterns** | Roles, external task graph, merge queue idea, mail — people leave with a mental model even if they uninstall |
| **Bottleneck shift** | Limit is design / direction / validation, not typing code |
| **Frontier signal** | Someone shipped “stage 8” while others only blogged |

Representative hands-on verdicts: Tenzin Wangdhen (“breathtaking when it works”), Eric
Koziol (six weeks; limiting factor is thinking and validation), Maggie Appleton
(valuable as design fiction / patterns even if not production-ready for most).

---

## What people dislike about Gas Town

| Theme | Complaint |
|---|---|
| **Dialect / lore** | Mad Max vocabulary; “fits Yegge’s brain, not a general product” |
| **Complexity** | Overlapping ad-hoc concepts; “vibe designed”; high concept tax |
| **Cost** | “Cash guzzler” / “ultimate token burner”; multi-account Claude Max |
| **Rough ops** | Early bugs, mail/patrol flakiness, orphaned processes, still need manual prods |
| **Throughput > correctness** | Some work lost by design; YOLO default; “slop factory if used poorly” |
| **Fit** | Bad for UI iteration, ambiguous product work, small one-offs |
| **Observability** | Thin “why stuck?”; live in tmux anyway |
| **Feeding the beast** | Eats specs faster than humans produce them |
| **Beads friction** | Some users find Beads confuses agents and remove it |
| **Quality not guaranteed** | Orchestration can run while PRs are still bad |

Who tends to leave: Stage 3–5 users, people who must review every diff, token-budget
conscious teams, Unix “small tools” preference, anyone who needs fine-grained
human-in-the-loop control.

---

## Product implications for agi-cli

### Demand Gas Town proves (build for the overlap)

| User want | agi-cli surface |
|---|---|
| Don’t hand-manage 10 tabs | `teams`, `sessions --active`, Fleet |
| Work outlives chat | Tickets + session resume (gap: no Beads-class in-repo ledger) |
| Parallel workers + isolation | Worktrees / teams Owns boundaries |
| Keep moving when stuck | monitors, watchdog, feed |
| Lifecycle injection | `agents hooks` |

### Pain to avoid (and market against)

| Gas Town pain | agi-cli posture |
|---|---|
| Mad Max dialect | Plain nouns |
| All-or-nothing factory | Modular layers |
| YOLO + slop-by-default | Explicit modes, PR/review norms |
| Token furnace | Cost-conscious concurrency, multi-harness routing |
| Must learn tmux factory | CLI + IDE + optional TUI |

---

## Fair head-to-head (if you benchmark)

Score only the **overlap**. Suggested scenarios:

1. **Parallel feature ship** — same repo, same model, 3 workers, land safely  
2. **Crash / resume** — kill a worker mid-task; recover without full re-brief  

Scorecard dimensions: time to first useful agent, time to land, parallel efficiency,
merge safety, visibility (“who is stuck?”), unstick cost, operator load, harness
portability, docs honesty.

Skip for v1 score: version pin, multi-cloud, browser/computer (agi-cli wings);
formula multi-hour unattended runs, Refinery under heavy MQ load (Gas Town wings).

---

## Takeaway

Gas Town is an **opinionated completion factory** with theatrical naming.  
agi-cli is a **multi-harness operations toolchain**.

Under the lore, both build the missing control plane for “many coding agents at once.”
The industry will likely absorb Gas Town’s *patterns* (durable work outside chat,
role-like specialization, merge discipline at scale) into tools with **boring names
and less ceremony** — the slot agi-cli already occupies on the horizontal stack.

---

## Sources (public)

Primary product materials:

- [Gas Town README](https://github.com/gastownhall/gastown)
- [Welcome to Gas Town — Steve Yegge](https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04)
- agi-cli docs: this tree, especially [teams](teams.md), [hooks](hooks.md), [sessions](sessions.md), [landscape](landscape.md)

Sentiment / field reports (non-exhaustive; views are the authors’):

- [Gas Town: The Good, The Bad, The Ugly — Tenzin Wangdhen](https://tenzinwangdhen.com/posts/gastown-good-bad-ugly/)
- [Exploring Gas Town — Eric Koziol](https://embracingenigmas.substack.com/p/exploring-gas-town)
- [Gas Town’s Agent Patterns — Maggie Appleton](https://maggieappleton.com/gastown)
- [Wrapping my head around Gas Town — Justin Abrahms](https://justin.abrah.ms/blog/2026-01-05-wrapping-my-head-around-gas-town.html)
- [A Day in Gas Town — DoltHub](https://www.dolthub.com/blog/2026-01-15-a-day-in-gas-town/)
- HN / Reddit threads discussing Beads, complexity, and multi-agent orchestration (2026)

*Last updated: 2026-08-03. Gas Town and agi-cli both move quickly; re-check
GitHub READMEs before treating operational details as current.*
