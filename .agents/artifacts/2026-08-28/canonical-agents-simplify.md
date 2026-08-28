---
kind: visual
title: One public `.agents` — rename the system repo, keep the paths, flip extras private
summary: Drop the confusing `-system` suffix and flip `.agents-extras` to private, changing zero local paths — maximum naming clarity at near-zero operational risk.
status: draft
links:
  - url: https://linear.app/phnx/issue/PHNX-3229
    label: PHNX-3229
  - url: https://linear.app/phnx/issue/PHNX-3315
    label: PHNX-3315
  - url: https://linear.app/phnx/issue/PHNX-3306
    label: PHNX-3306
---

## Story

The organizing bet: **bugs track lines of code — code and comments alike — so the win is measured by what this removes, not what it adds.** That is the same bet as serving funded, Series-A startups: they reward a small, legible, secure core over a growing feature count. This revision earns that by shrinking the change itself, not just the model.

Today the DotAgents model names repos after their jobs. There is `phnx-labs/.agents-system` (the npm-shipped defaults), `phnx-labs/.agents-extras` (a second Phoenix repo), and your own `muqsitnawaz/.agents`. But the layering already *is* the role: `resolveResource` resolves `project > user > system` by position (`cli/src/lib/resources.ts:181`). A repo does not need `-system` in its name to be the system layer — its position says so, and the local checkout dir `~/.agents/.system/` already names the layer, not the repo.

So the move is narrow and deliberate. **Rename `phnx-labs/.agents-system` → `phnx-labs/.agents`** — the one public default the CLI ships. **Keep `phnx-labs/.agents-extras` by name, and flip it private** — an opt-in repo that is also the natural home for the private steering layer (the operating principles that boot the fleet and never ship publicly). GitHub redirects the old remote, so the live fleet keeps pulling through the rename.

And crucially: **nothing on disk moves.** `~/.agents/.system/`, `~/.agents/`, and the `~/.agents-<alias>/` peer dirs all stay exactly as they are. This is the whole point of the revision — the earlier draft proposed re-plumbing every checkout under `~/.agents/.repos/<owner>/`, which is real churn that collides with the in-flight device-config refactor (PHNX-3315). Dropping it means the change is one repo rename plus one visibility flip. A serious customer never notices it; every agent stops tripping over `-system` vs `-extras`.

The follow-on rib — keep the boot injection (`03-linear-inject-tasks-context.sh`, `08-inject-repo-inflight.sh`) and add a tiny `UserPromptSubmit` scoping pass that filters the already-fetched tickets, PRs, memories, and sessions to the one prompt in hand — stays a separate, later lane. It is an addition, so under the deletion ethos it waits behind the rename.

One honest note on sequencing: on your own north star, the highest-leverage item open is not this cleanup — it is **PHNX-3306**, the Urgent compliance defect (consumer Claude OAuth tokens used server-side). This plan is craft; that one is a customer walking. I would land 3306 first and run this right behind it.

<div class="artifact-callout artifact-callout-warn">
<strong>The move:</strong> drop one confusing suffix (<code>phnx-labs/.agents-system</code> → <code>phnx-labs/.agents</code>), flip one repo's visibility (<code>.agents-extras</code> → private, same name), and change <strong>zero local paths</strong>. Maximum naming clarity at near-zero operational risk.
</div>

## Data

The rename touches a small surface — the repo-name references and the remote-identity checks. It deliberately leaves the large surface alone: the `.system` local-path references, the peer-scheme, and the legacy migrator all stay, because keeping paths as-is is the decision. Minimal blast radius is the feature, not a compromise.

