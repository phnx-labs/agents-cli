---
kind: plan
surface: internal
title: "Mode-gated hooks: planning hooks fire only in plan mode"
summary: >
  Claude Code reports the live permission mode to every hook, but offers no
  declarative mode filter and no custom modes. Gate the planning hook's Stop
  backstop on permission_mode now; then add a declarative modes: field to
  agents-cli hook manifests as the durable mechanism.
status: awaiting-go
facts:
  - "permission_mode is a common hook stdin field: default · plan · acceptEdits · auto · dontAsk · bypassPermissions"
  - "No settings-level mode matcher exists; matchers filter by tool name only"
  - "Custom permission modes are not supported — the set of six is fixed"
  - "Exactly 1 of 27 registered .agents-system hooks is planning-related (1 script, 2 registrations)"
  - "0 hooks in .agents-system read permission_mode today"
  - "Live false positive: the Stop backstop blocked this session's Q&A answer on 2026-08-23"
links:
  - url: https://code.claude.com/docs/en/hooks
    label: "Claude Code docs — hooks input schema"
  - url: https://code.claude.com/docs/en/permission-modes
    label: "Claude Code docs — the six permission modes"
---

## Focus for review

- **The one decision: how far to take mode-gating.** Option 1 is a ~6-line early-exit in `plan-html-reminder.sh` (ships today, fixes the false positive). Option 2 is a declarative `modes:` field on hook manifests in agents-cli (a real CLI feature: types, sync wiring, a shared gate shim, tests). Recommended: **both, staged** — 1 now, 2 as the durable mechanism.
- **Custom modes are off the table.** Claude Code's permission modes are a fixed set of six; there is no supported way to define a seventh. The closest supported stand-ins are custom subagents (`.claude/agents/*.md`) and skills — no work proposed here unless you want one built.
- **Multi-harness safety.** Only Claude Code sends `permission_mode`. The gate must treat an absent field as "run the hook" so Codex/Grok/Kimi keep the existing transcript-scan backstop.

## Intent

Your ask, restated: in `~/.agents/.system`, make hooks activatable per mode — planning-instruction hooks should run only in plan mode — and check whether Claude Code supports defining a custom mode.

<div class="artifact-callout">
<p><strong>Proposal:</strong> gate <code>plan-html-reminder.sh</code>'s Stop path on <code>permission_mode == "plan"</code> now (absent field falls through to today's behavior), then add a declarative <code>modes:</code> field to agents-cli's hook manifests so any hook can be mode-scoped without copy-pasted shell. <strong>No custom mode:</strong> not supported by Claude Code — the six built-in modes are the whole set.</p>
</div>

## Purpose

