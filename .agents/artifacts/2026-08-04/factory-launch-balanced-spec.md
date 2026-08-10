---
kind: plan
title: "Every Factory agent launch is balanced"
summary: "One launch contract for New <Agent> / (Auto) / (Pick Host) — no bare, strategy-less command, ever."
status: proposed
project: agents-cli
repository: agents-cli
---

## Purpose

Every interactive agent Factory launches must use `--strategy balanced` (account/
version rotation) and `--mode auto` (writable-but-gated) — **always, with no
per-agent exception.** There is no case where you want a bare launch into whatever
account happens to be pinned, or an agent started with no mode. This plan makes
that an enforced invariant instead of an accident of allowlist membership.

Two invariants, no exceptions:

- **`--strategy balanced` is always present.** It spreads load and never launches
  into a throttled account.
- **`--mode auto` is always present.** The interactive agent starts writable so it
  can edit files without stalling on read-only plan approval.

The CLI drops `--strategy` in exactly one situation Factory never triggers: when
an `@version` is pinned. Factory never pins on a New launch, so the flag is always
emitted. **Shell** is not an agent runner (`command: ''`) and is out of scope — it
stays a plain terminal.

## Public Interface

Factory offers exactly three ways to start any agent, and **all three emit the
same flags** — only the host selection differs. No fourth shape, no bare command.

For every agent runner `X` (claude, codex, gemini, opencode, cursor, antigravity,
grok, kimi, droid):

| Command | Host selector | Runs on | Full command |
| --- | --- | --- | --- |
| **Agents: New X** | *(none)* | this machine | `agents run X --interactive --strategy balanced --mode auto` |
| **Agents: New X (Auto)** | `--device auto` | best fleet box (CLI picks) | `agents run X --interactive --device auto --strategy balanced --mode auto` |
| **Agents: New X (Pick Host)** | `--host '<device>'` | the device you pick | `agents run X --interactive --host '<device>' --strategy balanced --mode auto` |

Claude additionally carries `--session-id <id>` (minted up front so the tab can
resume/fork by id). That is the **only** per-agent addition, and it never removes
a flag.

<figure class="artifact-figure-diagram">
<svg viewBox="0 0 880 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Command palette mockup: three New-Claude variants on the left, the exact command each emits on the right">
  <rect x="20" y="16" width="440" height="288" rx="8" fill="#0e1418" stroke="#26313a" stroke-width="1.5"/>
  <rect x="34" y="30" width="412" height="24" rx="4" fill="#0a0f13" stroke="#26313a"/>
  <text x="44" y="46" font-family="JetBrains Mono, monospace" font-size="11" fill="#8a8a8a">&gt; Agents: New Claude</text>

  <rect x="34" y="62" width="412" height="40" rx="5" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="44" y="80" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">Agents: New Claude</text>
  <text x="44" y="95" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">launch locally on this machine</text>
  <text x="434" y="86" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10" fill="#a3e635">LOCAL</text>

  <rect x="34" y="108" width="412" height="40" rx="5" fill="#0e1418" stroke="#26313a"/>
  <text x="44" y="126" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">Agents: New Claude (Auto)</text>
  <text x="44" y="141" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">CLI auto-picks the best fleet host</text>
  <text x="434" y="132" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10" fill="#38bdf8">AUTO HOST</text>

  <rect x="34" y="154" width="412" height="40" rx="5" fill="#0e1418" stroke="#26313a"/>
  <text x="44" y="172" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">Agents: New Claude (Pick Host)</text>
  <text x="44" y="187" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">you choose the device</text>
  <text x="434" y="178" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10" fill="#f59e0b">PICK HOST</text>

  <text x="44" y="222" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">New Codex …  ·  New Grok …  ·  New Droid …  (same three variants, every agent)</text>
  <text x="44" y="266" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">Every row, whichever agent, resolves to the</text>
  <text x="44" y="282" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">same balanced + auto launch. No surprises.</text>

  <rect x="522" y="62" width="336" height="44" rx="6" fill="#0a0f0a" stroke="#2b3327"/>
  <text x="536" y="82" font-family="JetBrains Mono, monospace" font-size="11" fill="#cfe6a8">agents run claude --interactive</text>
  <text x="536" y="98" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">--strategy balanced --mode auto</text>

  <rect x="522" y="112" width="336" height="44" rx="6" fill="#0a0f0a" stroke="#2b3327"/>
  <text x="536" y="132" font-family="JetBrains Mono, monospace" font-size="11" fill="#cfe6a8">agents run claude --interactive <tspan fill="#38bdf8">--device auto</tspan></text>
  <text x="536" y="148" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">--strategy balanced --mode auto</text>

  <rect x="522" y="162" width="336" height="44" rx="6" fill="#0a0f0a" stroke="#2b3327"/>
  <text x="536" y="182" font-family="JetBrains Mono, monospace" font-size="11" fill="#cfe6a8">agents run claude --interactive <tspan fill="#f59e0b">--host 'x'</tspan></text>
  <text x="536" y="198" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">--strategy balanced --mode auto</text>

  <path d="M462 82 L520 84" stroke="#a3e635" stroke-width="1.5" opacity="0.7"/>
  <path d="M462 128 L520 134" stroke="#38bdf8" stroke-width="1.5" opacity="0.7"/>
  <path d="M462 174 L520 184" stroke="#f59e0b" stroke-width="1.5" opacity="0.7"/>
