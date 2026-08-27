---
kind: plan
surface: cli
title: "Adoption plan for agents-cli: fix the entity, cut the front door, own the two pains that get a million views"
summary: "17 stars against peers at 8k-55k, four names for one product, and 45% of 564 commands dead on the author's own machine — yet its weekly npm downloads sit in the same order of magnitude as peers with a thousand times the stars. The deficit is visibility, not product: collapse the identity, cut the front door, and lead with the two pains that get a million views."
status: draft
project: AGI
repository: phnx-labs/agents-cli
harness: claude
agent: claude-opus-5
host: zion
date: 2026-08-27
links:
  - https://share.agents-cli.sh/muqsitnawaz/agents-cli-command-reference-rush-2396
  - https://is-agentic.com/scan/agi-cli.sh
---

## Focus for review

Five decisions. Two of them are yours and nobody else's.

1. **DECISION 1 — the name.** The product answers to `agents-cli`, `agi-cli`, `AGI CLI`, and the binary `agents`. Recommendation: **Agents CLI wins**, everything else redirects.
2. **DECISION 2 — the license claim.** `DESIGN.md:4` here, and `llms.txt` on the live site (which lives in the separate `agent-cli-web` repo), both say "open source (Apache-2.0)". `LICENSE` is FSL-1.1-Apache-2.0, and `README.md:1652` already states that correctly. Recommendation: **fix the two wrong strings**; relicensing is a separate, larger call.
3. **The wedge.** Lead with *rotate accounts and resume through the limit*, not with teams, worktrees, or browser. Worktrees are table stakes in 2026 and Conductor and Orca own the pictures.
4. **The cut, and the door.** `agents --help` names 40 of 69 groups and never mentions the other 29 — including `ssh`, the 5th most-used group in the CLI. Order the front door into 10 groups *and* add the full-listing pointer git has had for twenty years. No command is deleted.
5. **What we do NOT do.** No `agents.txt`, no experimental MCP server cards, no Wikipedia page, no Product Hunt as the spark. Evidence for each below.

## Purpose

You asked: why is adoption low when the tool is strong, why do developers keep building their own instead, how do we get Codex, Claude, and Perplexity to surface it, and does the 551-command surface hurt. You asked for it grounded in real research and in your own session data rather than opinion.

Four evidence streams ran in parallel: a reducer over **9,223 local sessions**, a Grok pass over live X data, a Codex pass over agent-discoverability standards, and a direct `is-agentic` audit of the live site.

The finding is that **the product is not the bottleneck.** Three cheaper things are.

<div class="artifact-callout">
<strong>The one-line diagnosis.</strong> A developer who would love this tool cannot find it, cannot name it, and if they land on it, is handed 69 top-level command groups and the sentence "A framework for running a distributed agent factory." Every one of those is fixable in days, not quarters.
</div>

## Evidence 1: your own sessions say the surface is 45% dead

A reducer parsed every `agents` invocation inside a shell tool call across `~/.agents/.history` and matched each against the canonical `cli/docs/command-index.json`. Transcripts come in two shapes — line-delimited JSONL (Claude, Grok) and whole-file JSON (Codex, OpenCode, Cursor, Droid, Kimi, Muse) — and the reducer reads both.

```
$ python3 adoption-evidence/mine-command-usage.py
transcript files seen:              11,812
DISTINCT sessions (deduped by id):   9,223
duplicate copies skipped:            2,589
total `agents` executions matched:  85,285
distinct commands ever executed:    408 / 564
NEVER executed:                     156 (28%)

top  20 commands =  70.4% of all executions
```

Deduplication is load-bearing and was not obvious. `~/.agents/.history` keeps repeat copies of the same transcript under `backups/` and under `runs/<job>/<timestamp>/` — one security-sweep session appears under six different run timestamps. Keying reach on the file path counted that session six times. Keying on session id drops **2,589 duplicate copies, 22% of the files**, leaving 9,223 distinct sessions.

Getting this right took three attempts, and the two failures are worth recording because both produced confident, wrong numbers.

**Attempt one kept whichever copy `rg -l` returned first.** `rg` walks in parallel, so a stale truncated `backups/` snapshot sometimes beat the complete copy under `versions/`; totals swung 15% between runs of the same script on the same data.

**Attempt two keyed on the bare filename.** That merged real sessions: 118 distinct Kimi sessions all end in `agents/main/wire.jsonl`, and Antigravity and Gemini both use `transcript.jsonl`. Kimi collapsed from 222 sessions to 3, and 17 commands were misreported as *never executed* when they had in fact run.

**The committed version keys on the store-relative path tail** — `sessions/wd_.../session_<uuid>/agents/main/wire.jsonl` — which is identical across duplicate copies and unique per session, and resolves each id to a canonical file deterministically (prefer `versions/`, then the largest copy, then a stable path). Every sort has a stable tiebreak. Three consecutive runs produce byte-identical output, verified before committing.



| Tier | Commands | Share of surface | What it means |
|---|---:|---:|---|
| Daily driver (50+ sessions) | 63 | 11% | The real product |
| Occasional (10-49 sessions) | 117 | 21% | Earns its keep |
| Rare (3-9 sessions) | 130 | 23% | Depth, keep hidden |
| Near-dead (1-2 sessions) | 98 | 17% | Hide or fold |
| Never executed | 156 | 28% | Hide or fold |

The five tiers sum to 564, and every figure above is printed by the committed script into `adoption-evidence/command-usage-report.txt`.

If **45% of commands are dead or near-dead for the person who wrote them**, a first-time user will not discover the 11% that matter by reading `--help`.

<div class="artifact-callout artifact-callout-warn">
<strong>What this measurement does and does not cover.</strong> The corpus is overwhelmingly Claude: 7,336 of 9,223 distinct sessions, and 2,342 of the 2,400 that contained a matched execution. Codex contributed 552 sessions but only 1 with a hit, and SQLite-backed stores (some Antigravity, Cursor, Muse) are not read at all. So this is <em>how one power user and their Claude agents drive the CLI</em>, not a cross-harness usage census. That is the right population for deciding what the front door shows, and the wrong population for retiring a command outright — which is why the plan hides tiers 4 and 5 rather than deleting them. The per-harness coverage table is printed in the committed report.
</div>

