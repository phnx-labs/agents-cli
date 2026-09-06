---
kind: plan
surface: cli
title: One fleet configuration, explicitly applied
summary: Change a default once, choose when it takes effect, and see exactly which devices are ready.
status: proposed — not implemented
project: agents-cli
repository: phnx-labs/agents-cli
harness: codex
agent: codex
session: ""
host: ""
date: "2026-09-06"
tracking: PHNX-3975
links:
  - https://github.com/phnx-labs/agi-cli/pull/3487
  - https://linear.app/getrush/issue/PHNX-3975
  - https://linear.app/getrush/issue/PHNX-3923
  - https://linear.app/getrush/issue/PHNX-3940
---

## Focus for review

**Change a default once, choose when it takes effect, and see which devices still need attention.** The three stories below make that behavior reviewable before the storage and implementation detail. Downloaded, applied, and verified are distinct states.

1. Normal launches, account discovery, heartbeats and session updates must not write tracked configuration files.
2. Downloading a revision does not change native settings. Explicit apply targets one revision across the fleet.
3. Account identity survives binary upgrades. Homes and credentials remain device-owned.
4. “In sync” means every targeted device has verified the requested settings; offline or incompatible devices remain visible.

## Purpose

Change a default once for all Claude or Codex accounts on the laptop and workers. Nobody maintains account-to-home mappings by hand. Existing sessions keep their launch settings. Newly launched sessions use the last applied configuration, even offline.

<div class="artifact-callout">Same configuration means the same managed settings and resource revisions. It does not mean identical absolute paths, credentials, transcripts, installed binaries, or database bytes.</div>

### Story 1 · Change my default without changing work already running

“As the person running agents across several devices, I want to publish one model default and choose when it takes effect, so existing sessions keep working and new sessions use a known configuration.”

**Starting point:** every device is using revision r41. **My action:** publish r42, preview its effect, then explicitly apply it. **What I see:** downloading r42 leaves r41 active; each device reports r42 applied only after it checks the actual native settings. Revision labels are illustrative, not measured deployment results.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg viewBox="0 0 880 410" role="img" aria-label="Proposed sequence: user publishes a revision, device downloads without applying, user authorizes apply, device writes and verifies, then reports success">
<defs><marker id="story-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8" fill="#38bdf8"/></marker></defs>
<text x="24" y="28" fill="#a3e635" font-family="Inter, system-ui, sans-serif" font-size="15">PROPOSED · one successful device · time runs downward</text>
<circle cx="82" cy="64" r="11" fill="none" stroke="#f59e0b" stroke-width="2"/><path d="M82 75 V100 M64 86 H100 M82 100 L67 115 M82 100 L97 115" fill="none" stroke="#f59e0b" stroke-width="2"/>
<text x="82" y="139" text-anchor="middle" fill="#e6e8e6" font-size="15">You / CLI</text>
<rect x="213" y="66" width="180" height="56" rx="8" fill="#0e1418" stroke="#38bdf8"/><text x="303" y="89" text-anchor="middle" fill="#e6e8e6" font-size="15">Shared record API</text><text x="303" y="110" text-anchor="middle" fill="#a4aca6" font-size="12">publishes revisions</text>
<rect x="453" y="66" width="180" height="56" rx="8" fill="#0e1418" stroke="#38bdf8"/><text x="543" y="89" text-anchor="middle" fill="#e6e8e6" font-size="15">Device executor</text><text x="543" y="110" text-anchor="middle" fill="#a4aca6" font-size="12">daemon-owned apply</text>
<path d="M723 62 H815 L837 84 V124 H723 Z M815 62 V84 H837" fill="#16120a" stroke="#f59e0b"/><text x="780" y="94" text-anchor="middle" fill="#e6e8e6" font-size="13">Native settings</text><text x="780" y="112" text-anchor="middle" fill="#a4aca6" font-size="12">local files</text>
<path d="M82 151 V377 M303 151 V377 M543 151 V377 M780 151 V377" stroke="#647067" stroke-dasharray="4 5"/>
<path d="M82 177 H303" stroke="#38bdf8" marker-end="url(#story-arrow)"/><text x="94" y="165" fill="#e6e8e6" font-size="13">1 · Publish desired r42</text>
<path d="M303 218 H543" stroke="#38bdf8" marker-end="url(#story-arrow)"/><text x="316" y="203" fill="#e6e8e6" font-size="13">2 · Download; r41 stays active</text>
<path d="M82 263 H543" stroke="#38bdf8" marker-end="url(#story-arrow)"/><text x="94" y="249" fill="#e6e8e6" font-size="13">3 · Preview, then authorize r42 for named targets</text>
<path d="M543 310 H780" stroke="#38bdf8" marker-end="url(#story-arrow)"/><text x="552" y="287" fill="#e6e8e6" font-size="13">4 · Validate + journal + write</text><text x="552" y="303" fill="#a4aca6" font-size="12">Read back before marking applied</text>
<path d="M543 358 H82" stroke="#38bdf8" stroke-dasharray="5 4" marker-end="url(#story-arrow)"/><text x="99" y="344" fill="#a3e635" font-size="13">5 · r42 verified · new launches use r42</text>
<text x="24" y="400" fill="#a4aca6" font-size="12">Solid arrow: request / data transfer. Dashed return: verified result. Existing sessions retain their launch settings.</text>
</svg>
<figcaption>Figure 1. Publishing is not activation. The local executor performs and verifies the change. Step 3 abbreviates the shared API’s durable ordered request and delivery; it does not bypass that route. Local database writes are omitted here; Figure 5 shows ownership.</figcaption>
</figure>

### What the command feels like

