---
kind: report
title: 'Why "Agents: New Codex" kept asking for permission'
summary: "Codex had no auto mode, so the extension's --mode auto silently became edit — and edit hardcodes the approval policy that asks. Four links, one hardcoded string, and a permission system that structurally cannot reach Codex."
status: fixed
tracking: codex-auto-mode
facts:
  - '4 links from button to dialog'
  - '1 line was the actual cause'
  - '0 of your permission rules reach Codex'
links: []
---

## Summary

You pressed **Agents: New Codex** and Codex stopped to ask before running `scp`.
It should not have: the extension launches every agent with `--mode auto`, which
means "do not ask me".

It asked because **Codex had no `auto` mode**. The mode resolver silently
degraded `auto` to `edit`, and `edit` hardcodes Codex's *asking* approval policy.
Nothing in the chain was broken enough to throw an error — each link did
something defensible, and the defensible things composed into a dialog box in
front of an agent nobody was watching.

The second half of your question — why your `~/.agents` permission groups did not
apply — has a different and more permanent answer: **they cannot**. Codex has no
per-command allowlist to write them into.

## Findings

### The chain, end to end

Four hops, each verified in the source:

<div class="artifact-figure artifact-figure-wide">
<svg viewBox="0 0 880 272" role="img" aria-label="Four-stage chain from the extension button to the approval dialog, with the failure at stage 3">
  <defs>
    <marker id="ar" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
      <path d="M0,1 L8,4.5 L0,8 z" fill="currentColor" opacity="0.55"/>
    </marker>
  </defs>

  <g font-family="ui-monospace, SFMono-Regular, monospace" font-size="12">
    <!-- stage 1 -->
    <rect x="8" y="60" width="196" height="86" rx="8" fill="#3b82f6" fill-opacity="0.12" stroke="#3b82f6" stroke-opacity="0.5"/>
    <text x="20" y="82" font-size="11" font-weight="700" fill="currentColor">1 · AGI EXT</text>
    <text x="20" y="102" font-size="10.5" fill="currentColor" opacity="0.85">agents.ts:243</text>
    <text x="20" y="122" font-size="11" fill="currentColor">--mode auto</text>
    <text x="20" y="138" font-size="10" fill="currentColor" opacity="0.7">"don't ask me"</text>

    <!-- stage 2 -->
    <rect x="228" y="60" width="196" height="86" rx="8" fill="#3b82f6" fill-opacity="0.12" stroke="#3b82f6" stroke-opacity="0.5"/>
    <text x="240" y="82" font-size="11" font-weight="700" fill="currentColor">2 · resolveMode</text>
    <text x="240" y="102" font-size="10.5" fill="currentColor" opacity="0.85">exec.ts:119</text>
    <text x="240" y="122" font-size="11" fill="currentColor">auto → edit</text>
    <text x="240" y="138" font-size="10" fill="currentColor" opacity="0.7">silent, by design</text>

    <!-- stage 3: the culprit -->
    <rect x="448" y="52" width="196" height="102" rx="8" fill="#ef4444" fill-opacity="0.14" stroke="#ef4444" stroke-opacity="0.65" stroke-width="1.5"/>
    <text x="460" y="74" font-size="11" font-weight="700" fill="currentColor">3 · codexPolicyArgs</text>
    <text x="460" y="94" font-size="10.5" fill="currentColor" opacity="0.85">codex-policy.ts:58</text>
    <text x="460" y="116" font-size="11" fill="currentColor">approval_policy=</text>
    <text x="460" y="131" font-size="11" fill="currentColor">"on-request"</text>
    <text x="460" y="147" font-size="10" fill="currentColor" opacity="0.75">hardcoded for edit</text>

    <!-- stage 4 -->
    <rect x="668" y="60" width="196" height="86" rx="8" fill="#f59e0b" fill-opacity="0.13" stroke="#f59e0b" stroke-opacity="0.55"/>
    <text x="680" y="82" font-size="11" font-weight="700" fill="currentColor">4 · Codex</text>
    <text x="680" y="102" font-size="10.5" fill="currentColor" opacity="0.85">sandbox denies scp</text>
    <text x="680" y="122" font-size="11" fill="currentColor">asks you</text>
    <text x="680" y="138" font-size="10" fill="currentColor" opacity="0.7">agent stops</text>

    <g color="currentColor">
      <line x1="206" y1="103" x2="224" y2="103" stroke="currentColor" stroke-opacity="0.55" marker-end="url(#ar)"/>
      <line x1="426" y1="103" x2="444" y2="103" stroke="currentColor" stroke-opacity="0.55" marker-end="url(#ar)"/>
      <line x1="646" y1="103" x2="664" y2="103" stroke="currentColor" stroke-opacity="0.55" marker-end="url(#ar)"/>
    </g>

    <text x="448" y="185" font-size="11" font-weight="700" fill="#ef4444">the one line that caused it</text>
    <text x="448" y="203" font-size="10.5" fill="currentColor" opacity="0.8">every non-plan, non-skip mode collapsed into edit</text>

    <text x="8" y="240" font-size="10.5" fill="currentColor" opacity="0.7">The request said "never ask". By stage 3 that intent no longer existed —</text>
    <text x="8" y="257" font-size="10.5" fill="currentColor" opacity="0.7">edit cannot distinguish "the user chose edit" from "auto had nowhere to go".</text>
  </g>