<figure class="artifact-figure artifact-figure-wide artifact-figure-diagram">
<svg viewBox="0 0 900 280" role="img" aria-label="Blast radius: name references changed by the rename versus the path surface left unchanged" xmlns="http://www.w3.org/2000/svg">
  <text x="16" y="24" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">Blast radius — what the rename touches vs. what it leaves alone (grep, cli/src + docs, 2026-08-28)</text>

  <!-- changed -->
  <text x="16" y="66" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">agents-system / -extras name refs</text>
  <rect x="320" y="54" width="242" height="18" rx="4" fill="#a3e635" opacity="0.9"/>
  <text x="572" y="67" font-family="JetBrains Mono, monospace" font-size="11" fill="#c8c8c8">173</text>
  <text x="820" y="67" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#a3e635" text-anchor="end">CHANGED</text>

  <!-- divider -->
  <line x1="16" y1="88" x2="884" y2="88" stroke="#8a8a8a" stroke-width="1" opacity="0.35"/>

  <!-- unchanged group -->
  <text x="16" y="112" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">.system local-path refs</text>
  <rect x="320" y="100" width="533" height="18" rx="4" fill="#38bdf8" opacity="0.45"/>
  <text x="843" y="113" font-family="JetBrains Mono, monospace" font-size="11" fill="#c8c8c8">381</text>

  <text x="16" y="150" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">extra-repo peer-scheme refs</text>
  <rect x="320" y="138" width="113" height="18" rx="4" fill="#38bdf8" opacity="0.45"/>
  <text x="433" y="151" font-family="JetBrains Mono, monospace" font-size="11" fill="#c8c8c8">81</text>

  <text x="16" y="188" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">migrate-fold.ts (legacy migrator LOC)</text>
  <rect x="320" y="176" width="168" height="18" rx="4" fill="#38bdf8" opacity="0.45"/>
  <text x="488" y="189" font-family="JetBrains Mono, monospace" font-size="11" fill="#c8c8c8">120</text>

  <text x="820" y="150" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#38bdf8" text-anchor="end">UNCHANGED — kept on purpose</text>

  <line x1="320" y1="48" x2="320" y2="200" stroke="#8a8a8a" stroke-width="1" opacity="0.4"/>
  <text x="320" y="224" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">bar length ∝ count · absolute numbers labeled at right</text>
</svg>
<figcaption>The rename sweeps ~173 name references and the remote-identity checks. The 381 <code>.system</code> path refs, 81 peer-scheme refs, and the 120-line migrator stay untouched — no path churn.</figcaption>
</figure>

## Figure

The hero: repos get renamed on top, local checkout stays exactly as it is on the bottom, and the spine names what is now versus what is next.

<figure class="artifact-figure artifact-figure-wide artifact-figure-diagram">
<svg viewBox="0 0 960 480" role="img" aria-label="Before and after of the DotAgents repo naming, with local checkout unchanged" xmlns="http://www.w3.org/2000/svg">
  <!-- column headers -->
  <text x="40" y="30" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#f59e0b">BEFORE — role-named repos</text>
  <text x="520" y="30" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#a3e635">AFTER — one public name · extras goes private</text>

  <text x="40" y="52" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">github repos</text>
  <text x="520" y="52" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">github repos</text>

  <!-- before repos -->
  <rect x="40" y="60" width="380" height="44" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="56" y="82" font-family="JetBrains Mono, monospace" font-size="12" fill="#f59e0b">phnx-labs/.agents-system</text>
  <text x="56" y="97" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">npm-shipped defaults · read-only</text>

  <rect x="40" y="112" width="380" height="44" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="56" y="134" font-family="JetBrains Mono, monospace" font-size="12" fill="#f59e0b">phnx-labs/.agents-extras</text>
  <text x="56" y="149" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">second Phoenix repo · public today</text>

  <rect x="40" y="164" width="380" height="44" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="56" y="186" font-family="JetBrains Mono, monospace" font-size="12" fill="#38bdf8">muqsitnawaz/.agents</text>
  <text x="56" y="201" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">your user repo</text>

  <!-- after repos -->
  <rect x="520" y="60" width="400" height="44" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="536" y="82" font-family="JetBrains Mono, monospace" font-size="12" fill="#a3e635">phnx-labs/.agents</text>
  <text x="536" y="97" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">the default core · public · ships with the CLI</text>

  <rect x="520" y="112" width="400" height="44" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="536" y="134" font-family="JetBrains Mono, monospace" font-size="12" fill="#38bdf8">phnx-labs/.agents-extras</text>
  <text x="536" y="149" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">same name · now PRIVATE · opt-in · steering home</text>

  <rect x="520" y="164" width="400" height="44" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="536" y="186" font-family="JetBrains Mono, monospace" font-size="12" fill="#38bdf8">muqsitnawaz/.agents</text>
  <text x="536" y="201" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">your user repo · unchanged</text>

  <!-- connectors -->
  <line x1="420" y1="82" x2="520" y2="82" stroke="#38bdf8" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>
  <line x1="420" y1="134" x2="520" y2="134" stroke="#38bdf8" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>
  <line x1="420" y1="186" x2="520" y2="186" stroke="#38bdf8" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>
  <text x="470" y="52" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#a3e635" text-anchor="middle">drop -system · extras → private</text>

  <!-- local checkout band — unchanged -->
  <text x="40" y="252" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">local checkout — unchanged (no path churn)</text>

  <rect x="40" y="262" width="280" height="48" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="56" y="284" font-family="JetBrains Mono, monospace" font-size="12" fill="#38bdf8">~/.agents/</text>
  <text x="56" y="299" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">user layer · keep</text>

  <rect x="340" y="262" width="280" height="48" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="356" y="284" font-family="JetBrains Mono, monospace" font-size="12" fill="#38bdf8">~/.agents/.system/</text>
  <text x="356" y="299" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">system layer · KEEP (points at phnx-labs/.agents)</text>

  <rect x="640" y="262" width="280" height="48" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="656" y="284" font-family="JetBrains Mono, monospace" font-size="12" fill="#38bdf8">~/.agents-&lt;alias&gt;/</text>
  <text x="656" y="299" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">extra repos · keep</text>

  <!-- spine ribbon -->
  <text x="40" y="346" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">One spine — the rename now, the steering next</text>

  <rect x="40" y="358" width="280" height="72" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="56" y="384" font-family="JetBrains Mono, monospace" font-size="12" fill="#a3e635">Now · public core</text>
  <text x="56" y="402" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">rename → phnx-labs/.agents</text>
  <text x="56" y="416" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">the default that ships</text>

  <rect x="340" y="358" width="280" height="72" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="356" y="384" font-family="JetBrains Mono, monospace" font-size="12" fill="#a3e635">Now · extras private</text>
  <text x="356" y="402" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">.agents-extras → private · opt-in</text>
  <text x="356" y="416" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">the private steering home</text>

  <rect x="640" y="358" width="280" height="72" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="656" y="384" font-family="JetBrains Mono, monospace" font-size="12" fill="#38bdf8">Next · boot + scope</text>
  <text x="656" y="402" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">steering injected at SessionStart</text>
  <text x="656" y="416" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">+ prompt-time relevance · later lane</text>

  <text x="40" y="462" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">amber = renamed away · lime = done in this plan · blue = unchanged / later</text>