The counts also expose which groups are actually the product:

| Group | Sessions reached | Group | Sessions reached |
|---|---:|---|---:|
| `sessions` | 965 | `feed` | 216 |
| `secrets` | 884 | `view` | 205 |
| `browser` | 816 | `routines` | 195 |
| `run` | 457 | `add` | 135 |
| `ssh` | 368 | `computer` | 132 |
| `teams` | 284 | `sync` | 132 |
| `devices` | 277 | `daemon` | 110 |
| `repos` | 246 | `doctor` | 107 |

Counts are session reach, taken verbatim from the committed report. Sixteen groups clear 105 sessions; the remaining fifty-three share the same visual weight in `agents --help`.

### Surface area against comparable CLIs

Counting the same way for every tool — the command entries each names in its own top-level `--help`:

```bash
for c in git bun deno supabase gh kubectl docker vercel agents; do
  echo "$c: $($c --help 2>&1 | grep -cE '^\s{2,6}[a-z][a-z0-9_:-]+\s{2,}')"
done
```

| CLI | Entries in `--help` | Total command groups | Pointer to the rest? |
|---|---:|---:|---|
| `git` | 23 | hundreds | Yes — `--help` ends with *"'git help -a' … list available subcommands"* |
| `bun` | 20 | — | — |
| `deno` | 28 | — | — |
| `supabase` | 34 | — | — |
| `gh` | 40 | — | plus `gh extension` |
| `kubectl` | 43 | — | — |
| `docker` | 57 | — | Not needed — `--help` already lists effectively everything |
| `vercel` | 60 | — | — |
| **`agents`** | **26** | **69** | **No** |