</svg>
<p class="artifact-legend">Read left to right. Stages 1, 2 and 4 each behaved as designed; the defect is that stage 2's fallback landed in a mode whose approval policy stage 3 hardcodes.</p>
</div>

### Why your permission groups never applied

This is not a sync bug and no amount of configuration fixes it. The codebase
says so in its own words:

```
lossyBecause: 'Codex has no rule list — its sandbox mode is widened
               into representative blanket grants'
                    — permissions-registry.ts:361
```

Every harness gets a translation from your canonical rules. For Claude, a rule
survives as a rule. For Codex, the entire allowlist collapses into **two
scalars**:

<div class="artifact-figure artifact-figure-wide">
<svg viewBox="0 0 880 260" role="img" aria-label="Canonical permission rules collapsing into two Codex scalars">
  <g font-family="ui-monospace, SFMono-Regular, monospace" font-size="11">
    <text x="8" y="26" font-size="11.5" font-weight="700" fill="currentColor">your rules (~/.agents + ~/.agents/.system)</text>

    <g fill="currentColor" opacity="0.85">
      <rect x="8" y="42" width="150" height="22" rx="4" fill="#22c55e" fill-opacity="0.14" stroke="#22c55e" stroke-opacity="0.4"/>
      <text x="18" y="57">Bash(git:*)</text>
      <rect x="8" y="72" width="150" height="22" rx="4" fill="#22c55e" fill-opacity="0.14" stroke="#22c55e" stroke-opacity="0.4"/>
      <text x="18" y="87">Bash(rg:*)</text>
      <rect x="8" y="102" width="150" height="22" rx="4" fill="#22c55e" fill-opacity="0.14" stroke="#22c55e" stroke-opacity="0.4"/>
      <text x="18" y="117">Bash(ls:*)</text>
      <rect x="8" y="132" width="150" height="22" rx="4" fill="#22c55e" fill-opacity="0.14" stroke="#22c55e" stroke-opacity="0.4"/>
      <text x="18" y="147">WebFetch(...)</text>
      <text x="18" y="177" opacity="0.6">…hundreds more</text>
    </g>

    <!-- claude branch -->
    <path d="M166,80 C230,80 230,50 300,50" fill="none" stroke="#22c55e" stroke-opacity="0.5" stroke-width="1.5"/>
    <rect x="304" y="30" width="230" height="44" rx="6" fill="#22c55e" fill-opacity="0.12" stroke="#22c55e" stroke-opacity="0.45"/>
    <text x="316" y="49" font-size="11" font-weight="700" fill="currentColor">Claude · settings.json</text>
    <text x="316" y="65" font-size="10.5" fill="currentColor" opacity="0.8">every rule survives as a rule</text>

    <!-- codex branch -->
    <path d="M166,120 C230,120 230,150 300,150" fill="none" stroke="#ef4444" stroke-opacity="0.5" stroke-width="1.5"/>
    <rect x="304" y="118" width="230" height="72" rx="6" fill="#ef4444" fill-opacity="0.12" stroke="#ef4444" stroke-opacity="0.5"/>
    <text x="316" y="137" font-size="11" font-weight="700" fill="currentColor">Codex · config.toml</text>
    <text x="316" y="156" font-size="10.5" fill="currentColor">approval_policy = "on-request"</text>
    <text x="316" y="173" font-size="10.5" fill="currentColor">sandbox_mode = "workspace-write"</text>

    <text x="556" y="140" font-size="10.5" fill="currentColor" opacity="0.8">only a blanket Bash(*) reaches</text>
    <text x="556" y="157" font-size="10.5" fill="currentColor" opacity="0.8">approval_policy: never. Your rules</text>
    <text x="556" y="174" font-size="10.5" fill="currentColor" opacity="0.8">are per-command, so it wrote the</text>
    <text x="556" y="191" font-size="10.5" fill="currentColor" opacity="0.8">weaker branch — the asking one.</text>

    <text x="8" y="222" font-size="10.5" fill="currentColor" opacity="0.7">Codex exposes no per-command allowlist at all. There is nothing on the right-hand side</text>
    <text x="8" y="239" font-size="10.5" fill="currentColor" opacity="0.7">for Bash(git:*) to become — so the translator widens the whole set into two scalars.</text>
  </g>