</svg>
<figcaption>The whole change: two repo edits on top (rename, flip private), nothing moved on the bottom, and the steering + scoping work held as an explicit next lane.</figcaption>
</figure>

### Sequencing — a small, contained change

| Phase | Move | Changes / removes | Hold |
| --- | --- | --- | --- |
| 1 | Rename `phnx-labs/.agents-system` → `phnx-labs/.agents` | The `-system` naming special-cases + the "which repo is which role" confusion | Remote-identity checks accept both names during cutover (GitHub redirects the URL) |
| 2 | Flip `phnx-labs/.agents-extras` to **private** (keep the name) | Public exposure of internal / steering resources | Register as an opt-in extra repo (`agents repo add`), disabled by default |
| — | Local paths (`~/.agents/.system`, `~/.agents-<alias>/`) | **Nothing** — kept as-is by decision | No migrator, no churn, no collision with PHNX-3315 |
| next | Private-steering boot hook + prompt-time scoping pass | Agents booting without the principles / re-deriving context | Separate later lane; keep the existing boot injection |

```bash
# Phase 1 — rename (old remote auto-redirects):
#   GitHub:  phnx-labs/.agents-system  ->  phnx-labs/.agents
#   Update remote-identity checks to accept BOTH names during cutover:
#     isSystemRepoOrigin / sameGitRemote / canonicalGitRemote   (cli/src/lib/git.ts)
# Phase 2 — flip extras private, keep the name:
#   GitHub:  set phnx-labs/.agents-extras visibility = private
#   Register opt-in:  agents repo add phnx-labs/.agents-extras   (disabled by default)
# Local paths (~/.agents/.system, ~/.agents-<alias>/) stay exactly as they are.
grep -rn "agents-system\|agents-extras" cli/src cli/docs   # ~173 name refs to sweep
```

## Tracking

- [PHNX-3229](https://linear.app/phnx/issue/PHNX-3229) — Clean agents-cli repository root and consolidate project skills into system resources
- [PHNX-3315](https://linear.app/phnx/issue/PHNX-3315) — Device-scoped config refactor (the churn this revision deliberately avoids colliding with)
- [PHNX-3306](https://linear.app/phnx/issue/PHNX-3306) — Urgent compliance defect; outranks this cleanup on the north star
