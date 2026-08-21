---
kind: report
template: report.v1
title: 'Vibe Kanban post-mortem: 30,000 users, nine harnesses, zero business'
summary: 'The closest product to the agi-cli launcher slice shut down onstage at AI Engineer Europe on 2026-04-10, still at 30,000 monthly actives. The free local core was the whole product; the $30 seat gated collaboration nobody wanted; a forced cloud migration burned the community eight weeks before the end; and the company had already walked away from the enterprise deals its founder later named as one of only two working business models. Primary sources: the shutdown post, the founder onstage, the GitHub record.'
status: draft
human: author
host: fleet-worker
session: n/a
links:
  - label: 'Companion: agi-cli GTM report'
    url: 'https://github.com/phnx-labs/agents-cli/blob/main/.agents/artifacts/2026-08-20/gtm-strategy.md'
  - label: 'Companion: adjacent-category landscape'
    url: 'https://github.com/phnx-labs/agents-cli/blob/main/.agents/artifacts/2026-08-20/landscape-cli-proxy-browser-computer.md'
  - label: 'The shutdown post — "Goodbye bloop."'
    url: 'https://www.vibekanban.com/blog/shutdown'
---

## Summary

Vibe Kanban is the single most instructive company in agi-cli's category, because
it is the one whose product overlapped most and whose death is best documented.
It proved the demand (30,000 monthly actives), shipped the launcher slice first
(June 2025: multi-agent kanban, worktree parallelism, diff commenting), supported
nine harnesses at shutdown — and still could not construct a business. This
report reconstructs what happened from primary sources: the official shutdown
post, the founder's onstage statement at AI Engineer Europe, the GitHub commit
and issue record, and the community post-mortems.

The one-paragraph version: Bloop, a 2021 YC company that had already pivoted
twice (code search → COBOL modernization → Vibe Kanban) on ~$7.4M of 2021
money, gave the full single-developer product away as open source and priced a
$30/user/month cloud tier around collaboration features its solo-developer user
base did not want. When it tried to force free local users toward the cloud
tier in February 2026, the community revolted; eight weeks later, on
2026-04-10, the founder shut the company down live onstage, naming the lesson
himself: *"Everyone who is making money is doing 2 things: selling to
enterprise, and reselling tokens. We were doing neither."* The repo has had
zero commits since 2026-04-24 and no successor fork has consolidated.

This also corrects the GTM report's cohort line: Vibe Kanban was not "one or
two harnesses" — its launcher offered nine (Claude Code, Codex, OpenCode,
Gemini, AMP, Copilot, Cursor, Droid, Qwen), observed directly in the shipped
onboarding UI. The correction is folded into `gtm-strategy.md` §3 in the same
change that adds this report.

## Findings

### 1. Timeline — a company on its third life

