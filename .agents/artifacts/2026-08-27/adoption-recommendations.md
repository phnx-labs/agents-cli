---
kind: visual
title: "What to actually do about agents-cli adoption"
summary: "Eleven moves over three weeks, plus five things to deliberately not do. None of them ships a feature — every leak the research measured sits upstream of the product."
project: AGI
repository: phnx-labs/agents-cli
harness: claude
agent: claude-opus-5
host: zion
date: 2026-08-27
links:
  - https://share.agents-cli.sh/muqsitnawaz/agents-cli-adoption-plan-2026-08-27
---

## Story

The research said the product is fine. 9,223 of your own sessions ran 85,285 `agents` commands; rotation, sessions, the daemon and the browser all work. What does not work is everything a stranger meets **before** they get that far.

So this is not a feature roadmap. It is eleven repairs, ordered so the cheapest and the most irreversible-if-wrong come first.

<div class="artifact-callout">
<strong>The highest-leverage move is also the smallest.</strong> <code>agents --help</code> never mentions <code>ssh</code> — the fifth most-used group in the entire CLI. Adding the one-line pointer git has had for twenty years costs about an hour and makes 29 invisible groups discoverable. Everything else on this page is larger and less certain than that.
</div>

## Figure

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg viewBox="0 0 1000 690" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Eleven recommended moves across three weeks, sized by effort and shaded by expected impact, with five deliberate non-moves">
  <defs>
    <marker id="ar" markerWidth="8" markerHeight="8" refX="7" refY="2.6" orient="auto">
      <path d="M0,0 L0,5.2 L8,2.6 z" fill="#555"/>
    </marker>
  </defs>

  <text x="16" y="24" fill="#e8e8e8" font-family="ui-monospace,monospace" font-size="15" font-weight="700">ELEVEN MOVES · NONE OF THEM SHIPS A FEATURE</text>
  <text x="16" y="44" fill="#666" font-family="ui-monospace,monospace" font-size="11.5">Bar length = estimated engineering hours at a constant 8px/hour (range midpoint). Fill = expected impact (judgement, not measurement).</text>

  <rect x="700" y="14" width="14" height="11" fill="#a3e635"/><text x="720" y="24" fill="#888" font-family="ui-monospace,monospace" font-size="11">high</text>
  <rect x="762" y="14" width="14" height="11" fill="#5f8f1f"/><text x="782" y="24" fill="#888" font-family="ui-monospace,monospace" font-size="11">medium</text>
  <rect x="840" y="14" width="14" height="11" fill="#3a3a3a"/><text x="860" y="24" fill="#888" font-family="ui-monospace,monospace" font-size="11">supporting</text>

  <rect x="16" y="58" width="968" height="200" rx="5" fill="#0f0f0f" stroke="#2a2a2a"/>
  <text x="30" y="80" fill="#a3e635" font-family="ui-monospace,monospace" font-size="13" font-weight="700">WEEK 1 · STOP THE LEAKS</text>
  <text x="250" y="80" fill="#666" font-family="ui-monospace,monospace" font-size="11">only #2 needs a decision from you</text>

  <text x="30" y="106" fill="#e8e8e8" font-family="ui-monospace,monospace" font-size="12.5">1 · Add the full-listing pointer to --help</text>
  <rect x="520" y="95" width="8" height="15" fill="#a3e635"/>
  <text x="540" y="107" fill="#a3e635" font-family="ui-monospace,monospace" font-size="11.5">~1h · unhides 29 groups, incl. ssh (rank #5 by use)</text>

  <text x="30" y="132" fill="#e8e8e8" font-family="ui-monospace,monospace" font-size="12.5">2 · Fix the false Apache-2.0 claim</text>
  <rect x="520" y="121" width="8" height="15" fill="#a3e635"/>
  <text x="540" y="133" fill="#a3e635" font-family="ui-monospace,monospace" font-size="11.5">~1h · DESIGN.md + llms.txt · removes a trust landmine</text>

  <text x="30" y="158" fill="#e8e8e8" font-family="ui-monospace,monospace" font-size="12.5">3 · Rewrite README first screen + npm description</text>
  <rect x="520" y="147" width="72" height="15" fill="#a3e635"/>
  <text x="604" y="159" fill="#a3e635" font-family="ui-monospace,monospace" font-size="11.5">6-12h · lead with the pain, name the harnesses</text>

  <text x="30" y="184" fill="#e8e8e8" font-family="ui-monospace,monospace" font-size="12.5">4 · Tier --help into a 10-group front door</text>
  <rect x="520" y="173" width="48" height="15" fill="#5f8f1f"/>
  <text x="580" y="185" fill="#8fbf4f" font-family="ui-monospace,monospace" font-size="11.5">4-8h · orders what the pointer exposes</text>

  <text x="30" y="210" fill="#e8e8e8" font-family="ui-monospace,monospace" font-size="12.5">5 · /AGENTS.md, markdown 404, content negotiation, trust pages</text>
  <rect x="520" y="199" width="96" height="15" fill="#5f8f1f"/>
  <text x="628" y="211" fill="#8fbf4f" font-family="ui-monospace,monospace" font-size="11.5">8-16h · is-agentic 63 → 85+</text>

  <text x="30" y="240" fill="#666" font-family="ui-monospace,monospace" font-size="11">≈ 20-40 engineering hours total. Closes every measured leak except the name.</text>

  <line x1="500" y1="260" x2="500" y2="278" stroke="#555" stroke-width="1.5" marker-end="url(#ar)"/>

  <rect x="16" y="282" width="968" height="152" rx="5" fill="#0f0f0f" stroke="#2a2a2a"/>
  <text x="30" y="304" fill="#a3e635" font-family="ui-monospace,monospace" font-size="13" font-weight="700">WEEK 2 · BUILD THE WEDGE</text>
  <text x="262" y="304" fill="#666" font-family="ui-monospace,monospace" font-size="11">#8 is blocked until you pick the name</text>

  <text x="30" y="330" fill="#e8e8e8" font-family="ui-monospace,monospace" font-size="12.5">6 · Record the 12-second rotation demo</text>
  <rect x="520" y="319" width="36" height="15" fill="#a3e635"/>
  <text x="568" y="331" fill="#a3e635" font-family="ui-monospace,monospace" font-size="11.5">3-6h · limit hit → rotate to headroom → work continues</text>

  <text x="30" y="356" fill="#e8e8e8" font-family="ui-monospace,monospace" font-size="12.5">7 · SKILL.md + Claude / Cursor / skills.sh entries</text>
  <rect x="520" y="345" width="144" height="15" fill="#a3e635"/>
  <text x="676" y="357" fill="#a3e635" font-family="ui-monospace,monospace" font-size="11.5">12-24h · the real discovery lever</text>

  <text x="30" y="382" fill="#e8e8e8" font-family="ui-monospace,monospace" font-size="12.5">8 · Name cutover: rename repo → verify 301 → flip domain</text>
  <rect x="520" y="371" width="48" height="15" fill="#5f8f1f"/>
  <text x="580" y="383" fill="#8fbf4f" font-family="ui-monospace,monospace" font-size="11.5">4-8h · that order, or `agents upgrade` breaks</text>

  <text x="30" y="412" fill="#666" font-family="ui-monospace,monospace" font-size="11">The demo is what week 3 spends. Two narrow rotation competitors exist (claude-swap, headroom) — neither shows it on camera.</text>

  <line x1="500" y1="436" x2="500" y2="454" stroke="#555" stroke-width="1.5" marker-end="url(#ar)"/>

  <rect x="16" y="458" width="968" height="124" rx="5" fill="#0f0f0f" stroke="#2a2a2a"/>
  <text x="30" y="480" fill="#a3e635" font-family="ui-monospace,monospace" font-size="13" font-weight="700">WEEK 3 · SPEND IT</text>
  <text x="196" y="480" fill="#666" font-family="ui-monospace,monospace" font-size="11">Show HN is the spark; the rest are echoes — writing time, so no hour bar</text>

  <text x="30" y="506" fill="#e8e8e8" font-family="ui-monospace,monospace" font-size="12.5">9 · Show HN, leading with the demo</text>
  <rect x="520" y="495" width="14" height="15" fill="#a3e635"/>
  <text x="546" y="507" fill="#a3e635" font-family="ui-monospace,monospace" font-size="11.5">Conductor 228 pts · container-use 82 pts</text>

  <text x="30" y="532" fill="#e8e8e8" font-family="ui-monospace,monospace" font-size="12.5">10 · A setup-dump thread, not a product thread</text>
  <rect x="520" y="521" width="14" height="15" fill="#a3e635"/>
  <text x="546" y="533" fill="#a3e635" font-family="ui-monospace,monospace" font-size="11.5">Jamon's listicle: 10,332 bookmarks, nothing to install</text>

  <text x="30" y="558" fill="#e8e8e8" font-family="ui-monospace,monospace" font-size="12.5">11 · awesome-claude-code + maintained agent lists</text>
  <rect x="520" y="547" width="14" height="15" fill="#3a3a3a"/>
  <text x="546" y="559" fill="#888" font-family="ui-monospace,monospace" font-size="11.5">amplifier after the spark, never the spark</text>

  <rect x="16" y="602" width="968" height="74" rx="5" fill="#1a0f0f" stroke="#f87171" stroke-opacity="0.45"/>
  <text x="30" y="624" fill="#f87171" font-family="ui-monospace,monospace" font-size="13" font-weight="700">DELIBERATELY NOT DOING</text>
  <text x="266" y="624" fill="#888" font-family="ui-monospace,monospace" font-size="11">each is a plausible move the evidence argues against</text>

  <text x="30" y="646" fill="#d8d8d8" font-family="ui-monospace,monospace" font-size="11.5">agents.txt · agent.json · MCP server cards</text>
  <text x="330" y="646" fill="#888" font-family="ui-monospace,monospace" font-size="11">— unaccepted proposals, no answer-engine adoption evidence</text>

  <text x="30" y="664" fill="#d8d8d8" font-family="ui-monospace,monospace" font-size="11.5">A 564-tool MCP server · Wikipedia page · PH as the spark</text>
  <text x="436" y="664" fill="#888" font-family="ui-monospace,monospace" font-size="11">— context bloat · fails notability · echo, not spark</text>
</svg>
<figcaption>Hours are estimated engineering time, not human labour commitments. Impact shading is judgement informed by the evidence, not a measurement — the one figure that <em>is</em> measured is move #1's reach: 29 groups, including rank #5. Source: the <a href="https://share.agents-cli.sh/muqsitnawaz/agents-cli-adoption-plan-2026-08-27">merged adoption plan</a> and its committed evidence bundle.</figcaption>
</figure>

## Data

Why these eleven, and how much of each rests on measurement rather than judgement.

| Move | The finding it repairs | Measured? |
|---|---|---|
| 1 · the pointer | `ssh` (368 sessions, rank #5), `repos` (#8), `computer` (#13) never appear in `--help` | **Yes** — `agents --help \| grep -cw ssh` returns 0 |
| 2 · license claim | `DESIGN.md` and `llms.txt` say Apache-2.0; `LICENSE` is FSL-1.1 | **Yes** — three files, quoted |
| 3 · README | Opens with "A framework for running a distributed agent factory" | **Yes** — the file itself |
| 4 · tier `--help` | 254 of 564 commands (45%) dead or near-dead; top 20 carry 70.4% | **Yes** — 9,223 sessions |
| 5 · site checks | `is-agentic` scores 63/100; brand discoverability FAILED | **Yes** — raw scan committed |
| 6 · demo | Usage limits is the only pain with 1M+ view posts | **Yes** — X engagement counts |
| 6 · demo (what to film) | Rotation moves a run to an account with headroom and picks the work back up. It does **not** continue the same session: `exec.ts:2558` mints a new UUID, Claude-only, and the other five harnesses get a retry-with-context prompt. Headless runs only — `shouldArmRotationFailover` excludes interactive | **Yes** — read from the code |
| 6 · demo (competitive) | Rotation has two competitors — `claude-swap` (2.0k stars, Claude-only, a foreground loop you babysit) and `headroom` (99 stars, Claude+Codex). Neither demonstrates it, and neither pairs it with stall detection | **Yes** — live star and download counts |
| 7 · skill/plugin | Installed skills enter agent context deterministically; `llms.txt` does not | Partly — sourced, not causal |
| 8 · name cutover | Four names, two domains, two repo names; 17 stars | **Yes** |
| 9-11 · distribution | Show HN was the spark for Conductor and container-use | **Yes** — points, dated |

### The two decisions that gate three tickets

| Decision | Recommendation | Honest counter-argument | Blocks |
|---|---|---|---|
| **The name** | Agents CLI wins; everything else 301s to it | "agents-cli" is a generic string; a distinctive third name is more searchable, at the cost of one hard cutover | PHNX-3322, move #8 |
| **The license claim** | Fix the two wrong strings now | None — relicensing to Apache is a separate, larger call and should not gate correcting a statement that is false today | PHNX-3321, move #2 |

### Already tracked

| Ticket | Move | State |
|---|---|---|
| `PHNX-3320` | 1 + 4 — the pointer and the tiering | unblocked |
| `PHNX-3321` | 2 — the license claim | carries Decision 2 |
| `PHNX-3322` | 8 — the name cutover | blocked on Decision 1 |
| `PHNX-3323` | — the half-landed `notify` deprecation | unblocked |
| `PHNX-3337` | 7 — the cross-harness skill and plugin | unblocked |

**3320, 3323 and 3337 can start today.** 3337 is the largest item on the page and the one most likely to be deprioritised for its size, so it is worth saying plainly: it is the actual answer to "how do we get Codex and Perplexity to surface this", and `llms.txt` is not.
