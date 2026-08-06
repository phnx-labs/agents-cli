## RUSH-2280 research seed — multi-harness friction + action list (for codex implementer)

**Do not treat this as a spec — it's the evidence base + a proposed shape.** Two inputs: (1) the July 2026-07-07 *Agent Interaction Analysis* pack (Claude-only, 2505 sessions), (2) live `agents insights` output run today (2026-08-05, 30d window, all harnesses). The thesis: the July pack is a bespoke one-off Python audit; **everything in it should become facets of `agents insights`, not a parallel CLI.** Live insights already parses every transcript with a cache, splits by account/agent/project/day, and — unlike the July pack — already ingests **codex and droid**, closing the pack's Claude-only blind spot.

### 1. The one meta-pattern (July pack, §1–§6)

> The agent stops one step short of done and asks permission for a step it already owns; the user then spends hundreds of prompts chasing the last mile.

- **1,931 of 3,639 (53%)** of agent "?" messages are permission-seeking on an owned step.
- Corpus: 2505 sessions (1754 zion / 393 yosemite-s0 / 220 yosemite-s1 / 138 mac-mini) · 7425 typed prompts · 3639 agent "?" messages · 1311 `AskUserQuestion` calls.

### 2. Top dissatisfaction / correction nudges (user prose, with counts)

Short repeated nudges = the tell that the agent stalled where it should have continued. **455 prompts** spent pushing a stalled agent over the finish line:

| Nudge | Count |
|---|---|
| check now | 180 |
| continue / keep going | 98 |
| yes / go / do it | 69 |
| are we done? / done end-to-end? | 52 |
| did you merge? | 21 |
| what's next? | 20 |
| merge it | 15 |

Long tail (784 distinct nudges) is thick with frustration + typo variants: "run what??", "did we publish it or what??", "are we all done here??", "hwo do we fix it??", "merhe it", "chec k now" — i.e. the same intent re-typed because the prior turn stalled.

**Policy re-assertions** (user re-stating autonomy/done the agent should assume — `user_themes.csv`): `continue / don't stop` ×334, `verify / test end-to-end` ×315, `don't ask / just do it` ×137. High count on any of these = a rule the agent isn't internalizing → guard candidate.

### 3. Stall `AskUserQuestion` categories

Of the **1803 categorized agent asks** (`ask_categories.csv`; note this categorized set is larger than the 1311 formal `AskUserQuestion` calls — it also picks up prose asks), **the majority (`other` ×1163, plus `scope / goal` ×190 and `cleanup` ×19) are legitimate scope/content decisions that should stay questions.** The fixable slice is **431 workflow-stall asks** where the agent had authorization and asked anyway:

| Stall category | Count |
|---|---|
| release / ship / deploy | 132 |
| "what's next?" | 126 |
| merge / reconcile | 80 |
| direction / approach | 58 |
| integrate / unblock / gate | 35 |

Top individual stall headers (`ask_headers.csv`): `scope` ×91, `next step` ×53, `next` ×30, `direction` ×15, `release` ×12, `cleanup` ×11, `fix scope` ×10, `unblock` ×10.

Agent prose "?" themes (`agent_q_themes.csv`): `"should I / want me to…"` ×1194, `"confirm / is that right?"` ×328, `"what's next / anything else?"` ×124, `"release / publish?"` ×108, `"merge now?"` ×93, `"proceed / go ahead?"` ×62, `"commit now?"` ×22.

### 4. Live `agents insights` today (2026-08-05, `--since 30d`)

`--by agent` (5228 scanned · 917 analyzed · 4311 filtered):

| Harness | Sessions | AskUserQuestion | request_user_input | Interruptions | Commits | Pushes |
|---|---|---|---|---|---|---|
| claude | 682 | 145 | 0 | 165 | 895 | 652 |
| codex | 233 | 0 | 5 | 0 (not tracked) | 255 | 205 |
| droid | 2 | 0 | 0 | 0 | 0 | 0 |

`--by account` (default, claude only, 30d): trp.so 180 sess / $2035 / 50 AUQ / **79 interruptions**; gmail 193 / $1030 / 35 AUQ / 19 int; getrush.ai 139 / $1269 / 38 AUQ; dev@getrush.ai 82 / $656 / 4 AUQ; tech@prix.dev 34 / 11 AUQ; social@swarmify 34; icloud 17. (These attributed accounts sum to 679 sessions; the 3-session gap to the 682 by-agent claude total is unattributed-claude sessions, and the two views were separate runs — 913 vs 917 analyzed.) Cross-account overlap: 8230 overlapping pairs, 6105 cross-account, 907 sessions involved.