<div class="artifact-callout artifact-callout-warn">
<strong>The surface problem is not the count — it is the missing door.</strong> Three drafts of this plan got this wrong before it was measured properly. The first claimed <code>agents --help</code> shows 69 entries (that is the group total from <code>cli/docs/command-index.json</code>, not the help output). The second claimed it names 26 of 69 (that is the one-liner's row count, which only matches the aligned two-column entries). The third attempt regex-matched each group name against the whole help text, which credited a group for appearing inside some <em>other</em> command's prose: <code>auth</code> matched "(host CLI + model + auth) harnesses" (which describes <code>harness</code>), <code>open</code> matched "(open blocks waiting on you)" (which describes <code>feed</code>). Restricting the match to the leading command token of a help line, plus explicit <code>agents &lt;name&gt;</code> invocations, <code>agents --help</code> <strong>names 40 of its 69 groups and never mentions the other 29</strong>, with no pointer to a full listing. Grepping its output for one returns a single unrelated <code>--names</code> example. git names about the same number of entries, 23, but closes by telling you where the rest live.
</div>

And the 29 that go unmentioned are not the obscure tail. Ranked by the session-reach measurement above, and reproducible with `adoption-evidence/help-coverage.py`:

| Unnamed in `--help` | Sessions reached | Rank among all 69 groups |
|---|---:|---|
| `ssh` | 368 | **5th** |
| `repos` | 246 | **8th** |
| `computer` | 132 | 13th |
| `notify` | 92 | 18th |
| `list` | 67 | 22nd |
| `monitors` | 54 | 24th |
| `message` | 48 | 26th |
| `auth` | 24 | 37th |

`agents ssh` is the fifth most-used group in the entire CLI and a developer reading `--help` will never learn it exists. That reframes the fix: tiering the front door is only half of it, and the half that actually matters is adding the pointer git has had for twenty years, so the other 29 groups stop being invisible.

## Evidence 2: the entity is fragmented across four names

`is-agentic` (Vercel's agent-readiness scanner; the scan reports 26 checks eligible for this site — 9 essential, 17 recommended) scored the live site and returned a specific, damning check:

```
score 63 / 100 — "Important blockers remain"
FAILED  recommended  Brand name discoverability
  "agi-cli" search returned 10 results but domain did not appear
PARTIAL recommended  Developer resource discoverability
  Name search surfaced no pages on agi-cli.sh
```

Probing the identity directly:

```bash
$ curl -sI https://agents-cli.sh/ | grep location
location: https://agi-cli.sh/            # the marketed domain redirects away

$ curl -s https://registry.npmjs.org/@phnx-labs/agents-cli | jq -r .repository.url
git+https://github.com/phnx-labs/agi-cli.git

$ head -5 README.md | grep '^#'
# agi-cli                                 # README title disagrees with npm name

$ curl -s https://api.github.com/repos/phnx-labs/agi-cli | jq .stargazers_count
17
```

Codex's research explains why this is fatal for the "get Codex, Claude, and Perplexity to recommend us" goal. LLM recommenders exhibit documented **popularity and exposure bias**: they surface what appears repeatedly and consistently in their corpus ([Amazon Science](https://assets.amazon.science/a7/b5/145fc4734ee6abc2af4ce3b05943/large-language-models-as-recommender-systems-a-study-of-popularity-bias.pdf), [popularity-bias survey](https://link.springer.com/article/10.1007/s11257-024-09406-0)). Four names split the corpus four ways. There is no single string for a model to associate with "run multiple coding agents in parallel".

### The license contradiction

Two marketing surfaces contradict the actual `LICENSE`. The README does not — it is already correct, and its wording is the model to copy.

| Source | Claim | Correct? |
|---|---|---|
| `LICENSE` line 1 | Functional Source License, Version 1.1, Apache 2.0 Future License | — |
| `cli/package.json:80` | `"license": "FSL-1.1-Apache-2.0"` | Yes |
| `README.md:1652` | "FSL-1.1-Apache-2.0 … becomes Apache-2.0 two years after release" | Yes |
| `DESIGN.md:4` | "A Phoenix Labs OSS product (**Apache-2.0**)" | **No** |
| `llms.txt` on the live site | "Free and open source (**Apache-2.0**)" | **No** |
| GitHub API | `"license": NOASSERTION` | — |

FSL is source-available, not OSI open source. A skeptical developer, the exact person we are trying to convert, checks the LICENSE file. Finding a false OSS claim is worse than finding FSL honestly labeled.

Note on scope: `llms.txt` is **not in this repo**. `.gitignore:103-104` excludes `/website/` with the comment *"lives in agent-cli-web, not here"*, so fixing it needs a companion PR in `agent-cli-web`. `DESIGN.md` is fixable here.

## Evidence 3: the market says two pains, and we lead with neither

Grok searched live X and pulled engagement numbers. The pains ranked by actual posting volume and reach:

| Rank | Pain | Peak evidence | Solved by agents-cli? | Do we lead with it? |
|---|---|---|---|---|
| 1 | **Usage limits killing a run** | [@ClaudeDevs auto-continue](https://x.com/ClaudeDevs/status/2088014831605702937) 15,904 likes, 1.4M views; [@flavioAd](https://x.com/flavioAd/status/2077118895635206291) 3,608 likes | Yes, account rotation plus usage bars | **No** |
| 2 | **Agent stalled on needs-input while you are away** | [@housecor](https://x.com/housecor/status/2079584079599501666) 152 likes; Happy at 23.5k stars is built entirely on this | Yes, watchdog plus `needs-you` plus feed | **No** |
| 3 | Steer from another machine or phone | [@meetingattendee](https://x.com/meetingattendee/status/2080444427655614596) 1,250 likes | Yes, SSH fleet and `--device` | No |
| 4 | Multi-account juggling | ["is there something like a loadbalancer for multiple accounts?"](https://x.com/Taoufiq_Lotfi/status/2092361556419887582) | Yes | No |
| 5 | Parallel agents colliding in one checkout | [@paul_pbng](https://x.com/paul_pbng/status/2091865866359161316) | Yes, worktrees | Yes, but it is table stakes |
| 8 | CLI version pinning breaking | No high-engagement corpus found | Yes | Yes |

We lead with #5 and #8. The million-view posts are #1 and #2.

### Why developers build their own instead

Ranked by frequency in 2026 X threads, from Grok's pass:

1. **"It was missing my one feature and I patched it in 15 minutes"** — [@michlbrmly](https://x.com/michlbrmly/status/2092877983925047695) left Conductor for Paseo for exactly this.
2. **"tmux is enough; I do not want another harness"** — [@joshmanders](https://x.com/joshmanders/status/2085799417701937300): *"I don't need another harness."* Critically, the converts who *did* adopt something wanted a **status panel**, not a new runtime.
3. **Control, and "do not upload half the company"** — [@iret77](https://x.com/iret77/status/2054966813696442761), 305 likes, 1.3M views.
4. **The vendor locked the feature** — Anthropic's April 2026 policy shift blocked Pro and Max subscriptions on most third-party frameworks. Survivors (Conductor, Happy, Claude Squad) wrap the *already-authenticated local CLI*. agents-cli already does this, so say so loudly.

Reasons 1 and 2 are both arguments **for** a CLI and **against** a GUI. That is the opening.

### The peer set, with numbers

| Tool | Stars | Downloads/week | Distribution hook | Fate |
|---|---:|---:|---|---|
| [Orca](https://github.com/stablyai/orca) | 54.8k | — | "fleet of parallel agents, bring your own subscription", MIT, cross-platform | 50k stars in under six months |
| [claude-code-router](https://github.com/musistudio/claude-code-router) | 36.9k | 154,467 | Routes requests across providers | Thriving, and complementary |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | 27.9k | **1,495** | `npx vibe-kanban` | Company shut down Apr 2026 |
| [Happy](https://github.com/slopus/happy) | 23.5k | 5,736 | "Leave your desk. Keep your agents moving." | Thriving |
| [ccusage](https://github.com/ryoppippi/ccusage) | 18.2k | 87,857 | One job: show my token spend | Thriving |
| [Paseo](https://github.com/getpaseo/paseo) | 15.2k | — | open and hackable plugins | Thriving |
| [Claude Squad](https://github.com/smtg-ai/claude-squad) | 8.4k | 97 | tmux plus worktrees TUI, AGPL | Plateaued |
| [container-use](https://github.com/dagger/container-use) | 4.0k | — | `claude mcp add container-use` | Niche: isolation, not control plane |
| [Omnara](https://github.com/omnara-ai/omnara) | 2.8k | 726 | YC, "managed agent = managed database" | Modest |
| [claude-swap](https://github.com/realiti4/claude-swap) | 2.0k | 4,702 *(PyPI; 25 on npm)* | Threshold auto-switch across Claude subs | The one head-on rotation competitor |
| **agents-cli** | **17** | **2,961** | none yet | Alive, v1.22.51 today |

Downloads are npm `last-week` (2026-08-19 to 08-25) except where noted; Go- and Homebrew-distributed tools have no npm figure and show `—`, which means missing data, not zero. Happy's figure is for the `happy` package, which it migrated to from `happy-coder` (the deprecated alias still shows 501/week — quoting that one would understate a live competitor).

<div class="artifact-callout">
<strong>A supporting data point, not the headline.</strong> At 2,961 npm downloads a week, agents-cli sits in the same order of magnitude as Happy (5,736/week) — a live, thriving peer with 23.5k stars to its 17. Two caveats keep this from carrying more weight than that. Vibe Kanban's 1,495/week is the flattering comparison and is excluded from the claim, because it is a sunsetting project. And this package's own release cadence inflates its number by up to ~10% (bounded in <a href="#risks">Risks</a>). The thesis does not rest here: it rests on 17 stars against peers at 2.8k-54.8k, four names for one product, a false open-source claim, a FAILED brand-discoverability check, and a front door that never mentions 29 of its 69 groups, including the fifth most-used one. Those are all independently verified and none of them are download counts.
</div>

Note the graveyard: Terragon shut down Jan 2026, Crystal deprecated Feb 2026, Vibe Kanban's company Apr 2026. **Every dead one was a desktop GUI.** The survivors are a CLI-shaped install or a phone client.

### Two capabilities nobody else has, and one competitor we do have

Kimi's pass across the usage/account/version layer (36 tools, live star and download counts) found:

- **Per-version isolated-HOME management for agent CLIs has no competitor at all.** `mise`, `asdf`, and `proto` pin runtimes but share `$HOME`, so two Claude Code versions still fight over `~/.claude`. Anthropic's own native installer *removed* rollback — [claude-code#20044](https://github.com/anthropics/claude-code/issues/20044), 22 reactions: *"no version control, rollbacks, or professional package management."* The vendor widened this gap themselves. Grok found no high-engagement X corpus for it, so it is not the launch tweet, but it is a defensible moat and belongs in sentence three.
- **Rotation has exactly two competitors, both narrow.** [claude-swap](https://github.com/realiti4/claude-swap) (2.0k stars, 4,702 PyPI downloads/week) polls every 60s and switches at 90% of the window — but it is Claude-only and a foreground loop you babysit. `headroom` does Claude *and* Codex, at 99 stars. Nobody combines daemon-owned rotation with stall detection. The wedge holds, but the demo has to show the daemon doing it unattended, not a script you watch.
- **Stall detection is the genuinely hard half.** Competitors ship it and get it wrong (cmux's false-positive issues are public). "Idle versus done" is where a homegrown weekend script actually fails, which is the honest answer to the DIY objection.


## Current architecture

The adoption funnel as it exists today, and where each stage leaks. This is the system under change, not the CLI internals.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg viewBox="0 0 920 470" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Adoption funnel showing five stages, each with a measured leak">
  <defs>
    <marker id="ah" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto">
      <path d="M0,0 L0,6 L9,3 z" fill="#666"/>
    </marker>
    <marker id="ahl" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto">
      <path d="M0,0 L0,6 L9,3 z" fill="#f87171"/>
    </marker>
  </defs>

  <text x="16" y="26" fill="#888" font-family="ui-monospace,monospace" font-size="13">DEVELOPER WITH THE PAIN</text>
  <text x="904" y="26" fill="#888" font-family="ui-monospace,monospace" font-size="13" text-anchor="end">WHERE IT LEAKS</text>

  <rect x="16" y="44" width="470" height="58" rx="4" fill="#141414" stroke="#333"/>
  <text x="32" y="68" fill="#e8e8e8" font-family="ui-monospace,monospace" font-size="14">1 · Asks Codex / Claude / Perplexity</text>
  <text x="32" y="88" fill="#666" font-family="ui-monospace,monospace" font-size="12">"how do I run multiple coding agents in parallel?"</text>
  <line x1="486" y1="73" x2="556" y2="73" stroke="#f87171" stroke-width="1.5" marker-end="url(#ahl)"/>
  <rect x="560" y="48" width="344" height="50" rx="4" fill="#1a0f0f" stroke="#f87171" stroke-opacity="0.5"/>
  <text x="576" y="68" fill="#f87171" font-family="ui-monospace,monospace" font-size="12">Four names split the corpus.</text>
  <text x="576" y="86" fill="#888" font-family="ui-monospace,monospace" font-size="11">is-agentic: brand discoverability FAILED</text>

  <rect x="16" y="122" width="470" height="58" rx="4" fill="#141414" stroke="#333"/>
  <text x="32" y="146" fill="#e8e8e8" font-family="ui-monospace,monospace" font-size="14">2 · Lands on the repo or npm page</text>
  <text x="32" y="166" fill="#666" font-family="ui-monospace,monospace" font-size="12">17 stars · 64 KB README · "distributed agent factory"</text>
  <line x1="486" y1="151" x2="556" y2="151" stroke="#f87171" stroke-width="1.5" marker-end="url(#ahl)"/>
  <rect x="560" y="126" width="344" height="50" rx="4" fill="#1a0f0f" stroke="#f87171" stroke-opacity="0.5"/>
  <text x="576" y="146" fill="#f87171" font-family="ui-monospace,monospace" font-size="12">No social proof, no legible promise.</text>
  <text x="576" y="164" fill="#888" font-family="ui-monospace,monospace" font-size="11">Peers sit at 2.8k - 54.8k stars</text>

  <rect x="16" y="200" width="470" height="58" rx="4" fill="#141414" stroke="#333"/>
  <text x="32" y="224" fill="#e8e8e8" font-family="ui-monospace,monospace" font-size="14">3 · Checks the license</text>
  <text x="32" y="244" fill="#666" font-family="ui-monospace,monospace" font-size="12">site says Apache-2.0 · LICENSE says FSL-1.1</text>
  <line x1="486" y1="229" x2="556" y2="229" stroke="#f87171" stroke-width="1.5" marker-end="url(#ahl)"/>
  <rect x="560" y="204" width="344" height="50" rx="4" fill="#1a0f0f" stroke="#f87171" stroke-opacity="0.5"/>
  <text x="576" y="224" fill="#f87171" font-family="ui-monospace,monospace" font-size="12">Contradiction reads as bait-and-switch.</text>
  <text x="576" y="242" fill="#888" font-family="ui-monospace,monospace" font-size="11">Trust is the #3 reason devs build their own</text>

  <rect x="16" y="278" width="470" height="58" rx="4" fill="#141414" stroke="#333"/>
  <text x="32" y="302" fill="#e8e8e8" font-family="ui-monospace,monospace" font-size="14">4 · Installs, runs `agents --help`</text>
  <text x="32" y="322" fill="#666" font-family="ui-monospace,monospace" font-size="12">40 of 69 groups named · 29 invisible · no pointer</text>
  <line x1="486" y1="307" x2="556" y2="307" stroke="#f87171" stroke-width="1.5" marker-end="url(#ahl)"/>
  <rect x="560" y="282" width="344" height="50" rx="4" fill="#1a0f0f" stroke="#f87171" stroke-opacity="0.5"/>
  <text x="576" y="302" fill="#f87171" font-family="ui-monospace,monospace" font-size="12">Cannot find the 11% that matter.</text>
  <text x="576" y="320" fill="#888" font-family="ui-monospace,monospace" font-size="11">git names 23 but points at `git help -a`</text>

  <rect x="16" y="356" width="470" height="58" rx="4" fill="#0f1a0f" stroke="#a3e635" stroke-opacity="0.55"/>
  <text x="32" y="380" fill="#a3e635" font-family="ui-monospace,monospace" font-size="14">5 · Uses it and stays</text>
  <text x="32" y="400" fill="#888" font-family="ui-monospace,monospace" font-size="12">rotation, sessions, fleet, browser — all real, all working</text>
  <line x1="486" y1="385" x2="556" y2="385" stroke="#666" stroke-width="1.5" marker-end="url(#ah)"/>
  <rect x="560" y="360" width="344" height="50" rx="4" fill="#0f1a0f" stroke="#a3e635" stroke-opacity="0.35"/>
  <text x="576" y="380" fill="#a3e635" font-family="ui-monospace,monospace" font-size="12">No leak here. The product works.</text>
  <text x="576" y="398" fill="#888" font-family="ui-monospace,monospace" font-size="11">85,285 executions across 9,223 sessions</text>

  <text x="16" y="450" fill="#666" font-family="ui-monospace,monospace" font-size="11">All four leaks sit upstream of the product. None of them require shipping a feature.</text>
</svg>
<figcaption>Every measured leak sits before first use. Sources: the <code>is-agentic</code> scan of agi-cli.sh, the GitHub API, and the transcript reducer in <code>.agents/scratch/adoption-2026-08-27/</code>.</figcaption>
</figure>

## The command surface, drawn

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg viewBox="0 0 920 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="564 commands split into usage tiers; 254 are dead or near-dead">
  <text x="16" y="26" fill="#888" font-family="ui-monospace,monospace" font-size="13">564 COMMANDS, BY SESSIONS REACHED (9,223 DISTINCT SESSIONS)</text>

  <rect x="16"  y="46" width="96"  height="44" fill="#a3e635"/>
  <rect x="112" y="46" width="176" height="44" fill="#5f8f1f"/>
  <rect x="288" y="46" width="198" height="44" fill="#3a3a3a"/>
  <rect x="486" y="46" width="155" height="44" fill="#241414" stroke="#f87171" stroke-opacity="0.4"/>
  <rect x="641" y="46" width="247" height="44" fill="#1a0f0f" stroke="#f87171" stroke-opacity="0.6"/>

  <text x="24"  y="74" fill="#0a0a0a" font-family="ui-monospace,monospace" font-size="13" font-weight="700">63</text>
  <text x="120" y="74" fill="#e8e8e8" font-family="ui-monospace,monospace" font-size="13" font-weight="700">117</text>
  <text x="296" y="74" fill="#e8e8e8" font-family="ui-monospace,monospace" font-size="13" font-weight="700">130</text>
  <text x="494" y="74" fill="#f87171" font-family="ui-monospace,monospace" font-size="13" font-weight="700">98</text>
  <text x="649" y="74" fill="#f87171" font-family="ui-monospace,monospace" font-size="13" font-weight="700">156</text>

  <line x1="64"  y1="96" x2="64"  y2="118" stroke="#444"/>
  <line x1="200" y1="96" x2="200" y2="140" stroke="#444"/>
  <line x1="387" y1="96" x2="387" y2="162" stroke="#444"/>
  <line x1="563" y1="96" x2="563" y2="184" stroke="#444"/>
  <line x1="764" y1="96" x2="764" y2="206" stroke="#444"/>

  <text x="72"  y="122" fill="#a3e635" font-family="ui-monospace,monospace" font-size="12">50+ sessions — the daily driver</text>
  <text x="208" y="144" fill="#8fbf4f" font-family="ui-monospace,monospace" font-size="12">10-49 sessions — earns its keep</text>
  <text x="395" y="166" fill="#888" font-family="ui-monospace,monospace" font-size="12">3-9 sessions — real depth, keep it hidden</text>
  <text x="904" y="188" fill="#f87171" font-family="ui-monospace,monospace" font-size="12" text-anchor="end">1-2 sessions — near-dead</text>
  <text x="904" y="210" fill="#f87171" font-family="ui-monospace,monospace" font-size="12" text-anchor="end">never executed, not once</text>

  <line x1="486" y1="230" x2="904" y2="230" stroke="#f87171" stroke-width="2"/>
  <text x="904" y="250" fill="#f87171" font-family="ui-monospace,monospace" font-size="13" font-weight="700" text-anchor="end">254 commands (45%) dead or near-dead</text>
  <text x="904" y="270" fill="#888" font-family="ui-monospace,monospace" font-size="11" text-anchor="end">measured on the author's own machine</text>

  <line x1="16" y1="230" x2="112" y2="230" stroke="#a3e635" stroke-width="2"/>
  <text x="16" y="250" fill="#a3e635" font-family="ui-monospace,monospace" font-size="13" font-weight="700">Top 20 commands = 70.4% of all 85,285 executions</text>
  <text x="16" y="270" fill="#888" font-family="ui-monospace,monospace" font-size="11">the other 544 share the remaining 29.6%</text>
</svg>
<figcaption>Tiering is measured, not guessed. The proposal hides tiers 4 and 5 from <code>--help</code>; it does not delete them.</figcaption>
</figure>

## The front door: current versus proposed

<figure class="artifact-figure artifact-behavior">
<section data-state="current" data-evidence="capture">
<h4>Today — <code>agents --help</code>, captured 2026-08-27</h4>
<pre><code>Usage: agents [command] [options]

Install, configure, run, and dispatch AI
coding agents from one place.

Quick start:
  agents setup       First-time setup
  agents view        See what's installed
  agents run &lt;agent&gt; Run an agent
  agents sessions    Browse past sessions

Agent versions:
  add / import / update / prune / remove
  use / prune cleanup / trash / view
  inspect

Agent configuration:
  rules / commands / skills / mcp
  permissions / hooks / subagents / plugins

Packages:      search / install
Run:           run / config / teams
               routines / daemon / webhook
               funnel / sessions / logs
               browser / pty / artifacts
Observe:       feed / events / events audit
               sync status / devices snapshot
Credentials:   harness / secrets / accounts
Diagnostics:   doctor / usage / insights
               perf
Config sync:   repo pull / sync / repo init
               repo add

  … 69 groups, 564 commands total</code></pre>
<p><strong>What a new user takes away:</strong> nothing. No pain is named, no first command produces a result, and there is no ordering signal. <code>webhook</code> and <code>funnel</code> sit at the same visual weight as <code>run</code>.</p>
</section>
<section data-state="proposed" data-evidence="mockup">
<h4>Proposed — tiered <code>--help</code>, all 564 commands still installed</h4>
<pre><code>Usage: agents [command] [options]

Run Claude, Codex, Cursor, Grok and friends
— pin the version, rotate the account,
resume the session.

Start here:
  agents setup      Sign in, install an agent
  agents run claude Run it (no prompt = TUI)
  agents sessions   Every past run, resumable
  agents view       Installed, signed in, and
                    how much quota is left

Every day:
  agents teams      N agents, one worktree each
  agents browser    Drive a logged-in browser
  agents secrets    Keychain env bundles
  agents devices    Your other machines (-D)

  agents &lt;group&gt; --help  for any of the above
  agents commands        all 564 commands

Hit a limit?
  agents accounts add    Add a 2nd Max account
  agents run --strategy balanced
                         Rotate to headroom</code></pre>
<p><strong>What a new user takes away:</strong> the promise in one sentence, four commands that produce output, and a named exit to the full surface. Tiers 3 through 5 stay installed and documented; they just leave the front page.</p>
</section>
<figcaption>No command is removed. <code>agents commands</code> becomes the documented door to the full 564, the way <code>git help -a</code> is for git's roughly 130 plumbing commands.</figcaption>
</figure>

## Proposed Changes

### 1. Collapse the entity to one name

```diff
--- a/cli/package.json
+++ b/cli/package.json
   "name": "@phnx-labs/agents-cli",
-  "description": "One CLI for all your AI coding agents - versions, config, cloud dispatch, sessions, and teams (now with first-class Grok Build CLI support)",
+  "description": "Run Claude Code, Codex, Cursor, Gemini and Grok from one CLI. Pin versions, rotate accounts past usage limits, resume any session on any machine.",
   "repository": {
-    "url": "git+https://github.com/phnx-labs/agi-cli.git"
+    "url": "git+https://github.com/phnx-labs/agents-cli.git"
   },
   "homepage": "https://agents-cli.sh"
```

```diff
--- a/README.md
+++ b/README.md
-<h1 align="center">agi-cli</h1>
+<h1 align="center">agents-cli</h1>

-**A framework for running a distributed agent factory.** Dispatch Claude, Codex,
-Antigravity, Grok, and more across your own machines, in parallel, on your existing
-subscriptions. Measure every run with `agents perf` / `agents insights`, fold what you
-learn back into `AGENTS.md` and skills, then put the loop on a schedule with routines
-and monitors. Spawn parallel teams in isolated terminals or dispatch to the cloud for a
-PR. Watch live state across the fleet, nudge stalled runs, and message agents mid-flight.
-Store secrets behind Touch ID, drive real browsers and Electron apps, and steer the whole
-fleet from a menu bar — all from one CLI.
+**Pin the version, rotate the account, resume the session.**
+
+One `agents` binary for every coding agent you already pay for: Claude Code,
+Codex, Cursor, Gemini, Grok, Kimi, Droid, OpenCode. It drives *your* logged-in
+CLIs on *your* subscriptions and never proxies your tokens.
+
+```bash
+npm i -g @phnx-labs/agents-cli && agents setup
+```
```

Infrastructure side: `agi-cli.sh` starts 301-ing to `agents-cli.sh` (currently the reverse), and the GitHub repo renames to `phnx-labs/agents-cli` so its existing 301 becomes the canonical target.

### 2. Stop the false license claim

In **this** repo, one line:

```diff
--- a/DESIGN.md
+++ b/DESIGN.md
-description: "The meta harness engineering system for agents. A Phoenix Labs
-OSS product (Apache-2.0), terminal-coded — NOT the Rush/Swarmify brand. …"
+description: "The meta harness engineering system for agents. A Phoenix Labs
+product, source-available under FSL-1.1-Apache-2.0, terminal-coded — NOT the
+Rush/Swarmify brand. …"
```

In the **`agent-cli-web`** repo (a companion PR — `/website/` is gitignored here per `.gitignore:103`), the same correction to `public/llms.txt`:

```diff
-Free and open source (Apache-2.0), local-first, runs on your existing
-subscriptions (no per-token API cost, no account).
+Source-available under FSL-1.1-Apache-2.0 — free for you and your team to use,
+converting to Apache-2.0 two years after each release. Local-first; runs on your
+existing subscriptions (no per-token API cost, no account).
```

`README.md:1652` already says this correctly and needs no change. If Decision 2 goes the other way and we relicense, these strings become true instead, and `cli/package.json` plus `LICENSE` change with them.

### 3. Tier the help output

`cli/src/lib/help.ts` already owns `setHelpSections`. Add a tier map derived from the measured reach, and let the root help render tiers 1 and 2 only.

```diff
--- a/cli/src/lib/help.ts
+++ b/cli/src/lib/help.ts
+/** Front-door tier. Derived from measured session reach, not opinion.
+ *  1 = start here, 2 = every day, 3+ = reachable via `agents commands`. */
+export type CommandTier = 1 | 2 | 3;
+
+export const FRONT_DOOR: Record<string, CommandTier> = {
+  setup: 1, run: 1, sessions: 1, view: 1,
+  teams: 2, browser: 2, secrets: 2, devices: 2, accounts: 2, add: 2,
+};
```

```diff
--- a/cli/src/cli/command-registry.ts
+++ b/cli/src/cli/command-registry.ts
-  program.addHelpText('after', renderAllGroups(COMMAND_LOADERS));
+  program.addHelpText('after', renderFrontDoor(COMMAND_LOADERS, FRONT_DOOR));
+  // The full surface stays one command away and fully documented.
+  program.addHelpText('after', '\n  agents commands   all 69 groups, 564 commands\n');
```

### 4. Publish the cross-harness skill

Codex's research is unambiguous about the highest-leverage discovery move, and it is not `llms.txt`. Installed **skills and plugins are injected directly into an agent's context**, which is a deterministic surface rather than a hope that a crawler noticed a text file.

```
skills/agents-cli/SKILL.md      # trigger phrases + verified recipes
.claude-plugin/marketplace.json # claude plugin marketplace add phnx-labs/agents-cli
```

The `SKILL.md` description carries the exact intents developers type: *run multiple coding agents in parallel*, *manage multiple Claude Code accounts*, *hit my usage limit*, *resume a session on another machine*, *pin the agent CLI version*. Submit to [Claude's marketplace](https://code.claude.com/docs/en/discover-plugins), [Cursor's](https://cursor.com/marketplace), and [skills.sh](https://skills.sh/).

### 5. Fix the four cheap `is-agentic` essentials

The scan named them precisely. All four are site-side and none touch the CLI:

| Check | Status | Fix |
|---|---|---|
| Markdown content negotiation | FAILED | Serve `text/markdown` on `Accept: text/markdown` with `Vary: Accept` |
| Agent-friendly 404s | PARTIAL | Give the 404 a markdown body linking `llms.txt` and the docs index |
| Agent instruction / when-to-use | FAILED | Serve `/AGENTS.md` (currently 404) with install and when-to-use |
| Trust anchor pages | FAILED | Real `/about`, `/contact`, `/privacy`, 500+ characters each |

Skip `openapi.json`, `json-error-responses`, and `function-calling`. Those checks assume a web API; agents-cli is a local CLI, and forging an API surface to game a score is exactly the cargo cult to avoid.

## Public Interface

| Surface | Before | After |
|---|---|---|
| `agents --help` | Names 40 of 69 groups, unordered; 29 never mentioned, no pointer | 4 "start here" plus 6 "every day", plus a pointer to all 69 |
| `agents commands` | Lists installed slash commands | Also the documented door to the full 564-command index |
| npm description | "One CLI for all your AI coding agents…" | Pain-first, names the harnesses |
| `agents-cli.sh` | 301 to `agi-cli.sh` | Canonical; `agi-cli.sh` 301s here |
| `github.com/phnx-labs/agi-cli` | Canonical, 17 stars | 301 to `phnx-labs/agents-cli` |
| `/AGENTS.md` on the site | 404 | Served |
| License string on the site | "open source (Apache-2.0)" | "source-available (FSL-1.1, becomes Apache-2.0)" |

No command is removed, renamed, or deprecated. Every existing invocation keeps working.

## Plan

Sequenced so nothing waits on the naming decision except the naming work itself.

**Week 1 — stop the leaks, ship no features**

1. Ratify Decision 1 and Decision 2.
2. Fix the license claim in `llms.txt` and `DESIGN.md`. One commit, no ambiguity.
3. Rewrite the README first screen and the npm description to the pain-first line.
4. Land the `--help` tiering behind `FRONT_DOOR`.
5. Serve `/AGENTS.md`, the markdown 404 body, content negotiation, and the three trust pages. Re-run `npx is-agentic agents-cli.sh` and expect 63 to rise past 85.

**Week 2 — the wedge artifact**

6. Record the 12-second demo: limit hit, `--strategy balanced` rotates, same session continues. This is the only pain with million-view posts and no competitor owns it on camera.
7. Ship the `SKILL.md` and plugin marketplace entry; submit to Claude, Cursor, and skills.sh.
8. Do the name cutover: domain 301 flip, repo rename, README title.

**Week 3 — distribution**

9. Show HN with the demo GIF. Grok's case studies put Show HN as the spark (Conductor 228 points, container-use 82 points) and Product Hunt as the echo.
10. Write the setup-dump thread, not a product thread. Jamon Holmgren's setup listicle got 10,332 bookmarks with nothing to download.
11. Submit to `awesome-claude-code` (53.1k stars) and the maintained agent lists.

**Deliberately not doing:** `agents.txt` and `agent.json` and experimental MCP server cards (no answer-engine adoption evidence; several are unaccepted proposals); a Wikipedia page (fails notability without independent coverage, and creating one early is counterproductive); Product Hunt as the launch spark; a 564-tool MCP server mirroring the CLI.

## Validation

```bash
# 0. Reproduce every number this plan cites.
#    The corpus is LIVE — agents running right now write new transcripts — so the
#    execution total creeps by a few counts between runs. That is corpus growth,
#    not non-determinism: run it twice back to back and the two runs match
#    byte-for-byte. What must stay stable is the tier block and the percentages.
python3 .agents/artifacts/2026-08-27/adoption-evidence/mine-command-usage.py > /tmp/a.txt
python3 .agents/artifacts/2026-08-27/adoption-evidence/mine-command-usage.py > /tmp/b.txt
diff /tmp/a.txt /tmp/b.txt && echo "deterministic"
sed -n '/USAGE TIERS/,/dead or near-dead/p' /tmp/a.txt   # expect 63/117/130/98/156, 254 (45%)

# 1. Surface: the front door is small, the full index still reachable
agents --help | grep -cE '^\s{2,6}[a-z][a-z0-9_:-]+\s{2,}'   # expect <= 12, is 26 today
jq '.commands, .groups' cli/docs/command-index.json  # expect 564 and 69, unchanged

# 1b. The invisible groups: which of the 69 does --help never name?
python3 .agents/artifacts/2026-08-27/adoption-evidence/help-coverage.py
#     today: names 40, never mentions 29 (ssh #5, repos #8, computer #13)
#     after: 0 never-mentioned, or a pointer that reaches them

# 1c. The same claim without trusting that script at all. The four flagship
#     examples must print 0 today; the control group must not.
for g in ssh repos computer notify; do echo "$g $(agents --help | grep -cw $g)"; done
for g in sessions run teams secrets browser; do echo "$g $(agents --help | grep -cw $g)"; done
bash cli/scripts/verify-command-index.sh           # index still matches registry

# 2. Identity: one canonical entity
curl -sI https://agi-cli.sh/ | grep -i location    # expect agents-cli.sh
curl -s https://api.github.com/repos/phnx-labs/agents-cli | jq -r .full_name
curl -s https://registry.npmjs.org/@phnx-labs/agents-cli | jq -r .repository.url

# 3. Agent readiness: measured, not asserted
npx is-agentic agents-cli.sh --json | jq '.score'  # expect >= 85, was 63
curl -sL -H 'Accept: text/markdown' https://agents-cli.sh/docs/agents/run -i | head -3
curl -sL -o /dev/null -w '%{http_code}\n' https://agents-cli.sh/AGENTS.md  # expect 200

# 4. License truth
grep -i 'apache-2.0' DESIGN.md            # AFTER the fix: expect FSL wording,
                                          # today: still the wrong claim
# llms.txt lives in the agent-cli-web repo (.gitignore:103) — check it there:
curl -sL https://agents-cli.sh/llms.txt | grep -i 'apache-2.0\|FSL'   # -L: the domain 301s

# 5. The wedge actually works before it is filmed
agents accounts add                                 # second Max account
agents run claude "long task" --strategy balanced   # observe rotation at the limit
agents sessions --active                            # stalled work ranks first
```

End-to-end proof for the demo is the recording itself: a real run hitting a real limit and continuing on the second account, uncut.

## Risks

- **The name cutover breaks live installs.** `cli/scripts/release.sh` and `cli/scripts/postinstall.js` embed the repo URL for update checks; renaming the GitHub repo before the 301 is verified would break `agents upgrade` for every installed client. Mitigation: rename first (GitHub keeps the 301 permanently), verify with `curl -sI`, then flip the domain, then publish a release.
- **Tiered help hides a command someone scripted against.** Nothing is removed, but a user who learned a group from `--help` may believe it was deleted. Mitigation: the `agents commands` pointer sits in the help body, and `agents <anything> --help` still resolves for all 564.
- **Publicly advertising multi-account rotation is a ToS gray zone.** Anthropic's April 2026 policy shift blocked Pro and Max subscriptions on most third-party frameworks, and one developer reported seven Max accounts banned. Mitigation: frame the feature as *pin a named account per repo or session* (work versus personal), which is the same code path and a defensible story. Never proxy or resell tokens, and say so in sentence two of the README.
- **The usage tiers come from a Claude-heavy corpus.** 7,336 of 9,223 distinct sessions are Claude, and Codex contributed exactly 1 session with a matched execution; SQLite-backed stores are not read. A command that is load-bearing for Codex or Cursor users could sit in tier 4 here. Mitigation: the plan only *hides* tiers 4 and 5 from the front door, never deletes them, so a mis-tiered command costs a reader one `agents commands` away rather than a broken workflow.
- **`agents-cli` is a generic string.** This is Decision 1's own weakness: it may not rank against the literal words "agents cli". That is the honest argument for choosing a distinctive third name instead, at the cost of one hard cutover.
- **The download figure carries a self-inflation confound, now bounded.** 68 versions shipped in August alone, and this project has documented fleet auto-update plus a mandatory clean-prefix install smoke per release. Order-of-magnitude ceiling: 68 releases across a 14-device fleet is about 950 installs a month, roughly 220 a week, plus around 16 a week of release smoke. Call it **~250/week of the 2,961**, under 10%. That is a ceiling, not a measurement, and it should be replaced with real first-run telemetry. It does not account for the bulk of the figure, but it is large enough that the download number should never be the headline. Track stars, Show HN position, and first-run telemetry as the adoption metric.

## Tracking

- Plan source: `.agents/artifacts/2026-08-27/plan-adoption.md`
- Evidence, committed beside this plan in `.agents/artifacts/2026-08-27/adoption-evidence/`:
  - `help-coverage.py`, `help-coverage-report.txt` — which of the 69 groups `agents --help` actually names, and which are invisible
  - `mine-command-usage.py`, `command-usage-report.txt`, `command-usage.json` — the transcript reducer, its printed report, and the raw per-command counts. Every number the plan cites is printed by the script; re-run it to reproduce them.
  - `is-agentic-agi-cli.json` — the raw agent-readiness scan (26 checks eligible for this site)
  - `research-x-market-grok.md` — live X engagement data, DIY reasons, distribution case studies
  - `research-discoverability-codex.md` — llms.txt / AGENTS.md / MCP registries / skill marketplaces / AEO evidence
  - `research-competitive-kimi.md` — 36-tool competitive sweep with live stars and download counts
- Existing command reference: [share.agents-cli.sh — command reference](https://share.agents-cli.sh/muqsitnawaz/agents-cli-command-reference-rush-2396)
- Live audit: [is-agentic.com/scan/agi-cli.sh](https://is-agentic.com/scan/agi-cli.sh)