Commands below marked proposed are a design, not commands available today. Revision numbers and fleet rows are illustrative.

<figure class="artifact-figure artifact-behavior">
<section data-state="current" data-evidence="mockup">
<h3>Today: desired settings and device details share YAML</h3>
<p>Abbreviated, anonymized reconstruction of the earlier CLI observation. This is not a screenshot or verbatim JSON.</p>
<pre>agents config list --json

browser.device: laptop
browser.profile: local-browser
interactive.host: laptop

No shared model default configured.</pre>
</section>
<section data-state="proposed" data-evidence="mockup">
<h3>Proposed: publish → download → apply → verify</h3>
<pre>Publish model setting
Desired r42 · Applied r41

Download r42
Native settings unchanged

Preview apply r42
laptop    ready
worker-a  model unsupported
worker-b  offline

Apply r42
laptop    r42 verified
worker-a  r41 blocked
worker-b  r41 pending

Fleet incomplete: 1 of 3</pre>
</section>
</figure>

### Story 2 · Tell me which devices still need attention

“As the operator, I want an offline or incompatible worker to stay visible, so a partial rollout never looks like success.”

After I authorize r42 for these three devices, the report stays **incomplete**. Reconnecting a worker authorizes only that queued revision, not every future edit. Resolving model incompatibility requires a compatible release or another explicit model choice; there is no silent fallback.

<section class="artifact-grid artifact-grid-3">
<article class="artifact-panel"><p class="artifact-tag artifact-tag-accent">Laptop · verified</p><h3>r41 → r42</h3><p>Native settings were read back. New sessions use r42; existing sessions keep their launch settings.</p></article>
<article class="artifact-panel"><p class="artifact-tag">Worker A · blocked</p><h3>Keep r41</h3><p>The requested model is unsupported. Show the model, installed harness release, and reason.</p></article>
<article class="artifact-panel"><p class="artifact-tag">Worker B · offline</p><h3>Last seen on r41</h3><p>Current state is unverified. On reconnect, check and apply the queued r42 request, then report back.</p></article>
</section>

<div class="artifact-callout artifact-callout-warn">Illustrative result: 1 of 3 targets verified. A downloaded revision, an old observation, and a successful write are not interchangeable with a verified application.</div>

### Story 3 · Add an account or upgrade without rebuilding my setup

“As someone with several accounts, I want account identity to survive device and binary changes, so I do not maintain account-to-folder mappings myself.”

Connect or discovery records the local home against a stable account ID. A new home receives the device’s already-applied settings before its first managed launch. An upgrade checks that same revision; it does not select a new account or silently activate a downloaded default.

<figure class="artifact-figure artifact-figure-diagram">
<svg viewBox="0 0 820 220" role="img" aria-label="One stable account identity maps to different device-owned homes; settings follow the applied revision and credentials remain local">
<circle cx="111" cy="96" r="53" fill="#0e1418" stroke="#38bdf8" stroke-width="2"/><text x="111" y="79" text-anchor="middle" fill="#e6e8e6" font-size="15">Account ID</text><text x="111" y="101" text-anchor="middle" fill="#a4aca6" font-size="13">stable identity</text><text x="111" y="121" text-anchor="middle" fill="#38bdf8" font-size="12">not a folder</text>
<path d="M164 96 H239 V56 H311 M239 96 V151 H311 M303 50 L311 56 L303 62 M303 145 L311 151 L303 157" fill="none" stroke="#38bdf8" stroke-width="1.5"/>
<path d="M323 28 H367 L381 42 H510 V89 H323 Z" fill="#16120a" stroke="#f59e0b"/><text x="338" y="64" fill="#e6e8e6" font-size="15">Laptop’s local home</text>
<path d="M323 123 H367 L381 137 H510 V184 H323 Z" fill="#16120a" stroke="#f59e0b"/><text x="338" y="159" fill="#e6e8e6" font-size="15">Worker’s local home</text>
<path d="M529 56 H572 M564 50 L572 56 L564 62 M529 151 H572 M564 145 L572 151 L564 157" fill="none" stroke="#a3e635"/>
<text x="589" y="52" fill="#a3e635" font-size="14">Use the applied revision</text><text x="589" y="74" fill="#a4aca6" font-size="12">before first managed launch</text>
<text x="589" y="147" fill="#a3e635" font-size="14">Same identity, different path</text><text x="589" y="169" fill="#a4aca6" font-size="12">existing credential policy unchanged</text>
<text x="28" y="211" fill="#a4aca6" font-size="12">Figure 2 · Identity is shared as records. Home paths and credentials are never copied by configuration sync.</text>
</svg>
</figure>

### Edge cases · the reference behind these stories

| State | What I see | What I do next |
| --- | --- | --- |
| New device | Desired r42 downloaded; no applied revision | Preview and apply r42 |
| Download only | Desired r42 / applied r41 | Existing launches keep r41 |
| Success | Applied r42; projection hash and check time | New launches use r42 |
| Unsupported model | Blocked; requested ID, harness release and reason | Upgrade compatible release or publish another model |
| Catalog inconclusive | Model availability unverified | Refresh catalog or explicitly authorize a provider probe |
| Native setting edited outside CLI | Drift: model differs from applied r42 | Reapply or explicitly adopt the edit into a new revision |
| Concurrent desired edit | Conflict on the changed key; both values preserved | Choose one value and publish a new revision |
| Disk/write failure | Apply incomplete; old revision remains recorded | Recover journal and retry; never claim success |
| Account absent | Config applied; account login missing | Connect that named account locally through existing flow |

## Current architecture