**The gap this exposes:** insights already counts the *formal* signal per harness (`AskUserQuestion` for claude, `request_user_input` for codex) but does **not** yet mine the *prose* signals the July pack found — permission-asks (×1931), repeated nudges (×455), stall-vs-genuine ask classification (431 stall of the 1803 categorized asks). Those are where 90% of the friction hides, and they're currently invisible to the CLI.

### 5. Concrete automations / product actions the data implies

1. **`insights` friction facet — permission-ask detection.** Mine assistant prose for owned-step permission-asks ("should I / merge now? / release?"); report count + rate per account/agent/project. Directly surfaces the 53% meta-pattern.
2. **`insights` friction facet — repeated-nudge detection.** Cluster short user prompts (≤6 words, typo-merged) into nudge classes (`check now`, `continue`, `did you merge`); report a per-account/agent "stall tax" (the 455-prompt mass).
3. **`AskUserQuestion` stall classification.** Split headers into stall (release/next/merge/direction/integrate = 431) vs genuine scope (`other` = 1163, `scope / goal` = 190, `cleanup` = 19); surface the stall *rate*, never the content decisions.
4. **`--trend` / recurrence mode.** The July pack's dated recurrence check (2026-07-28) should be a command, not a re-run Python script: friction metrics over successive windows so guard effectiveness is visible.
5. **Guard-effectiveness attribution.** Tie shipped guards (`no-permission-stop-guard.sh`, `ask-user-question-guard.sh`) to a before/after delta in permission-asks (§6 table already does this by hand: 2441-sess→1167 asks vs 2505-sess→1194). Compute the delta automatically.
6. **Self-poll enforcement guard — the one unguarded gap.** `check now` ×180 is the top nudge and §6 flags it as *covered by rule (`deployment-and-waiting.md`) but with no guard enforcing it.* A Stop/PreToolUse guard that blocks a turn ending "I'll check back later" or a `run_in_background` command with no finish-echo. (Codex-owned; called out here as the highest-leverage new control.)
7. **Cross-harness friction normalization.** Fold each harness's "asks the user" signal (claude `AskUserQuestion`, codex `request_user_input`, droid equivalents) onto one comparable friction axis so the Claude-only blind spot of the July pack stays closed.
8. **Per-project stall hotspots.** Extend `--by project` with the friction facet → which repo eats the most "check now" / permission-ask time.
9. **Policy-re-assertion metric.** Count user re-assertions (`continue/don't stop` ×334, `verify e2e` ×315, `don't ask` ×137). A spike = a rule not internalized → guard candidate.
10. **Long-gap → nudge correlation.** insights already has `responseGapBuckets` (gmail acct: 76 gaps of 15–60m). Flag sessions where a user nudge follows a long idle gap = a self-poll failure the agent should have avoided.
11. **Interruptions as a first-class friction signal.** insights tracks `interruptions` (claude 165/30d; trp.so 79 alone). Surface top-interrupted sessions — high interruption = agent going the wrong way.
12. **`--narrative` → ranked action list.** Extend the existing `--narrative` output to emit "top 3 friction sources this window + the guard/rule that targets each," so the audit is self-serve instead of a quarterly manual PDF.

### 6. How this maps onto extending `agents insights` (NOT a parallel CLI)

The July pack and `agents insights` answer the same question ("how do you work / where is the friction") — the pack just does it manually, Claude-only, once. The extension is a **friction analysis layer inside insights**, reusing what it already has:

- **Reuse the transcript parser + cache** (insights already reads every transcript off disk incrementally) — no second scanner.
- **Reuse the grouping** (`--by account|agent|project|day` already exists) — friction metrics ride the same axes.
- **Reuse the per-harness normalization** insights already does for tools/models/languages — extend it to normalize the "asks user" and "user nudge" signals so codex/droid are in-frame from day one.
- **Add:** (a) an assistant-prose permission-ask classifier, (b) a user-prose nudge/policy-re-assertion classifier, (c) an `AskUserQuestion` stall-vs-genuine classifier, (d) a `--trend` window-over-window mode for the recurrence check, surfaced via the existing `--json` and `--narrative`.

Net: one command (`agents insights`) that already does the corpus + grouping + cross-harness work grows the friction facets the July pack proved matter — instead of a bespoke pandas pipeline that has to be re-run by hand and can't see codex.

---
*Raw data: `Agent-Interaction-Analysis-2026-07-07` pack (nudges.csv 784 rows, ask_headers.csv 1156 rows, user_themes.csv, agent_q_themes.csv, ask_categories.csv, + `01-analysis.pdf` §1–§6). Live: `agents insights --since 30d --json` and `--by agent`, yosemite-s0, 2026-08-05.*
