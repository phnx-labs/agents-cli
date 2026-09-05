---
kind: plan
template: plan.v1
title: 'One config: default model + reasoning effort, per account, everywhere'
summary: 'Today the per-run knobs you change often — default model, reasoning effort, and mode — are scattered across the CLI file and every version home, and no account can carry its own. This plan puts them in one place — a global default plus per-account overrides — and has the CLI apply them to every run, local and cloud, so "the cloud version" stops being a separate thing to configure.'
header: 'Agents CLI · Config'
footer: 'Phoenix Labs'
project: 'Agents CLI'
context: 'default model · reasoning effort · per account'
repository: 'agents-cli'
branch: 'claude-2026-09-05-0321-0f8168ef'
tracking: 'PHNX-3739'
status: draft
harness: claude
agent: claude
human: Muqsit
host: yosemite-m5
session: 0f8168ef
date: '2026-09-05'
facts:
  - 'Today the settings-level knobs live in THREE places: ~/.agents/agents.yaml (run defaults, no account dimension), each Claude version home .claude/settings.json (a `model` key, set by hand, no effort key), and each Codex version home .codex/config.toml (usually unset → built-in default).'
  - 'You have 6 accounts (3 Codex, 3 Claude) and none of them can carry its own default model or effort.'
  - 'A cloud run resolves model/effort locally and then does not send them, so the cloud silently uses a different model — "the cloud version" behaves differently for no reason you set.'
  - 'Grounded by a 4-agent code swarm + 2 independent reviews; engineering seams are in the appendix, deliberately kept out of the conceptual plan.'
links:
  - 'https://linear.app/getrush/issue/PHNX-3739'
  - 'https://linear.app/getrush/issue/PHNX-3853'
surface: cli
---

## Purpose