This is the **existing component/data-flow view**, not the proposed design. Runtime-generated shared rows and authored configuration still meet in a local Git checkout. Git commands execute in the CLI or daemon; a repository is only storage and transport.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg viewBox="0 0 860 465" role="img" aria-label="Existing components: CLI and daemon write distinct metadata files; local Git subprocesses exchange those with remote Git; launch reads merged metadata. Heartbeat and transcript backup have separate paths.">
<defs><marker id="current-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8" fill="#38bdf8"/></marker></defs>
<rect x="18" y="20" width="553" height="374" rx="14" fill="none" stroke="#738078" stroke-dasharray="7 5"/><text x="36" y="46" fill="#a4aca6" font-size="14">ONE DEVICE · same arrangement on peers</text>
<rect x="40" y="69" width="184" height="64" rx="8" fill="#0e1418" stroke="#38bdf8"/><text x="54" y="94" fill="#e6e8e6" font-size="15">CLI process</text><text x="54" y="115" fill="#a4aca6" font-size="12">config / account commands</text>
<path d="M335 66 H500 L520 86 V138 H335 Z M500 66 V86 H520" fill="#16120a" stroke="#f59e0b"/><text x="348" y="94" fill="#e6e8e6" font-size="14">Central / device YAML</text><text x="348" y="117" fill="#a4aca6" font-size="12">desired + device metadata</text>
<path d="M224 101 H335" stroke="#38bdf8" marker-end="url(#current-arrow)"/><text x="236" y="88" fill="#a4aca6" font-size="12">writes</text>
<rect x="40" y="171" width="184" height="67" rx="8" fill="#0e1418" stroke="#38bdf8"/><text x="54" y="196" fill="#e6e8e6" font-size="15">Daemon process</text><text x="54" y="217" fill="#a4aca6" font-size="12">shared-state services</text>
<path d="M335 167 H500 L520 187 V239 H335 Z M500 167 V187 H520" fill="#16120a" stroke="#f59e0b"/><text x="348" y="194" fill="#e6e8e6" font-size="14">daemon-state.json</text><text x="348" y="216" fill="#a4aca6" font-size="12">usage / auth / summaries</text>
<path d="M224 203 H335" stroke="#38bdf8" marker-end="url(#current-arrow)"/><text x="236" y="190" fill="#a4aca6" font-size="12">writes</text>
<rect x="301" y="302" width="234" height="64" rx="8" fill="#0e1418" stroke="#38bdf8"/><text x="316" y="327" fill="#e6e8e6" font-size="15">Local Git subprocesses</text><text x="316" y="348" fill="#a4aca6" font-size="12">commit / fetch / rebase / push</text>
<path d="M539 102 H551 V282 H442 V302 M424 239 V302" fill="none" stroke="#38bdf8" marker-end="url(#current-arrow)"/><text x="330" y="276" fill="#a4aca6" font-size="12">serialize / exchange</text>
<rect x="40" y="302" width="193" height="64" rx="8" fill="#0f160a" stroke="#a3e635"/><text x="54" y="327" fill="#e6e8e6" font-size="15">agents run</text><text x="54" y="348" fill="#a4aca6" font-size="12">resolve defaults + local home</text>
<path d="M335 144 H269 V278 H137 V302" fill="none" stroke="#38bdf8" marker-end="url(#current-arrow)"/><text x="69" y="263" fill="#a4aca6" font-size="12">reads merged metadata</text>
<path d="M635 288 C635 271 821 271 821 288 V356 C821 373 635 373 635 356 Z" fill="#0e1418" stroke="#38bdf8"/><ellipse cx="728" cy="288" rx="93" ry="15" fill="#0e1418" stroke="#38bdf8"/><text x="728" y="324" text-anchor="middle" fill="#e6e8e6" font-size="15">Remote Git repository</text><text x="728" y="347" text-anchor="middle" fill="#a4aca6" font-size="12">authored + generated files</text>
<path d="M535 318 H635" stroke="#38bdf8" marker-end="url(#current-arrow)"/><text x="575" y="304" fill="#a4aca6" font-size="12">push</text><path d="M635 349 H535" stroke="#38bdf8" marker-end="url(#current-arrow)"/><text x="575" y="371" fill="#a4aca6" font-size="12">fetch</text>
<text x="604" y="82" fill="#a3e635" font-size="14">Already separate today</text><text x="604" y="111" fill="#e6e8e6" font-size="13">Heartbeat / fleet-status cache</text><text x="604" y="132" fill="#a4aca6" font-size="12">local JSON, not this Git lane</text><text x="604" y="178" fill="#e6e8e6" font-size="13">Transcript backup objects</text><text x="604" y="199" fill="#a4aca6" font-size="12">managed HTTP / BYO storage</text><text x="604" y="220" fill="#a4aca6" font-size="12">not sessions.db replication</text>
<text x="25" y="425" fill="#a4aca6" font-size="12">Rounded node: executing component · Folded page: file · Cylinder: repository/store · Dashed enclosure: device</text><text x="25" y="447" fill="#a4aca6" font-size="12">Arrows carry named data / operations. The managed native shim is a separate launch path; both launch paths need the new apply boundary.</text>
</svg>
<figcaption>Figure 3. Current data paths, checked at ddd40af05. The exact central commit path differs between foreground CLI writes and daemon publication; both are code-owned operations.</figcaption>
</figure>