</svg>
<figcaption>The three New-agent variants (left) and the exact command each emits (right). The lime flags are identical across all three — only the host selector changes.</figcaption>
</figure>

## Proposed Changes

### Why a bare, strategy-less command ever happened

The launch surface had **three overlapping allowlists that disagreed**. Whether a
launch got `--strategy balanced` — and whether it even routed through `agents run`
at all — depended on which list an agent happened to be on.

<figure class="artifact-figure-diagram">
<svg viewBox="0 0 880 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Three disagreeing allowlists that gate strategy and routing">
  <rect x="20" y="20" width="270" height="250" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="34" y="44" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">STRATEGY_LAUNCH_AGENTS</text>
  <text x="34" y="60" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">core/agents.ts:245 — gates --strategy</text>
  <text x="34" y="90" font-family="JetBrains Mono, monospace" font-size="11" fill="#e6c07a">claude codex gemini opencode</text>
  <text x="34" y="108" font-family="JetBrains Mono, monospace" font-size="11" fill="#e6c07a">cursor antigravity grok kimi</text>
  <text x="34" y="140" font-family="JetBrains Mono, monospace" font-size="11" fill="#f87171">— droid MISSING</text>
  <text x="34" y="176" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">off-list agent →</text>
  <text x="34" y="192" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">strategy = undefined → bare command</text>

  <rect x="305" y="20" width="270" height="250" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="319" y="44" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">LAUNCHABLE</text>
  <text x="319" y="60" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">extension.ts:2343 — gates agents run</text>
  <text x="319" y="90" font-family="JetBrains Mono, monospace" font-size="11" fill="#e6c07a">claude codex gemini</text>
  <text x="319" y="108" font-family="JetBrains Mono, monospace" font-size="11" fill="#e6c07a">opencode cursor antigravity</text>
  <text x="319" y="140" font-family="JetBrains Mono, monospace" font-size="11" fill="#f87171">— grok kimi droid MISSING</text>
  <text x="319" y="176" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">off-list, local → raw binary,</text>
  <text x="319" y="192" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">no agents run, no strategy, no mode</text>

  <rect x="590" y="20" width="270" height="250" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="604" y="44" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">usesManagedAgentLaunch</text>
  <text x="604" y="60" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">core/agents.ts:250 — reuses list #1</text>
  <text x="604" y="90" font-family="JetBrains Mono, monospace" font-size="11" fill="#e6c07a">= list #1 OR a target host</text>
  <text x="604" y="122" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">routing and strategy welded to one</text>
  <text x="604" y="138" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">list — droid falls through both,</text>
  <text x="604" y="154" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">grok/kimi through the local one.</text>
</svg>
<figcaption>Three lists, three memberships. droid is on none; grok/kimi are on the strategy list but not the local-launch list. So local grok/kimi/droid ran as raw binaries with no rotation and no mode.</figcaption>
</figure>

The concrete result, per agent (before):

| Agent | New X (local) via `agents run`? | Got `--strategy balanced`? |
| --- | --- | --- |
| claude, codex, gemini, opencode, cursor, antigravity | yes | yes |
| grok, kimi | **no** — raw `grok` / `kimi` binary | **no** |
| droid | **no** — raw `droid` binary | **no** (not even on the list) |

### The fix — collapse three lists into one rule

Replace the allowlists with a single, source-of-truth rule: **every agent runner
(everything except `shell`) launches through `agents run <agent> --interactive
--strategy balanced --mode auto`.** Host selection is the only axis that varies.