You want one place to set the handful of knobs you actually change often — **default
model**, **reasoning effort**, and **default mode** (plan / edit / auto) — with the option
to say *this account uses opus/high, that one uses sonnet/medium* — and you want it to hold
whether the agent runs on your machine or in the cloud. (These three already travel
together internally as one "run defaults" triple, so they share one home and one logic.) Right now none of that is true:
the knobs are spread across the CLI's own config file **and** a separate file inside every
installed version home, accounts have no model/effort of their own, and a cloud run quietly
drops the settings you resolved locally. This plan is about the **concept and the data** —
where config lives, what it looks like before and after, and the logic that picks a value.
(How the code changes is real but secondary; it's in the appendix.)

## Current architecture

**Where your config lives today — three scattered places.** The CLI's own file holds
run defaults keyed by agent+version (no notion of "account"). Separately, *each* installed
version home has its own native settings file the harness actually reads at launch — a
Claude `model` key you'd edit by hand, a Codex file that's usually unset. Your six accounts
sit in the CLI file as identities only, with nowhere to attach a model or an effort.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg class="artifact-diagram" viewBox="0 0 920 330" role="img" aria-label="Config scattered across three stores today">
    <rect x="30" y="40" width="300" height="250" rx="10" fill="#16120a" stroke="#f59e0b" stroke-width="1.6" />
    <text x="180" y="68" text-anchor="middle" fill="#e2e8f0" font-family="Inter, sans-serif" font-size="14">the CLI's own config</text>
    <text x="180" y="88" text-anchor="middle" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="11">~/.agents/agents.yaml</text>
    <line x1="50" y1="102" x2="310" y2="102" stroke="#3a2f1a" stroke-width="1" />
    <text x="50" y="126" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="11">run: defaults per agent+version</text>
    <text x="50" y="148" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="11">accounts: your 6 identities</text>
    <text x="50" y="176" fill="#dc2626" font-family="Inter, sans-serif" font-size="12.5">no per-account model/effort —</text>
    <text x="50" y="194" fill="#dc2626" font-family="Inter, sans-serif" font-size="12.5">accounts &amp; settings never meet</text>
    <text x="50" y="232" fill="#64748b" font-family="Inter, sans-serif" font-size="11.5">codex: personal · icloud · team</text>
    <text x="50" y="252" fill="#64748b" font-family="Inter, sans-serif" font-size="11.5">claude: work · prod · team</text>

    <rect x="380" y="40" width="250" height="110" rx="10" fill="#0d1117" stroke="#38bdf8" stroke-width="1.4" />
    <text x="505" y="66" text-anchor="middle" fill="#e2e8f0" font-family="Inter, sans-serif" font-size="13.5">every Claude version home</text>
    <text x="505" y="85" text-anchor="middle" fill="#38bdf8" font-family="JetBrains Mono, monospace" font-size="10">…/claude/&lt;version&gt;/.claude/settings.json</text>
    <text x="505" y="112" text-anchor="middle" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="11">model: claude-opus-4-8</text>
    <text x="505" y="132" text-anchor="middle" fill="#dc2626" font-family="Inter, sans-serif" font-size="11.5">by hand, per version · no effort key</text>

    <rect x="380" y="180" width="250" height="110" rx="10" fill="#0d1117" stroke="#38bdf8" stroke-width="1.4" />
    <text x="505" y="206" text-anchor="middle" fill="#e2e8f0" font-family="Inter, sans-serif" font-size="13.5">every Codex version home</text>
    <text x="505" y="225" text-anchor="middle" fill="#38bdf8" font-family="JetBrains Mono, monospace" font-size="10">…/codex/&lt;version&gt;/.codex/config.toml</text>
    <text x="505" y="252" text-anchor="middle" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="11">(usually unset)</text>
    <text x="505" y="272" text-anchor="middle" fill="#dc2626" font-family="Inter, sans-serif" font-size="11.5">falls back to built-in default</text>

    <rect x="680" y="95" width="210" height="140" rx="10" fill="#1a0e0e" stroke="#dc2626" stroke-width="1.5" />
    <text x="785" y="132" text-anchor="middle" fill="#e2e8f0" font-family="Inter, sans-serif" font-size="13.5">a cloud run</text>
    <text x="785" y="160" text-anchor="middle" fill="#fca5a5" font-family="Inter, sans-serif" font-size="12">resolves model/effort</text>
    <text x="785" y="178" text-anchor="middle" fill="#fca5a5" font-family="Inter, sans-serif" font-size="12">locally, then</text>
    <text x="785" y="200" text-anchor="middle" fill="#dc2626" font-family="Inter, sans-serif" font-size="13">does not send them</text>
    <text x="785" y="220" text-anchor="middle" fill="#fca5a5" font-family="Inter, sans-serif" font-size="11.5">→ a different model runs</text>
  </svg>
  <figcaption><b>Figure 1 — today.</b> The knobs live in the CLI file <em>and</em> inside every version home; accounts carry no model/effort; the cloud drops what you set.</figcaption>
</figure>

**What it actually looks like right now** (your real file, trimmed + anonymized):

```yaml
# ~/.agents/agents.yaml  — the CLI's config today
run:
  codex: { strategy: available }        # that's the whole model/effort story: nothing
accounts:
  native:
    - { name: personal, agent: codex,  email: you@… }
    - { name: icloud,   agent: codex,  email: you@… }
    - { name: team,     agent: codex,  email: team@… }
    - { name: work,     agent: claude, email: you@… }
    - { name: prod,     agent: claude, email: you@… }
    - { name: team,     agent: claude, email: team@… }
# ← nowhere here can you say "account work → opus / high"
```

```jsonc
// ~/.agents/.history/versions/claude/2.1.220/home/.claude/settings.json
// (one of these per installed Claude version — you'd edit each by hand)
{ "permissions": {…}, "hooks": {…}, "statusLine": {…}, "model": "claude-opus-4-8" }
//                                            ↑ the only model knob · there is NO effort key
```

```toml
# ~/.agents/.history/versions/codex/0.147.0/home/.codex/config.toml
approval_policy = "on-request"
sandbox_mode   = "workspace-write"
# no `model`, no `model_reasoning_effort` → Codex uses its built-in default
```

## Proposed Changes

**One place, two levels, applied everywhere.** Add a small `model:` and `effort:` block to
the CLI's own config — a **global default** plus optional **per-account** overrides. The CLI
reads it and applies the right value to *every* run, for Claude and Codex, on your machine
and in the cloud. You stop editing version-home files, and "the cloud version" stops being
a separate thing to set up.

<div class="artifact-behavior">
  <div class="artifact-behavior-panel" data-state="current" data-evidence="mockup">
    <b>Before — scattered, no account dimension</b><br/><br/>
    <span>· default model? edit settings.json in each Claude version home</span><br/>
    <span>· reasoning effort? no persistent home at all for Claude</span><br/>
    <span>· Codex model/effort? unset → built-in default</span><br/>
    <span>· "account work uses opus, personal uses sonnet"? impossible</span><br/>
    <span>· cloud? silently ignores what you resolved locally</span>
  </div>
  <div class="artifact-behavior-panel" data-state="proposed" data-evidence="mockup">
    <b>After — one block in one file</b><br/><br/>
    <span>· default model + effort: set once, centrally</span><br/>
    <span>· per account: work → opus/high, personal → sonnet/medium</span><br/>
    <span>· applies to Claude + Codex, every version, no hand-editing</span><br/>
    <span>· same values local AND cloud — one config, one behavior</span><br/>
    <span>· `agents config show` prints the resolved value + why</span>
  </div>
</div>

**What it looks like after** — the *only* new thing is one block in the file you already
have (`run:` and `accounts:` are untouched, and you never open a version-home file again):

```yaml
# ~/.agents/agents.yaml  — after
model:
  default: opus                  # ← one global default, all accounts, both harnesses
  account:
    work:     opus               # ← per-account override
    personal: sonnet
effort:
  default: high
  account:
    work:     high
    personal: medium
mode:
  default: auto                  # ← plan / edit / auto — how a run starts (global is the useful one)
# (per-account mode is available too, but mode usually tracks the task, not the account)
# run: / accounts: unchanged. The CLI resolves this and stamps the right model/effort/mode
# onto every run — local and cloud — so no version-home file is ever hand-edited again.
```

### The logic that picks a value (this is the whole concept)

When any run starts — local or cloud, Claude or Codex — the model and effort are chosen
**top-down, first match wins**:

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg class="artifact-diagram" viewBox="0 0 920 300" role="img" aria-label="Resolution ladder and one source applied everywhere">
    <text x="40" y="40" fill="#94a3b8" font-family="Inter, sans-serif" font-size="13">how a value is chosen (top wins)</text>
    <rect x="40" y="54" width="380" height="34" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="1.5" />
    <text x="58" y="76" fill="#e2e8f0" font-family="Inter, sans-serif" font-size="12.5">1 · what you typed for this run</text>
    <text x="300" y="76" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">--model / --effort</text>
    <rect x="40" y="94" width="380" height="34" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="1.2" />
    <text x="58" y="116" fill="#e2e8f0" font-family="Inter, sans-serif" font-size="12.5">2 · this account's override</text>
    <text x="300" y="116" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">model.account.work</text>
    <rect x="40" y="134" width="380" height="34" rx="6" fill="#14140a" stroke="#f59e0b" stroke-width="1.2" />
    <text x="58" y="156" fill="#e2e8f0" font-family="Inter, sans-serif" font-size="12.5">3 · the global default</text>
    <text x="300" y="156" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="11">model.default</text>
    <rect x="40" y="174" width="380" height="34" rx="6" fill="#0d0d0d" stroke="#475569" stroke-width="1.2" />
    <text x="58" y="196" fill="#cbd5e1" font-family="Inter, sans-serif" font-size="12.5">4 · the harness's own built-in default</text>

    <text x="560" y="40" fill="#94a3b8" font-family="Inter, sans-serif" font-size="13">one source → applied everywhere</text>
    <rect x="560" y="60" width="320" height="52" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.6" />
    <text x="720" y="82" text-anchor="middle" fill="#e2e8f0" font-family="Inter, sans-serif" font-size="13">model: / effort:  (one block)</text>
    <text x="720" y="101" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10.5">default + per-account, in agents.yaml</text>
    <line x1="720" y1="112" x2="720" y2="140" stroke="#a3e635" stroke-width="2" />
    <rect x="560" y="142" width="150" height="42" rx="7" fill="#16120a" stroke="#f59e0b" stroke-width="1.2" />
    <text x="635" y="168" text-anchor="middle" fill="#e2e8f0" font-family="Inter, sans-serif" font-size="12">runs on your machine</text>
    <rect x="730" y="142" width="150" height="42" rx="7" fill="#0b1220" stroke="#38bdf8" stroke-width="1.3" />
    <text x="805" y="168" text-anchor="middle" fill="#e2e8f0" font-family="Inter, sans-serif" font-size="12">runs in the cloud</text>
    <line x1="690" y1="112" x2="635" y2="140" stroke="#a3e635" stroke-width="1.6" />
    <line x1="750" y1="112" x2="805" y2="140" stroke="#a3e635" stroke-width="1.6" />
    <text x="720" y="212" text-anchor="middle" fill="#94a3b8" font-family="Inter, sans-serif" font-size="12">same block → same answer, so cloud is not a separate setup</text>
  </svg>
  <figcaption><b>Figure 2 — after.</b> One config block; a simple first-match-wins ladder; the same answer whether the agent runs locally or in the cloud.</figcaption>
</figure>

- **Per-account is keyed by the account's name** (`work`, `personal`) — the portable handle
  you already use, so the setting follows the account across your machines.
- **Accounts with private/device-only logins** keep their override on that machine (their
  identity is already device-local for privacy); shared accounts sync with the rest of your
  config.
- **Reasoning effort caveat, stated honestly:** Claude has no place in its own settings file
  to persist an effort — so effort is always applied as a launch setting, which is why the
  central config (not a settings.json edit) is the right home for it. Codex persists both.
- **Where the line is (what belongs here vs not):** this block holds the small **per-run
  triple you change often — model · effort · mode**, because all three already resolve
  together at launch. The *full permission ruleset* (Claude's allow/deny lists) is a
  bigger, harness-specific thing with its own home in the resources system — it stays
  there, not per-account. Rule of thumb: a single per-run knob → here; a whole ruleset → resources.

### The cloud, conceptually

Today a cloud run works out your model and effort and then simply doesn't include them in
what it sends, so the cloud runs on a different model than you asked for. The fix is not new
machinery — the cloud service **already understands** model, effort, and a pinned harness
version; the CLI just has to stop dropping them and send the same values it resolved. After
that, "run it in the cloud" uses your config exactly like a local run does.

## Public Interface

What you'd type:

```bash
# set the global defaults once (model · effort · mode — the three you change often)
agents config set model.default opus
agents config set effort.default high
agents config set mode.default auto            # plan / edit / auto

# give an account its own model/effort (per-account mode available but rarely needed)
agents config set model.account.work opus     --effort high
agents config set model.account.personal sonnet --effort medium

# see what will actually be used, and why (which level won), per account
agents config show
agents config get model.account.work

# a cloud run now uses the same config (today these are dropped/refused)
agents run claude --cloud --model opus --effort high
```

## Validation

| You do this | You should see |
| --- | --- |
| `config set model.account.work opus`, then run as `work` | Claude runs on opus; other accounts get the global default |
| Run the same account in the cloud | Same model/effort as local — not a different one |
| `config show` | The resolved value per account, and which level set it |
| Set nothing | Everything falls back to the global default, then the harness built-in |
| A private (device-only) account | Its override stays on that machine; not synced to the fleet |

## Risks

| Risk | How we handle it |
| --- | --- |
| The value could differ between "typed on the command" and "from config" | One ladder, one definition; `config show` always tells you which level won |
| Cloud behaving differently from local (today's silent drift) | The whole point: the same resolved config rides to the cloud |
| Private account emails leaking into synced config | Per-account overrides for device-only accounts stay device-local, like their identity already does |
| A per-account model an account can't actually serve | The CLI refuses it loudly rather than quietly falling back |

<aside class="artifact-callout"><strong>The one-sentence version:</strong> put default model + reasoning effort in one <code>model:</code>/<code>effort:</code> block (global + per-account) and let the CLI apply it to every run — the biggest single win is simply making cloud runs use the config they already resolve instead of dropping it.</aside>

## Rollout (each step is usable on its own)

- **Step 1 — cloud uses your config.** Make cloud runs send the model/effort/version they
  already resolve. Smallest change, immediately fixes "the cloud runs something different."
- **Step 2 — the config block.** Add `model:` / `effort:` with global default + per-account,
  and the `agents config set …` surface + a `config show` that explains the resolved value.
- **Step 3 — housekeeping.** Collapse a few duplicated internal tables so adding a harness
  is one entry (keeps this honest and maintainable; invisible to you).
- **Later (with Bisma) — the named config object.** Make "your config" one addressable
  thing the console can edit too (this is her cloud/console ticket, PHNX-3739).

## Decisions worksheet — where I want your input

The review settled three things that weren't really choices (marked **Decided**; override
if you disagree). The rest are genuinely yours.

### Decided by the review (say if you disagree)

| # | Question | Call | Why |
| --- | --- | --- | --- |
| A | Also write into version-home settings.json / config.toml? | **No** | The CLI applies model/effort to every `agents run` already; editing version-home files adds a second source that can disagree. Claude can't even persist effort there. |
| B | New `model.*` names vs reuse the old `run.*` names | **Friendly `model.*` names** over the existing storage | You get `model.default` / `model.account.work` (reads like your ask) with no new place for data to live. |
| C | Where the per-harness "which native key" mapping lives | **One shared table** | So Claude, Codex and future harnesses are covered by one row each, not scattered special-cases. |

### Genuinely yours to call

| # | Question | Options | My recommendation |
| --- | --- | --- | --- |
| **1** | How far to take the cloud in this pass | Just make cloud use your config now **vs** also build the full named-config object with Bisma now | **Config now**, named object as a coordinated follow-up (PHNX-3739) |
| **2** | Bundle the internal housekeeping (Step 3) now | With the config change **vs** a separate immediate follow-up | **Follow-up** — keeps this change small and reviewable |
| **3** | Auto-update | Keep today's once-a-day prompt (already on by default) **vs** add a silent "update between runs" mode | **Keep the prompt** — silent mode is optional |
| **4** | Cloud ownership | Land the CLI + cloud-wire slice here and coordinate the console half with Bisma **vs** do it all here | **Slice + coordinate** — fastest real result |

## Appendix — implementation seams (for engineers, not the concept)

This is the "which functions change" layer, deliberately separated from the plan above.

- **One resolver, threaded:** `resolveRunDefaults` (`run-defaults.ts:202`) gains an optional
  `account` and reads a `model:`/`effort:` block folded in as one entry — no new resolver.
- **Cloud stops dropping fields:** `buildDispatchBody` (`rush.ts`) + `DispatchOptions`
  (`types.ts`) gain `model`/`effort`/`version`; delete the stale `--effort` / `@version`
  rejects in `run-cloud.ts` (and mirror in `cloud.ts`); the backend `parseCloudRunBody`
  already accepts all three (PHNX-3946 effort, PHNX-3736 version).
- **Native key mapping:** one `supports()`-gated table (Claude `settings.json.model`; Codex
  `config.toml` `model` + `model_reasoning_effort`) with a completeness test — not per-agent
  `if/else`.
- **Housekeeping:** collapse the `profiles.ts` env-key trio + mirror into one `AGENTS`
  entry and the `models.ts` `if (agent===)` chains into a per-harness catalog provider.
- Full grounding: `.agents/scratch/research/out/{config-core,accounts,modules,cloud-update}.md`.

## Tracking

- PHNX-3739 — Reusable agent configuration (home ticket; this is its config + cloud-wire slice)
- PHNX-3853 — Console: manage multiple cloud accounts
- Session tasks: this session's TaskCreate checklist