</svg>
<p class="artifact-legend">The same canonical rule set, translated for two harnesses. The Codex side is lossy by construction, not by omission.</p>
</div>

Confirmed in the Codex version home on the Linux worker the session was actually running on:

```
~/.agents/.history/versions/codex/0.145.0/home/.codex/config.toml:1
approval_policy = "on-request"
```

### The second discovery: the sandbox has a network proxy

Look again at the two lines above the dialog in your screenshot —
`Could not resolve hostname <host>: Temporary failure in name resolution`. The
`scp` did not politely wait for permission. It **ran, failed, and then Codex
escalated** it into an approval request.

I reproduced it with a live Codex run on that worker:

```
getent hosts example.com   →  DNSFAIL
curl https://example.com   →  curl: (56) CONNECT tunnel failed, response 403
```

Codex 0.146 routes sandboxed traffic through **its own filtering proxy**
(`network_proxy = true`), which 403s anything not allowlisted — even though the
launch profile sets `network = { enabled = true }`. So inside the sandbox,
`ssh`, `scp`, and tailnet access do not work at all.

This matters for what you should expect after the fix: those commands will now
**fail silently instead of prompting you**. That is the correct behavior for an
unattended agent, but it is not the same as "it works now".

## Evidence

| Link | Location | What it does |
|---|---|---|
| Extension launch | `apps/ext/src/core/agents.ts:243` | `const effectiveMode = mode ?? 'auto'` — always appends `--mode auto` |
| Mode resolution | `apps/cli/src/lib/exec.ts:119` | `auto` not in Codex's modes → silently returns `edit` |
| Capability table | `apps/cli/src/lib/agent-spec/agents.ts:381` | `modes: ['plan', 'edit', 'skip']` — no `auto` |
| Policy builder | `apps/cli/src/lib/codex-policy.ts:58` | `edit` → `-c approval_policy="on-request"` |
| Adapter | `apps/cli/src/lib/harness/adapters/codex.ts:77` | anything not `plan`/`skip` → `'edit'` |
| Permission translator | `apps/cli/src/lib/permissions.ts:1079-1099` | only a blanket `Bash(*)` reaches `approval_policy: 'never'` |
| Registry note | `apps/cli/src/lib/permissions-registry.ts:361` | *"Codex has no rule list"* |

## Recommendations

### What was fixed

Codex now has a real `auto` mode. Verified against the actual command builder,
not a description of it:

```
edit -> approval_policy="on-request" | default_permissions="agents-edit"
auto -> approval_policy="never"      | default_permissions="agents-auto"
skip -> --dangerously-bypass-approvals-and-sandbox
```

The `agents-auto` profile has the **identical sandbox** to `agents-edit` —
workspace, `~/.agents`, the regenerable toolchain cache roots, network on. Only
the approval axis changes.

<div class="artifact-callout">
<strong>Autonomy is the approval axis only.</strong> `auto` does not widen the
sandbox by a single path, and <code>--mode skip</code> remains the one mode that
removes it. A sandbox-denied command under `auto` surfaces to the model as an
ordinary command failure it can work around — instead of a dialog that stops an
agent nobody is watching.
</div>

Interactive shim launches — a bare `codex` typed at your own terminal — still
pin `edit`, because there a prompt is the useful outcome.

Nine files: the policy builder, the adapter, the capability table, the command
template, four test files, plus the spec (`EXEC-22a`), `resource-sync.md`, and a
`.changelog/next/` fragment.

### What to do for fleet work

For anything that reaches another machine — `scp`, `ssh`, `gh`, the tailnet —
the sandbox's proxy makes `auto` useless, and only `--mode skip` works. You can
have that today without waiting for a CLI release: add a **Command Alias** in the
extension settings with agent `codex` and flags `--mode skip`. An explicit
`--mode` in the alias flags suppresses the injected default
(`apps/ext/src/core/agents.ts:245`).

I did not make `skip` the extension's default for Codex — that would drop the
sandbox on every Codex launch across every box, which is your call to make, not
a fix to slip into a bug PR.

### Reaching you

This fix lives in the CLI, so it arrives on your machines only after
`merged → published → tagged → fleet-upgraded`. Until that lands, the Command
Alias above is the unblock.