<figure class="artifact-figure-diagram">
<svg viewBox="0 0 880 210" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Before three lists, after one rule">
  <rect x="20" y="30" width="360" height="150" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="36" y="56" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">Before</text>
  <text x="36" y="84" font-family="JetBrains Mono, monospace" font-size="11" fill="#e6c07a">STRATEGY_LAUNCH_AGENTS (8 agents)</text>
  <text x="36" y="106" font-family="JetBrains Mono, monospace" font-size="11" fill="#e6c07a">LAUNCHABLE (6 agents)</text>
  <text x="36" y="128" font-family="JetBrains Mono, monospace" font-size="11" fill="#e6c07a">usesManagedAgentLaunch (list #1 | host)</text>
  <text x="36" y="160" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#f87171">3 lists · disagree · bare commands</text>

  <path d="M392 105 L470 105" stroke="#38bdf8" stroke-width="2" stroke-dasharray="3 3" opacity="0.8"/>
  <polygon points="470,99 486,105 470,111" fill="#38bdf8"/>

  <rect x="500" y="30" width="360" height="150" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="516" y="56" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">After</text>
  <text x="516" y="88" font-family="JetBrains Mono, monospace" font-size="11" fill="#cfe6a8">isAgentRunner(key) = key !== 'shell'</text>
  <text x="516" y="116" font-family="JetBrains Mono, monospace" font-size="11" fill="#cfe6a8">→ agents run X --interactive</text>
  <text x="516" y="138" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">--strategy balanced --mode auto</text>
  <text x="516" y="166" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#a3e635">1 rule · no exceptions</text>
</svg>
<figcaption>The three allowlists become one predicate. Strategy and mode are constants of the launch, not a per-agent lookup.</figcaption>
</figure>

- **`src/vscode/extension.ts`** — `launchAgent` sets `strategy = 'balanced'`
  unconditionally (drop the `STRATEGY_LAUNCH_AGENTS` gate at ~L827).
  `openSingleAgent` routes **every** non-shell agent through `agents run` locally
  (retire the `LAUNCHABLE` set at ~L2343), so local grok/kimi/droid get the same
  command as a remote one.
- **`src/core/agents.ts`** — replace `STRATEGY_LAUNCH_AGENTS` and
  `usesManagedAgentLaunch`'s list dependency with a single `isAgentRunner(key)`
  predicate (`key !== 'shell'`). Keep `buildAgentLaunchCommand`'s existing "skip
  `--strategy` when `@version` pinned" guard — the one legitimate omission.
- **`src/core/forkSession.ts`** — `strategyForForkAgent` returns `'balanced'` for
  every runner (drop its allowlist), so a fork is balanced like every other launch.
- **`apps/factory/AGENTS.md`** — record this contract as the canonical launch
  spec the reviewer enforces.

## Validation

- Unit: a table test asserting **every** runner × {local, auto, pick-host} emits
  `--strategy balanced --mode auto`; a negative test that `shell` never gets
  `agents run`; a pinned-`@version` test that still omits `--strategy`.
- Update the existing `agents.test.ts`, `launchHost`, and `forkSession.test.ts`
  suites to the one-rule model (delete the allowlist-membership assertions).
- End-to-end: launch New Droid locally and confirm the tab runs
  `agents run droid --interactive --strategy balanced --mode auto`.

## Risks

<div class="artifact-callout artifact-callout-warn">
<p><strong>Behavioral change to see before shipping.</strong> Local <strong>grok / kimi / droid</strong> now launch through <code>agents run &lt;agent&gt;</code> instead of the raw binary. This is the point — it gives them balanced rotation and <code>--mode auto</code> — but it is a real change in how those three start locally. Verified safe against the CLI: <code>agents run &lt;agent&gt; --strategy balanced</code> is accepted for every runner; when there are no accounts to balance across (droid) it is a graceful no-op that falls back to the default, not an error (<code>rotate.ts:588</code>, <code>exec.ts:2094-2110</code>).</p>
</div>

Otherwise low risk: the six already-`agents run` agents are unchanged, and the CLI
already defaulted to balanced — this makes the flag explicit and universal rather
than changing what balanced does.

## Tracking

Recorded as the canonical launch contract in `apps/factory/AGENTS.md` so the spec
lives with the code and `prix/code-reviewer` enforces it on every PR.