Presentation recheck: current main is <code>ddd40af05ed2ef32db9b1a31cd2df46c8685959e</code>, September 6, 2026. <a href="https://github.com/phnx-labs/agi-cli/blob/ddd40af05/cli/src/lib/state.ts#L1745">Foreground metadata writes already commit changed central configuration</a>; the <a href="https://github.com/phnx-labs/agi-cli/blob/ddd40af05/cli/src/lib/daemon/usage-sync-service.ts#L37">daemon owns its shared-state exchange</a>. <a href="https://github.com/phnx-labs/agi-cli/blob/ddd40af05/cli/src/lib/daemon/daemon.ts#L369">Heartbeat</a> and <a href="https://github.com/phnx-labs/agi-cli/blob/ddd40af05/cli/src/lib/fleet-status.ts#L114">fleet-status cache</a> are already local files. The redesign must remove the remaining generated Git writers, not claim that all operational state needs moving.

Original research baseline: agents-cli `83dc2a8133e41241938a81155bb368a8dcd04f5a`, fetched September 6, 2026. The original links below remain pinned; the current-main corrections above supersede any broader interpretation.

| Evidence | What it establishes |
| --- | --- |
| [account-registry.ts:358](https://github.com/phnx-labs/agents-cli/blob/83dc2a813/cli/src/lib/account-registry.ts#L358) `setNativeAccountHome` | Connect already records a device-owned home keyed by stable account ID. Preserve this behavior. |
| [account-registry.ts:497](https://github.com/phnx-labs/agents-cli/blob/83dc2a813/cli/src/lib/account-registry.ts#L497) `resolveAccountSelection` | A binding is a saved selection rule: target → account. It is distinct from the home map. CLI attach/detach owns these records; manual editing is unnecessary. |
| [run-defaults.ts:202](https://github.com/phnx-labs/agents-cli/blob/83dc2a813/cli/src/lib/run-defaults.ts#L202) | Current run defaults read `readMeta().run` plus project layers. Merely adding a pending document would still activate it early unless this reader changes. |
| [state.ts:1334](https://github.com/phnx-labs/agents-cli/blob/83dc2a813/cli/src/lib/state.ts#L1334) `writeMetaUnlocked` | Central and device metadata share a YAML serialization path. Storage ownership must change at this source. |
| [fleet-shared-repo-sync.ts:315](https://github.com/phnx-labs/agents-cli/blob/83dc2a813/cli/src/lib/fleet-shared-repo-sync.ts#L315) | Daemon publication commits central metadata alongside device state, then fetches and rebases. |
| [session/mirror.ts:66](https://github.com/phnx-labs/agents-cli/blob/83dc2a813/cli/src/lib/session/mirror.ts#L66) | Session summaries also enter the shared device-state writer. Moving accounts alone cannot remove runtime Git churn. |
| [session/sync/agents.ts:1](https://github.com/phnx-labs/agents-cli/blob/83dc2a813/cli/src/lib/session/sync/agents.ts#L1) | Transcript backup has a separate object-store/mirror flow; it does not replicate `sessions.db`. |
| [session/sync/net-client.ts:61](https://github.com/phnx-labs/agents-cli/blob/83dc2a813/cli/src/lib/session/sync/net-client.ts#L61) | Ordinary `put` overwrites unconditionally. Authenticated transport is reusable; safe concurrent configuration publication still needs a conditional revision contract. |

### Proposed architecture

Two views answer different questions. Figure 4 shows the network and ownership boundary. Figure 5 zooms into one device and names the components that perform apply. Neither diagram claims these proposed modules or protocols are shipped.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg viewBox="0 0 900 410" role="img" aria-label="Proposed fleet boundary view: operator CLI publishes through authenticated HTTPS API; per-device daemon exchanges typed records; local paths and credentials do not cross configuration transport">
<defs><marker id="fleet-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8" fill="#38bdf8"/></marker></defs>
<rect x="317" y="18" width="561" height="155" rx="12" fill="none" stroke="#738078" stroke-dasharray="7 5"/><text x="333" y="44" fill="#a4aca6" font-size="13">AUTHENTICATED SERVICE BOUNDARY · managed or BYO backend</text>
<circle cx="62" cy="65" r="10" fill="none" stroke="#f59e0b" stroke-width="2"/><path d="M62 75 V97 M45 85 H79 M62 97 L49 111 M62 97 L75 111" fill="none" stroke="#f59e0b" stroke-width="2"/>
<rect x="103" y="60" width="159" height="67" rx="8" fill="#0e1418" stroke="#38bdf8"/><text x="117" y="86" fill="#e6e8e6" font-size="15">CLI process</text><text x="117" y="108" fill="#a4aca6" font-size="12">edit / preview / apply</text><text x="36" y="134" fill="#a4aca6" font-size="12">Operator</text>
<rect x="343" y="67" width="220" height="78" rx="8" fill="#0e1418" stroke="#38bdf8"/><text x="359" y="93" fill="#e6e8e6" font-size="15">Revision API · proposed</text><text x="359" y="115" fill="#a4aca6" font-size="12">authorize + compare base revision</text><text x="359" y="133" fill="#a4aca6" font-size="12">order explicit apply requests</text>
<path d="M650 75 C650 59 854 59 854 75 V133 C854 149 650 149 650 133 Z" fill="#0e1418" stroke="#38bdf8"/><ellipse cx="752" cy="75" rx="102" ry="13" fill="#0e1418" stroke="#38bdf8"/><text x="752" y="106" text-anchor="middle" fill="#e6e8e6" font-size="14">Revision / request store</text><text x="752" y="128" text-anchor="middle" fill="#a4aca6" font-size="12">immutable data + conditional head</text>
<path d="M262 94 H343" stroke="#38bdf8" marker-end="url(#fleet-arrow)"/><text x="272" y="79" fill="#a4aca6" font-size="11">HTTPS</text><path d="M563 107 H650" stroke="#38bdf8" marker-end="url(#fleet-arrow)"/><text x="574" y="91" fill="#a4aca6" font-size="11">records</text>
<rect x="20" y="239" width="858" height="142" rx="12" fill="none" stroke="#738078" stroke-dasharray="7 5"/><text x="37" y="264" fill="#a4aca6" font-size="13">EACH ENROLLED DEVICE · local authority over native files and launch state</text>
<rect x="343" y="291" width="220" height="64" rx="8" fill="#0e1418" stroke="#38bdf8"/><text x="359" y="315" fill="#e6e8e6" font-size="15">Daemon process</text><text x="359" y="337" fill="#a4aca6" font-size="12">sync + authorized apply executor</text>
<path d="M430 145 V291" stroke="#38bdf8" marker-end="url(#fleet-arrow)"/><text x="45" y="201" fill="#38bdf8" font-size="13">Typed record exchange over HTTPS</text><text x="45" y="219" fill="#a4aca6" font-size="12">Down: revisions / exact apply requests</text>
<path d="M501 291 V145" stroke="#38bdf8" stroke-dasharray="5 4" marker-end="url(#fleet-arrow)"/><text x="525" y="201" fill="#38bdf8" font-size="13">Up: device-owned observations / verified results</text><text x="525" y="219" fill="#a4aca6" font-size="12">No database-file or native-home replication</text>
<path d="M45 301 C45 285 242 285 242 301 V343 C242 359 45 359 45 343 Z" fill="#0e1418" stroke="#38bdf8"/><ellipse cx="143.5" cy="301" rx="98.5" ry="12" fill="#0e1418" stroke="#38bdf8"/><text x="143" y="326" text-anchor="middle" fill="#e6e8e6" font-size="14">Local record stores</text><text x="143" y="346" text-anchor="middle" fill="#a4aca6" font-size="12">detail in Figure 5</text>
<path d="M343 324 H242" stroke="#38bdf8" marker-end="url(#fleet-arrow)"/><text x="257" y="308" fill="#a4aca6" font-size="12">persist</text>
<text x="635" y="316" fill="#f59e0b" font-size="14">Stays on this device</text><text x="635" y="338" fill="#a4aca6" font-size="12">paths / credentials / live processes</text>
<text x="25" y="402" fill="#a4aca6" font-size="12">Person: operator · Rounded node: process · Cylinder: store · Folded page: local state · Dashed enclosure: ownership boundary</text>
</svg>
<figcaption>Figure 4. Proposed logical boundary view, not a physical deployment topology. Backend implementation remains to be verified; the existing unconditional PUT is not a safe configuration-head protocol.</figcaption>
</figure>

#### Inside one device · who actually applies and launches

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg viewBox="0 0 900 585" role="img" aria-label="Proposed local component view: sync writes desired config; authorized apply reads desired config and local account homes, journals writes and readback, then advances applied config. Both launch paths use applied state; credentials and active sessions are preserved.">
<defs><marker id="local-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8" fill="#38bdf8"/></marker></defs>
<text x="25" y="28" fill="#a3e635" font-size="15">PROPOSED · component / data-flow view inside one enrolled device</text>
<rect x="24" y="48" width="852" height="507" rx="12" fill="none" stroke="#738078" stroke-dasharray="7 5"/>
<rect x="52" y="82" width="209" height="65" rx="8" fill="#0e1418" stroke="#38bdf8"/><text x="67" y="107" fill="#e6e8e6" font-size="15">Sync service · TypeScript</text><text x="67" y="128" fill="#a4aca6" font-size="12">config/sync.ts · daemon-owned</text>
<path d="M358 88 C358 71 570 71 570 88 V145 C570 162 358 162 358 145 Z" fill="#0e1418" stroke="#38bdf8"/><ellipse cx="464" cy="88" rx="106" ry="13" fill="#0e1418" stroke="#38bdf8"/><text x="464" y="117" text-anchor="middle" fill="#e6e8e6" font-size="15">config.db · SQLite</text><text x="464" y="139" text-anchor="middle" fill="#a4aca6" font-size="12">desired / applied / journal</text>
<path d="M661 88 C661 71 849 71 849 88 V145 C849 162 661 162 661 145 Z" fill="#0e1418" stroke="#38bdf8"/><ellipse cx="755" cy="88" rx="94" ry="13" fill="#0e1418" stroke="#38bdf8"/><text x="755" y="117" text-anchor="middle" fill="#e6e8e6" font-size="15">accounts.db · SQLite</text><text x="755" y="139" text-anchor="middle" fill="#a4aca6" font-size="12">IDs + this device’s home map</text>
<path d="M261 115 H358" stroke="#38bdf8" marker-end="url(#local-arrow)"/><text x="276" y="98" fill="#a4aca6" font-size="12">desired</text>
<rect x="329" y="237" width="278" height="90" rx="8" fill="#0f160a" stroke="#a3e635"/><text x="346" y="263" fill="#e6e8e6" font-size="15">Apply executor · TypeScript</text><text x="346" y="285" fill="#a4aca6" font-size="12">config/apply.ts · daemon-owned</text><text x="346" y="306" fill="#a3e635" font-size="12">lock → validate → journal → write → verify</text>
<path d="M435 161 V237" stroke="#38bdf8" marker-end="url(#local-arrow)"/><text x="246" y="192" fill="#a4aca6" font-size="12">read exact desired revision</text>
<path d="M526 237 V161" stroke="#38bdf8" stroke-dasharray="5 4" marker-end="url(#local-arrow)"/><text x="541" y="190" fill="#a4aca6" font-size="12">advance applied</text><text x="541" y="207" fill="#a4aca6" font-size="12">only after read-back</text>
<path d="M755 161 V282 H607" fill="none" stroke="#38bdf8" marker-end="url(#local-arrow)"/><text x="678" y="244" fill="#a4aca6" font-size="12">resolve local homes</text>
<path d="M57 218 H236 L251 233 V322 H57 Z M236 218 V233 H251" fill="#16120a" stroke="#f59e0b"/><text x="73" y="251" fill="#e6e8e6" font-size="14">Exact apply request</text><text x="73" y="274" fill="#a4aca6" font-size="12">revision + frozen target set</text><text x="73" y="297" fill="#a4aca6" font-size="12">explicitly authorized by you</text>
<path d="M251 282 H329" stroke="#38bdf8" marker-end="url(#local-arrow)"/><text x="265" y="267" fill="#a4aca6" font-size="12">execute</text>
<rect x="360" y="386" width="216" height="62" rx="8" fill="#0e1418" stroke="#38bdf8"/><text x="376" y="411" fill="#e6e8e6" font-size="15">Native config adapters</text><text x="376" y="432" fill="#a4aca6" font-size="12">existing harness-specific writers</text>
<path d="M449 327 V386" stroke="#38bdf8" marker-end="url(#local-arrow)"/><text x="227" y="361" fill="#a4aca6" font-size="12">write managed fields / read back</text>
<path d="M499 386 V327" stroke="#38bdf8" stroke-dasharray="5 4" marker-end="url(#local-arrow)"/>
<path d="M659 384 H829 L849 404 V453 H659 Z M829 384 V404 H849" fill="#16120a" stroke="#f59e0b"/><text x="674" y="415" fill="#e6e8e6" font-size="14">Native settings files</text><text x="674" y="437" fill="#a4aca6" font-size="12">per local account home</text>
<path d="M576 407 H659" stroke="#38bdf8" marker-end="url(#local-arrow)"/><path d="M659 435 H576" stroke="#38bdf8" stroke-dasharray="5 4" marker-end="url(#local-arrow)"/>
<rect x="54" y="484" width="304" height="48" rx="8" fill="#0f160a" stroke="#a3e635"/><text x="69" y="505" fill="#e6e8e6" font-size="14">agents run + managed native shim</text><text x="69" y="523" fill="#a4aca6" font-size="12">applied snapshot + recovery gate + local home</text>
<path d="M358 508 H416" stroke="#38bdf8" marker-end="url(#local-arrow)"/><rect x="417" y="484" width="175" height="48" rx="8" fill="#0e1418" stroke="#38bdf8"/><text x="432" y="514" fill="#e6e8e6" font-size="14">New harness process</text>
<text x="629" y="501" fill="#f59e0b" font-size="13">Not rewritten by config sync</text><text x="629" y="522" fill="#a4aca6" font-size="12">credentials / existing sessions</text>
<text x="27" y="576" fill="#a4aca6" font-size="12">Solid arrow: input or write · Dashed return: read-back / verified result · Cylinders store data; only named executors change settings.</text>
</svg>
<figcaption>Figure 5. Local execution ownership. A failed journal leaves managed launches gated until rollback or completion is verified. The launch row shows the consumer contract; its read edges are omitted to keep the apply path legible. Operational reports use their own store, outside this configuration zoom.</figcaption>
</figure>

**Authored resources remain a separate input:** resource repositories stay in Git. Desired revisions pin their commit hashes; download may fetch those commits, but only the same authorized apply boundary may activate their projection. Credentials use the existing device-role policy; this feature adds no credential transport.

These are C4-inspired component and boundary views, not a claim of formal UML conformance. The notation is explicit: a person initiates work, a process executes, a cylinder stores, a folded page is a file/record, and a dashed enclosure marks ownership. The <a href="https://c4model.com/diagrams/notation">C4 notation guidance</a> emphasizes labeled element types and directed relationships, not a mandatory shape palette; the <a href="https://c4model.com/diagrams/dynamic">dynamic-view guidance</a> informs the user-story sequence in Figure 1.

### Storage and ownership

| Data | Owner / storage | Shared behavior |
| --- | --- | --- |
| Account ID, name, provider | `accounts/accounts.db` replicated catalog | Same logical identity on every enrolled device; name is not the key |
| Default account and managed account-selection bindings | Desired/applied configuration revisions | Downloaded selection changes remain inactive until applied |
| Local account home, discovered installation, login observation | Device-owned rows in `accounts/accounts.db` | Share availability metadata keyed by device ID; do not apply another device's path |
| Desired settings, resource revision manifest, revision history | Shared service; durable replica in `config/config.db` | Publish explicit edits with base-revision comparison |
| Applied settings, managed-field hashes, recovery journal | Local `config/config.db` | Publish acknowledgements only after read-back succeeds |
| Heartbeat, usage and session summaries | Dedicated local operational store; session content stays in existing session store | Device-owned records outside Git; no changes to transcript semantics |
| Skills/rules/hooks authored by people or agents | Existing resource repositories | Git remains the authoring/review transport; pin resource commits in desired revision |
| OAuth material and provider secrets | Existing native homes / secrets mechanisms | No new credential transport in this feature |

All local database files, WAL/SHM files and generated metadata are ignored by Git. Use the existing SQLite wrapper, migrations and locking conventions. Do not repurpose the transcript database into an unrelated catch-all account store.

### Publish and conflict handling

The daemon syncs typed, schema-versioned records. A revision contains a canonical settings document, resource commit hashes, account catalog revision, parent revision, author/device ID and content hash. One conditional update of the shared head is the publication point. A failed comparison preserves the local draft and returns the conflicting keys; no wall-clock last-writer-wins for desired settings. Disjoint edits can be rebased after validation; conflicting edits require an explicit selection. Offline edits remain drafts until publication succeeds.

Reuse managed/BYO storage selection, authenticated networking and object storage from sessions. Extend a shared transport interface with conditional head reads/writes and test its server enforcement on both backends. Immutable revision upload precedes head advancement; failed head advancement leaves a harmless unreferenced object. Do not assume today's session endpoint is deployed or implements the required conditionals: a real authenticated concurrency probe is a release prerequisite.

Device reports have device ID, monotonic sequence, observed time and expiry. Only that enrolled device may submit its report. Display stale reports as stale; never let a peer's reported home mutate local mappings. Account removal uses tombstones so offline peers cannot resurrect removed records. Retain history until all active peers acknowledge, or explicitly retire a peer.

### Apply and launch contract

`apply` freezes a target-device list and revision. Preview is read-only, including bootstrap paths. Execution checks schema compatibility, resource availability, managed-field overrides and model support for each target home. It acquires a local apply lock, captures previous managed values, records a recovery journal, writes through existing native adapters, then reads back managed fields. Only a fully verified local application advances the applied revision. Cross-file updates use a recoverable journal, not a false promise of filesystem-wide atomicity.

A durable fleet apply request authorizes that exact revision for its targets, including devices that reconnect later. It does not authorize future revisions. Repeated requests are idempotent. Partial fleet completion remains partial. A later explicit request supersedes an earlier pending request by ordered request ID; cancellation leaves already-applied devices visible.

On failure or interruption, the journal leaves a persistent recovery-required launch gate. Managed launches remain blocked across CLI/daemon restarts until either all old managed values are restored and verified or the requested revision finishes and is verified. Releasing a process lock alone must never expose partially written native settings. Resource projection must use the same apply boundary; downloading new resource commits cannot activate them.

Both `agents run` and managed native shims read the last applied snapshot. Downloads never change launch behavior. A new local home receives the already-applied revision before its first launch; an unprojectable home cannot silently run a different fleet default. Binary upgrades recheck/project the same applied revision. Existing sessions retain their launch revision. Launches do not depend on network access; while an apply is active, new managed launches briefly wait or get an explicit retry message.

Project settings and command-line overrides remain intentional higher-precedence inputs and are shown as overrides. Device/version settings that conflict with fleet model parity must be reported at preview and removed or explicitly excluded; they cannot be hidden behind a green fleet badge. Identical native files across platforms are neither necessary nor desirable.

### Models and account identity

Set a concrete model ID when exact fleet model equality matters. A tier such as `best` can resolve differently on different releases; display every resolved ID and call that policy parity, not model parity. Unsupported exact models block apply, preserving the previous active revision. An unknown catalog result is “unverified,” not proof of rejection or entitlement. An explicit provider probe may establish access; later provider revocation is reported at launch and never silently changes the model.

Preserve existing UUID account IDs and `setNativeAccountHome` behavior. Connect/discovery associates a native identity with a local home automatically. Never infer equality from a display name alone: use provider identity plus organization/tenant where available; ambiguous matches remain unresolved. A binding is just an optional saved account choice for a target. Ordinary users choose a per-harness default or `--account`; they do not write mapping rows. Existing explicit bindings are imported without changing their meaning, while new defaults do not contain binary version numbers.

Identity discovery and availability observations may sync immediately. Default-account and managed-binding policies are pinned to the applied configuration revision, including the referenced account catalog revision. Replace account selection's current `readMeta()` input in `commands/exec.ts:2559` with applied policy; downloading a change from account A to B must keep choosing A until apply. Explicit per-run account selection remains an intentional override. A revoked or deleted account fails visibly rather than silently selecting another identity.

### Alternatives and research

Verified against primary documentation on September 6, 2026:

| Approach | Decision |
| --- | --- |
| Continue Git transport for generated runtime state | Reject: improving rebase locking does not remove concurrent runtime writers from the checkout. Keep Git for authored resources. |
| Copy or synchronize a live SQLite database | Reject: SQLite WAL requires same-host coordination; a backup API creates snapshots, not a multi-writer fleet merge protocol. |
| SQLite session-extension changesets | Viable building block, but table changesets still need application conflict rules, transport and rollout semantics. Do not add a second opaque replication protocol. |
| Local SQLite + typed record transport + explicit apply | Choose: fits existing adapters/storage and makes account ownership, conflicts and rollout state explicit. |

SQLite says “All processes using a database must be on the same host computer” in its [WAL documentation](https://sqlite.org/wal.html). The [backup API](https://sqlite.org/backup.html) is appropriate for local migration snapshots. The [session extension](https://sqlite.org/sessionintro.html) records changesets; it does not supply this application's desired/applied contract.

### Independent verification

An independent Claude planning pass received the requirements and source paths without this proposal.

- **Adopted:** desired/applied split, local database with record sync, offline launch path, stable identity/home/binary separation and verified parity.
- **Corrected:** its claim that bindings inherently require hand editing. `account-registry.ts:358` and attach/detach already automate writes. The design preserves useful explicit rules and removes manual upkeep from the default path.
- **Corrected:** its description of sessions as a universally conflict-free transport. `session/mirror.ts:66` still publishes summaries through shared Git state; that writer must move too.
- **Expanded:** its suggested owner-only edits into multi-device conditional publication, and its apply digest into a recoverable journal plus separate per-device projection hashes. The current network client's unconditional PUT is insufficient.
- **Adopted from non-author review:** persist the failed-apply launch gate across restarts, and pin default-account/binding selection to the applied revision. Both close paths where a download or failed apply could otherwise change launch behavior early.

## Proposed Changes

Illustrative changes, not implemented code:

```diff
cli/src/lib/run-defaults.ts
- resolveRunDefaultsFromConfigs([readMeta().run, ...projectRunConfigs], agent, version)
+ resolveRunDefaultsFromConfigs([readAppliedConfig().run, ...projectRunConfigs], agent, version)

cli/src/lib/account-registry.ts
- updateMeta(...deviceAccounts.homes...)
+ accountStore.recordLocalHome(accountId, installationLabel)

cli/src/lib/fleet-shared-repo-sync.ts
- publish generated account / usage / auth / session-summary rows through Git
+ retain authored-resource synchronization only
```

Introduce focused `accounts/db.ts`, `config/store.ts`, `config/sync.ts`, `config/apply.ts` modules under `cli/src/lib/`; extend existing adapters and storage abstractions. Keep command handlers thin. Inventory every generated writer before retiring YAML writes, including service discovery and session-tracker integrations. Do not declare the conflict issue solved after moving only account rows.

## Public Interface

Proposed command additions, reusing the existing config namespace:

```text
agents config set 'run.codex@*.model' <model-id>
agents config sync --fleet
agents config status --fleet --json
agents config apply --fleet --revision <revision> --dry-run
agents config apply --fleet --revision <revision>
```

`set` publishes desired state when online; offline it reports a queued draft. `sync` exchanges configuration records without applying. `status` includes desired/downloaded/applied revision, requested and resolved model, projection digest, drift, freshness, blocked reason and account readiness. JSON separates configuration parity from authentication readiness. A partially applied target set returns a non-success result with individual states.

## Plan

- [ ] Inventory existing writers and migration inputs; preserve dirty user data and scoped overrides.
- [ ] Add local account/config stores, stable IDs, schema migrations and one-time imports with checksummed backups.
- [ ] Add authenticated revision transport, concurrent publication and per-device acknowledgements.
- [ ] Build read-only preview and journaled apply through existing native adapters.
- [ ] Route all managed launch paths to applied settings; initialize new homes and check upgrades.
- [ ] Move remaining generated account/session/heartbeat/service metadata off tracked files; enforce Git cleanliness in the real flow.
- [ ] Roll out on isolated fixtures, two workers, then the fleet; prove partial/offline states before declaring parity.

Detailed file ownership and execution order are in `tasks.md`; the normative behavior contract is in `delta-spec.md`.

## Validation

Use real temporary SQLite databases, native configuration fixtures and the actual installed CLI; no mocks. Full suites run on a worker. Run three-process concurrent discovery/update tests, kill only owned test processes at each apply-journal boundary, restart and prove consistent recovery. Test incompatible schemas, stale account aliases, missing credentials, local native edits, changed catalogs, two-device publish races, replayed device reports and cross-owner authorization failures.

End-to-end proof: change one concrete model → publish → download on two devices → prove native files and launches still use old revision → dry-run and prove zero writes → apply → inspect all managed fields across multiple account homes → launch one session per harness and record effective model/revision → retry idempotently. Add an offline third device; show pending, reconnect, then verify its queued exact revision. Repeat after a binary upgrade and creation of a new account home. Existing sessions retain their original revision.

Also change the default account from A to B: download-only must still launch A; apply switches to B. Interrupt apply after one native file write, restart the launcher, and prove it refuses mixed settings until rollback or completion is verified. Download updated resource commits and prove active resource projection stays unchanged until apply.

Git proof compares tracked-file hashes and `git status --porcelain` before and after repeated discovery, launches, usage refresh and session mirrors. Baseline dirty user files must remain byte-identical. No worker runtime commits may be produced. Explicit authored resource changes remain ordinary reviewable Git changes.

## Risks

| Source / edge | Handling |
| --- | --- |
| `run-defaults.ts:202` reads desired YAML now | Change the canonical reader before introducing download-only behavior. |
| `account-registry.ts:720` builds a versioned selection target | Preserve imported explicit bindings; default account and identity must survive release changes. |
| `session/sync/net-client.ts:61` unconditional put | Conditional publish must be enforced by the service, not just client-side comparison. |
| `session/mirror.ts:66` produces generated shared rows | Move its transport with other runtime writers or Git churn persists. |
| `state.ts:1334` broad serialization | Dual-read only during migration; single new write owner. Unknown fields preserved. |
| Older fleet binaries still write YAML | Minimum writer protocol gate; upgraded devices stop importing legacy writes after cutover. Older devices remain “upgrade required.” |
| Filesystem interruption and external native writers | Journal and read-back; lock managed launches; detect out-of-band drift without overwriting unrelated native fields. |
| Storage unreachable | Keep last applied configuration usable; preserve drafts and report stale sync honestly. |

Migration is additive: backup and import without renaming native homes or deleting user data. Review conflicting inputs explicitly. Disable old generated writers only after reader migration and device version checks. Tracked generated files are retired through a reviewed repository change; no blanket cleanup of `~/.agents`. Rollback uses retained previous applied snapshots and a coordinated writer policy, not resuming two authorities.

## Tracking

Plan review: [PR #3487](https://github.com/phnx-labs/agi-cli/pull/3487).

[PHNX-3975](https://linear.app/getrush/issue/PHNX-3975): primary configuration proposal. [PHNX-3923](https://linear.app/getrush/issue/PHNX-3923): runtime Git drift. [PHNX-3940](https://linear.app/getrush/issue/PHNX-3940): existing account identity/home work to preserve.

Delivery stage: researched and independently checked proposal. No model was selected or applied by this plan. Implementation and fleet rollout remain unchecked above. Separate prior dry-run repair is [PR #3481](https://github.com/phnx-labs/agents-cli/pull/3481); it is not proof that this configuration design exists.