Planning-instruction hooks exist to enforce plan presentation; outside plan mode they are pure overhead — a transcript scan on every stop, and (as today's live false positive showed) a wrongful block on ordinary answers that mention the word "plan". Mode-gating removes that noise without weakening the check where it belongs, and the declarative form gives every future hook the same knob for free.

## Current architecture

Hooks are declared in two manifests — `agents.yaml` (`hooks:` map) and per-subrule `hooks.yaml` — and `agents sync` writes them into every harness version home. At runtime the harness sends each hook a JSON blob on stdin. Claude Code includes `permission_mode` in that blob; **no script reads it today**.

The only planning hook is one script registered twice:

```
rules/subrules/plan-presentation/hooks.yaml
  plan-html-reminder        PreToolUse  matcher: ExitPlanMode   # inherently plan-only
  plan-html-stop-reminder   Stop        (no matcher)            # fires on EVERY stop
```

The Stop registration exists as a backstop for harnesses whose plan mode has no exit tool (Codex). It self-gates by regex-scanning the last assistant message and transcript for plan markers — which is how it blocked today's research answer that merely contained the words "plan" and "option".

<div class="artifact-figure-diagram">
<svg viewBox="0 0 960 560" role="img" aria-label="Hook pipeline from manifests through agents sync into harness settings, then the runtime Stop event; today the Stop hook runs in every mode, proposed adds a permission_mode gate" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="arB" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#38bdf8"/></marker>
    <marker id="arG" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#a3e635"/></marker>
    <marker id="arR" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#f87171"/></marker>
  </defs>

  <text x="24" y="26" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#a3e635">REGISTRATION — manifests → agents sync → every harness home</text>

  <rect x="24" y="40" width="200" height="78" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="36" y="62" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">agents.yaml  hooks:</text>
  <text x="36" y="80" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#c8c8c8">21 system hooks</text>
  <text x="36" y="96" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">guards · inject · verify</text>

  <rect x="24" y="130" width="200" height="78" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="36" y="152" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">subrule hooks.yaml</text>
  <text x="36" y="170" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#c8c8c8">6 rule-bundled guards</text>
  <text x="36" y="186" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#f59e0b">plan-presentation lives here</text>

  <line x1="224" y1="79" x2="292" y2="112" stroke="#38bdf8" stroke-width="1.5" marker-end="url(#arB)"/>
  <line x1="224" y1="169" x2="292" y2="136" stroke="#38bdf8" stroke-width="1.5" marker-end="url(#arB)"/>

  <rect x="296" y="88" width="180" height="72" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="308" y="112" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">agents sync</text>
  <text x="308" y="130" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#c8c8c8">collectSubruleHooks</text>
  <text x="308" y="146" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">writes hook registrations</text>

  <line x1="476" y1="124" x2="540" y2="124" stroke="#38bdf8" stroke-width="1.5" marker-end="url(#arB)"/>

  <rect x="544" y="72" width="392" height="104" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="556" y="94" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">Harness version homes</text>
  <text x="556" y="114" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">claude settings.json · codex · grok · kimi · cursor · droid</text>
  <text x="556" y="138" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#f59e0b">only Claude Code sends permission_mode on stdin;</text>
  <text x="556" y="154" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#f59e0b">other harnesses omit the field entirely</text>

  <text x="24" y="248" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#f87171">TODAY — Stop backstop runs in every session, every mode</text>

  <rect x="24" y="262" width="168" height="64" rx="8" fill="#141018" stroke="#c084fc" stroke-width="1.5"/>
  <text x="36" y="286" font-family="JetBrains Mono, monospace" font-size="11" fill="#c084fc">Stop event</text>
  <text x="36" y="304" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">any harness, any mode</text>

  <line x1="192" y1="294" x2="256" y2="294" stroke="#f87171" stroke-width="1.5" marker-end="url(#arR)"/>

  <rect x="260" y="262" width="300" height="64" rx="8" fill="#16120a" stroke="#f87171" stroke-width="1.5"/>
  <text x="272" y="284" font-family="JetBrains Mono, monospace" font-size="11" fill="#f87171">plan-html-reminder.sh (Stop)</text>
  <text x="272" y="302" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#c8c8c8">regex-scans transcript for plan markers</text>
  <text x="272" y="318" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">every stop pays the scan</text>

  <line x1="560" y1="294" x2="624" y2="294" stroke="#f87171" stroke-width="1.5" marker-end="url(#arR)"/>

  <rect x="628" y="262" width="308" height="64" rx="8" fill="#16120a" stroke="#f87171" stroke-width="1.5"/>
  <text x="640" y="284" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#f87171">False positive (today, this session)</text>
  <text x="640" y="302" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#c8c8c8">Q&amp;A answer mentioning “plan” + “options”</text>
  <text x="640" y="318" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">blocked; demanded a rendered HTML plan</text>

  <text x="24" y="382" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#a3e635">PROPOSED — permission_mode gate first, transcript scan only as fallback</text>

  <rect x="24" y="396" width="168" height="64" rx="8" fill="#141018" stroke="#c084fc" stroke-width="1.5"/>
  <text x="36" y="420" font-family="JetBrains Mono, monospace" font-size="11" fill="#c084fc">Stop event</text>
  <text x="36" y="438" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">stdin JSON</text>

  <line x1="192" y1="428" x2="256" y2="428" stroke="#a3e635" stroke-width="1.5" marker-end="url(#arG)"/>

  <rect x="260" y="392" width="240" height="76" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="272" y="414" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">permission_mode gate</text>
  <text x="272" y="432" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#c8c8c8">"plan" → run the check</text>
  <text x="272" y="448" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#c8c8c8">other value → exit 0 silently</text>
  <text x="272" y="462" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#f59e0b">absent → fall through (Codex, Grok…)</text>

  <line x1="500" y1="414" x2="564" y2="414" stroke="#a3e635" stroke-width="1.5" marker-end="url(#arG)"/>
  <line x1="500" y1="450" x2="564" y2="450" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="3 3" marker-end="url(#arB)"/>

  <rect x="568" y="392" width="368" height="40" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="580" y="416" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#c8c8c8">plan session → HTML-plan check runs exactly as today</text>

  <rect x="568" y="440" width="368" height="40" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="580" y="464" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#c8c8c8">no-field harness → existing transcript-marker backstop</text>

  <text x="24" y="520" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#8a8a8a">Fixed mode set (no custom modes):</text>
  <text x="24" y="540" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">plan</text>
  <text x="70" y="540" font-family="JetBrains Mono, monospace" font-size="11" fill="#8a8a8a">· default · acceptEdits · auto · dontAsk · bypassPermissions</text>
</svg>
</div>

Caption: registration flows left to right; the two runtime lanes contrast today's fire-everywhere Stop backstop with the proposed mode gate. Harnesses that never send `permission_mode` keep exactly today's behavior.

## Proposed changes

### Option 1 — gate the script (ships today, .agents-system only)

Early-exit at the top of `rules/subrules/plan-presentation/plan-html-reminder.sh`, right after the existing stdin parse:

```diff
 tool=$(printf '%s' "$input" | jq -r '(.tool_name // .toolName) // empty' 2>/dev/null) || tool=""
 event=$(printf '%s' "$input" | jq -r '(.hook_event_name // .hookEventName) // empty' 2>/dev/null) || event=""
+perm_mode=$(printf '%s' "$input" | jq -r '(.permission_mode // .permissionMode) // empty' 2>/dev/null) || perm_mode=""
+
+# Mode gate (Claude Code sends permission_mode; other harnesses omit it).
+# A reported non-plan mode means this stop cannot be presenting a plan —
+# skip the transcript scan entirely. Absent field → keep the backstop.
+if [ "$event" = "Stop" ] && [ -n "$perm_mode" ] && [ "$perm_mode" != "plan" ]; then
+  exit 0
+fi
```

The PreToolUse registration needs nothing — its `ExitPlanMode` matcher already only exists in plan mode.

### Option 2 — declarative `modes:` in agents-cli manifests (the durable mechanism)

Any hook entry may declare the modes it applies to; sync wraps it in one shared gate shim:

```yaml
# rules/subrules/plan-presentation/hooks.yaml (after)
plan-html-stop-reminder:
  script: plan-html-reminder.sh
  events: [Stop]
  modes: [plan]        # new — omit = all modes (today's behavior)
  timeout: 5
```

```diff
 // apps/cli/src/lib/types.ts
 export interface ManifestHook {
   script: string;
   events: HookEvent[];
   matcher?: string;
+  /** Permission modes this hook fires in; omitted = all. Gated at runtime
+   *  via hook-mode-gate; harnesses that do not report a mode always run. */
+  modes?: string[];
   timeout?: number;
 }
```

Sync installs a single `hook-mode-gate.sh` next to the hooks and registers gated entries as `hook-mode-gate.sh plan -- <script>`; the shim buffers stdin, checks `permission_mode` against its arguments (absent field → pass through), and pipes the original stdin to the real script. One implementation, zero per-hook boilerplate, works for every future mode-scoped hook.

### Custom modes — findings, no work proposed

Permission modes are a fixed set of six; hooks and the `--permission-mode` flag accept only those. No output-style or custom-mode surface exists in the current docs. Supported stand-ins if a named custom behavior is ever wanted: a custom subagent definition or a skill.

## Public Interface

The only new public surface is the manifest field. Hook script contracts (stdin JSON, exit codes) are unchanged.

```yaml
# ManifestHook schema — agents.yaml hooks: entries and subrule hooks.yaml
<name>:
  script: <path relative to hooks/ or subrule dir>
  events: [PreToolUse | PostToolUse | Stop | UserPromptSubmit | SessionStart | Notification]
  matcher: <tool-name regex>       # existing, optional
  modes: [plan | default | acceptEdits | auto | dontAsk | bypassPermissions]  # NEW, optional
  timeout: <seconds>
```

Omitting `modes:` keeps today's fire-in-every-mode behavior, so every existing manifest is valid unchanged. A harness that does not report a mode always runs the hook regardless of `modes:`.

## Files

| Change | File | Risk |
| --- | --- | --- |
| Option 1 gate | `.agents-system/rules/subrules/plan-presentation/plan-html-reminder.sh` | Low — additive early-exit; absent field preserves today's path |
| Option 1 test | `.agents-system/rules/subrules/plan-presentation/plan-html-reminder_test.sh` | Low — add non-plan-mode Stop case + absent-field case |
| Option 2 type | `agents-cli/apps/cli/src/lib/types.ts` (`ManifestHook.modes`) | Low |
| Option 2 shim + wiring | hook sync path + new `hook-mode-gate.sh` | Medium — touches registration for every harness; needs the completeness tests |
| Option 2 manifest | `.agents-system/rules/subrules/plan-presentation/hooks.yaml` | Low — replaces the Option 1 inline gate once landed |

## Plan

1. Land Option 1 in `.agents-system` (worktree + PR): gate + two test cases.
2. Verify live: a Claude Code non-plan session stops clean; a plan-mode session still gets the HTML-plan block; a Codex-style stdin (no `permission_mode`) still triggers the backstop.
3. Land Option 2 in agents-cli: `modes` on `ManifestHook`, gate shim, sync wiring, tests, docs + CHANGELOG.
4. Flip `plan-presentation/hooks.yaml` to `modes: [plan]` and drop the inline gate from the script.

## Validation

```bash
# non-plan Stop on Claude Code → silent pass
printf '{"hook_event_name":"Stop","permission_mode":"default"}' | plan-html-reminder.sh; echo rc=$?
# plan-mode Stop with no rendered HTML → block (exit 2)
printf '{"hook_event_name":"Stop","permission_mode":"plan","transcript_path":"..."}' | plan-html-reminder.sh; echo rc=$?
# no permission_mode field → today's transcript backstop unchanged
```

## Risks

- A harness that starts sending `permission_mode` with different semantics (Grok camelCase already handled) could skip a legitimate block — mitigated by only skipping on an explicit non-plan value.
- Option 2's shim must not swallow stdin or exit codes; the existing hook test suites gate this.

## Tracking

- **RUSH-3050** — Mode-gated hooks: fire planning hooks only in plan mode (this delivery's ticket)
- Stage 1 PR: [phnx-labs/.agents-system#362](https://github.com/phnx-labs/.agents-system/pull/362) — inline `permission_mode` gate; merge gated on the RUSH-3044 ruleset fix (needs an APPROVED review from a distinct identity)
- Stage 2 PR: [phnx-labs/agi-cli#2915](https://github.com/phnx-labs/agi-cli/pull/2915) — `matches.permission_mode` predicate (implemented via the existing `matches:` machinery rather than a parallel `modes:` field)
- Stage 3 (after #2915 ships fleet-wide): flip `plan-presentation/hooks.yaml` to `matches: { permission_mode: plan }` and drop the inline gate