<figure>
<svg viewBox="0 0 900 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Bloop / Vibe Kanban company timeline 2021 to 2026">
  <line x1="40" y1="125" x2="860" y2="125" stroke="#888888" stroke-width="2"/>
  <circle cx="80" cy="125" r="5" fill="#888888"/>
  <text x="80" y="100" text-anchor="middle" font-family="monospace" font-size="12" fill="currentColor">2021</text>
  <text x="80" y="150" text-anchor="middle" font-size="11" fill="currentColor">Founded, YC</text>
  <text x="80" y="166" text-anchor="middle" font-size="11" fill="#888888">code search</text>
  <circle cx="228" cy="125" r="5" fill="#888888"/>
  <text x="228" y="100" text-anchor="middle" font-family="monospace" font-size="12" fill="currentColor">Dec 2021</text>
  <text x="228" y="150" text-anchor="middle" font-size="11" fill="currentColor">~$7.3M Series A</text>
  <text x="228" y="166" text-anchor="middle" font-size="11" fill="#888888">last capital raised</text>
  <circle cx="376" cy="125" r="5" fill="#888888"/>
  <text x="376" y="100" text-anchor="middle" font-family="monospace" font-size="12" fill="currentColor">2023–24</text>
  <text x="376" y="150" text-anchor="middle" font-size="11" fill="currentColor">Pivot: COBOL→Java</text>
  <text x="376" y="166" text-anchor="middle" font-size="11" fill="#888888">walks from 6-figure deals</text>
  <circle cx="524" cy="125" r="5" fill="#84a929"/>
  <text x="524" y="100" text-anchor="middle" font-family="monospace" font-size="12" fill="currentColor">Jun 2025</text>
  <text x="524" y="150" text-anchor="middle" font-size="11" fill="currentColor">Vibe Kanban launches</text>
  <text x="524" y="166" text-anchor="middle" font-size="11" fill="#888888">first multi-agent kanban</text>
  <circle cx="672" cy="125" r="5" fill="#c47a2c"/>
  <text x="672" y="100" text-anchor="middle" font-family="monospace" font-size="12" fill="currentColor">Feb 2026</text>
  <text x="672" y="150" text-anchor="middle" font-size="11" fill="currentColor">Forced cloud migration</text>
  <text x="672" y="166" text-anchor="middle" font-size="11" fill="#888888">community revolt (#2746)</text>
  <circle cx="820" cy="125" r="6" fill="#c0392b"/>
  <text x="820" y="100" text-anchor="middle" font-family="monospace" font-size="12" fill="currentColor">Apr 10 2026</text>
  <text x="820" y="150" text-anchor="middle" font-size="11" fill="currentColor">Shutdown, onstage</text>
  <text x="820" y="166" text-anchor="middle" font-size="11" fill="#888888">30,000 MAU</text>
  <text x="820" y="182" text-anchor="middle" font-size="11" fill="#888888">last commit Apr 24</text>
  <text x="450" y="225" text-anchor="middle" font-size="12" fill="#888888">~$7.4M total raised, all in 2021 · 16 employees at the end · three product lives on one seed-era balance sheet</text>
</svg>
<figcaption>Five years, two pivots, one raise. Vibe Kanban itself lived ten months.</figcaption>
</figure>

Bloop AI Limited: incorporated London, 2021-04-26; YC-backed; ~$7.31M Series A
on 2021-12-15 (LocalGlobe, By The Tower, YC) and no capital after that; 16
employees at the end. Product lives: AI code search, then COBOL-to-Java
modernization for enterprises (during which, per the Scaling DevTools podcast
framing, the founder walked away from six-figure enterprise contracts), then
Vibe Kanban in June 2025. The shutdown post's own claim of primacy: *"We
launched in June 2025 and were the first to ship multi-agent support, diff
commenting, live preview, click-to-edit, remote access and many other features
that are now taken for granted."*

### 2. The product overlap with agi-cli — real at the launcher slice, absent everywhere else

Observed directly in the shipped onboarding UI (run locally 2026-08-20): a
coding-agent picker with nine harnesses — Claude Code, Codex, OpenCode, Gemini,
AMP, Copilot, Cursor, Droid, Qwen — an editor picker, and a warning banner that
the product *"runs AI coding agents with --dangerously-skip-permissions /
--yolo by default."*

| Surface | Vibe Kanban | agi-cli |
| --- | --- | --- |
| Multi-harness launcher | Yes — nine agents, kanban-shaped | Yes — 17 active harnesses, CLI-shaped |
| Parallel isolation | Git worktrees per task | Git worktrees per teammate/change |
| Review surface | Inline diff comments, PR creation | PR flow + reviewer agents |
| Safety model | `--yolo` by default, banner asks user to watch | Permission modes, guards, daemon-owned execution |
| Fleet / cross-device | None — one machine, one browser tab | SSH dispatch, device registry, remote sessions |
| Browser / computer tools | None | `agents browser`, `agents computer` |
| Session corpus | None (tasks, not transcripts) | Indexed cross-harness transcript corpus |

The overlap is the slice the GTM report already called vibe-codeable: launch
agents in parallel worktrees and review the diffs. Every surface that
compounds — fleet, tool hands, the corpus — was absent. Vibe Kanban is the
control group for the thesis that the launcher slice alone, even executed
first and well, is not a defensible product.

### 3. Why it died — the mechanism, in order

**The free product was the whole product.** `npx vibe-kanban` gave a solo
developer everything: board, all nine harnesses, worktree parallelism, diff
review, PR creation. The $30/user/month tier gated shared issues, comments,
projects, and organisations — the collaboration layer. The dominant persona
(a solo developer running agents on one machine) had no reason to pay, ever.
From the shutdown post: *"the vast majority are free users and we couldn't
find a business model that we could get excited about."*

**The conversion attempt burned the community.** In February 2026 the team
pushed free local users toward a migration to the cloud version. GitHub issue
#2746 ("vibe-kanban is dead for me", opened 2026-02-14) captures the reaction:
*"why i need to 'MIGRATE' whole my projects to 'cloud' version? I don't need
'cloud' version."* The move converted goodwill into churn eight weeks before
the shutdown.

**The founder's own diagnosis, delivered onstage.** At AI Engineer Europe on
the day of the announcement (talk: "Software Engineering Is Becoming Plan and
Review"), captured by swyx: *"Everyone who is making money is doing 2 things:
selling to enterprise, and reselling tokens. We were doing neither."* The
community's sharper phrasing of the same economics, from a post-shutdown
review: Vibe Kanban was *"not a coding agent itself but a button that helped
users spend thousands of dollars on other agents while collecting a $30
subscription."* All token margin sat with the model providers.

**The company had no lives left.** The two working models the founder named
were both paths Bloop had structurally foreclosed: enterprise (walked away
from those contracts in the COBOL era) and token resale (never built). With
2021-vintage capital, a 16-person team, and two pivots already spent, "no
business model we could get excited about" ended the company rather than
funding a third attempt at monetization.

### 4. The afterlife — "community maintained" meant abandoned

The shutdown post promised: *"The Vibe Kanban project will live on, open
source and community maintained"* and *"We'll release a roadmap for the
community maintained edition over the next few weeks."* The record since:

- Final commits 2026-04-24: the README sunset banner (#3388) and rerouting
  cloud project pages to an export-only page (#3387). Zero commits since.
- 534 open issues; repo not archived but effectively read-only. No public
  community roadmap ever appeared.
- The wind-down also degraded the *local* product: v0.1.44 disabled the
  Projects feature for self-hosted installs too, with an incomplete export
  (issues #3396, #3354) — accepted-shutdown turned into renewed anger.
- Across 2,978 forks, no successor has consolidated; the most visible
  attempt had 3 stars as of 2026-08-20. Most users simply keep running the
  unmaintained OSS build.

The afterlife detail matters for agi-cli's own OSS posture: "we'll open-source
it and the community will carry it" did not happen for a 27,869-star project
with 30,000 monthly actives. Orphaned orchestrators stay orphaned.

## Evidence

Primary sources, all read 2026-08-20:

- Shutdown post: vibekanban.com/blog/shutdown ("Goodbye bloop.", 2026-04-10,
  Louis Knight-Webb) — free-user admission, 30-day cloud window, auto-refunds,
  community-maintained promise, first-to-ship claim.
- Founder onstage: x.com/swyx/status/2050753293601935777 — *"shutdown
  Vibe-kanban live onstage at AIE Europe - still with 30,000 MAU"* plus the
  enterprise/tokens quote. Talk confirmed on the AIE Europe schedule
  (ai.engineer/europe). The quote is second-hand via swyx — the same sourcing
  caveat the GTM report attached to it.
- GitHub API (api.github.com/repos/BloopAI/vibe-kanban): 27,869 stars, 2,978
  forks, not archived, last push 2026-04-24, 534 open issues, Rust,
  Apache 2.0, created 2025-06-14. Commit and release history confirm the
  Apr 10 announcement / Apr 24 last-commit sequence.
- Community record: GitHub issues #2746 (migration revolt, 2026-02-14), #3396
  and #3354 (broken local Projects post-shutdown); HN thread 44533004 (the
  July 2025 Show HN, 132 comments — early skepticism about parallel-agent
  clashes and telemetry defaults).
- Company history: Tracxn (incorporation, ~$7.31M Series A 2021-12-15,
  LocalGlobe/By The Tower/YC, 16 employees), Scaling DevTools podcast
  ("20,000 GitHub stars and walking away from 6-figure deals"), iVoox podcast
  (code search → COBOL pivot).
- Product observation: the shipped onboarding UI run locally on 2026-08-20 —
  nine-harness picker, `--yolo`-by-default warning banner.

Not verifiable: the exact Series A amount (aggregator-sourced), whether any
enterprise Vibe Kanban conversations existed at the end, and the internal
decision process — no insider account has been published beyond the talk.

## Recommendations

1. **Treat Vibe Kanban as the control group, not a rival that stumbled.** It
   executed the launcher slice first, well, and with nine harnesses — and
   that slice alone retained users at 30,000 MAU while capturing zero revenue.
   Differentiation and monetization both have to come from the surfaces they
   never built: fleet, tool hands, and the cross-harness corpus.
2. **Never run the forced-migration play.** Their February 2026 push of free
   local users toward the paid cloud tier converted the community's goodwill
   into public revolt in weeks and is the proximate cause of the ugly ending.
   The GTM report's "free forever on machines you own" line is the standing
   defense; any future paid tier must gate things the free tier never had,
   not fence off things users already relied on.
3. **Price collaboration only where collaboration is real.** Their $30 seat
   failed because solo developers were the user base and the seat gated team
   features. The GTM report's Act 3 (govern the corpus, sell at enterprise
   altitude to whoever owns the spend) targets buyers who exist; a
   collaboration seat for an audience of solo operators does not.
4. **Do not count on "the community will maintain it."** A 27,869-star,
   30,000-MAU project produced zero successor maintenance in four months.
   OSS is distribution while the company is alive, not a retirement plan.
