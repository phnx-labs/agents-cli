---
kind: plan
surface: internal
title: "Monitors: definition vs running state, and one trigger per work item"
summary: >-
  Monitor definitions are gitignored, so every box has a different invisible set
  of watchers. Track the definitions, keep runtime local, and resolve ownership
  first — because syncing definitions without ownership multiplies double-fires
  instead of fixing them.
status: awaiting-go
tracking: "RUSH-2476 (gates visibility) · RUSH-2485 (sibling defect) · agents-cli#2517"
facts:
  - workstation 0 monitors, worker-s0 6, worker-s1 2 — same fleet, same day
  - No enable/disable verb exists; the docs name one that never shipped
  - monitorRunsOnThisDevice returns true for every box when device is unset
  - Syncing definitions is unsafe until ownership is resolved
---

## Focus for review

- **The ordering claim.** Syncing definitions *requires* ownership first. If you
  disagree with that dependency, the whole sequence changes.
- **`device: auto`.** Deterministic election over the device registry — the one
  genuinely new mechanism here.
- **The held branch.** `owner/.agents` already has the gitignore fix pushed.
  It stays unmerged until ownership lands.
- **`pause`/`resume` must move to a per-device list** (step 4). Once definitions
  sync, pausing on one box would otherwise pause on all of them.

## Intent

> "the definition can be checked into the repo but when it's running that
> shouldn't be checked into the repo. And if the same monitor is already running
> with the same exact arguments then if the agent tries to rerun it then he should
> be warned. So we can prevent double-trigger bugs."

Plus, earlier: no `enable`/`disable` verb — a shipped monitor should just show up.

## Purpose

`agents monitors list` on workstation printed **"No monitors configured"** while
`~/.agents/.system/monitors/pr-merge-on-green.yml` sat on that same disk — the
built-in that would have merged PR #2485 without a human.

| Claim | Verified |
|---|---|
| `enable`/`disable` verbs exist | **No** — 12 commands registered, neither among them; docs instruct a command that never shipped |
| Built-ins are visible | **No** — `config.ts:436` forces system scope to `enabled: false` |
| Installed CLI reads the system layer | **No** — `getSystemMonitorsDir` absent from 1.22.35; merged to `main` 01:50 today |
| Definitions are checked in | **No** — `~/.agents/.gitignore` groups `monitors/` with `commands/`, `factory/`, `scripts/`; 0 tracked |
| Running state is checked in | **Correctly no** — `.history/monitors/` already excluded |
| Adding a duplicate warns | **No** — `writeMonitor` overwrites by name, nothing compares arguments |

Result on the fleet: **workstation 0, worker-s0 6, worker-s1 2** — and on one box,
`open-pr-watch`, `pr-ci-fail`, three stale `pr2222-*` watchers and an agent-added
lander all polling the same PR queue.

<div class="artifact-callout">
<strong>Nothing gets removed.</strong> No <code>enable</code>/<code>disable</code>
verb exists to delete. <code>pause</code>/<code>resume</code> already route through
<code>setMonitorEnabled</code> to <code>writeMonitor</code>, which writes the
<em>user dir only</em> — so pausing a built-in materializes a user copy and never
touches the pull-only system mirror (hardened in <code>158d79eb8</code>).
</div>

## Current architecture

The subsystem already separates definition from running state. What it lacks is
ownership — and that is what makes syncing dangerous.

<figure class="artifact-figure">
<svg viewBox="0 0 920 430" role="img" aria-label="Sync without ownership multiplies triggers; with ownership exactly one box fires">
  <rect x="0" y="0" width="920" height="430" fill="#0a0a0a"/>

  <text x="24" y="28" fill="#a3e635" font-family="monospace" font-size="13">DEFINITION (syncs)</text>
  <rect x="24" y="42" width="200" height="46" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="38" y="62" fill="#d6d6d6" font-family="monospace" font-size="12">monitors/&lt;name&gt;.yml</text>
  <text x="38" y="79" fill="#6b6b6b" font-family="monospace" font-size="10">what · when · action</text>

  <text x="256" y="28" fill="#6b6b6b" font-family="monospace" font-size="13">RUNNING STATE (local)</text>
  <rect x="256" y="42" width="220" height="46" rx="6" fill="#111" stroke="#404040" stroke-width="1.5"/>
  <text x="270" y="62" fill="#d6d6d6" font-family="monospace" font-size="11">.history/monitors/&lt;n&gt;/</text>
  <text x="270" y="79" fill="#6b6b6b" font-family="monospace" font-size="10">last-seen · fires · rate limit</text>

  <line x1="24" y1="108" x2="896" y2="108" stroke="#262626" stroke-width="1"/>

  <text x="24" y="136" fill="#f87171" font-family="monospace" font-size="13">SYNC WITHOUT OWNERSHIP — the trap</text>
  <rect x="24" y="150" width="150" height="40" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="38" y="175" fill="#d6d6d6" font-family="monospace" font-size="11">definition syncs</text>

  <line x1="174" y1="170" x2="250" y2="170" stroke="#a3e635" stroke-width="1.5"/>
  <text x="256" y="166" fill="#6b6b6b" font-family="monospace" font-size="10">device: unset</text>
  <text x="256" y="180" fill="#6b6b6b" font-family="monospace" font-size="10">config.ts:200 -&gt; true</text>

  <rect x="410" y="146" width="140" height="48" rx="6" fill="#111" stroke="#f87171" stroke-width="1.5"/>
  <text x="424" y="166" fill="#d6d6d6" font-family="monospace" font-size="11">workstation daemon</text>
  <text x="424" y="184" fill="#f87171" font-family="monospace" font-size="10">fires</text>

  <rect x="566" y="146" width="150" height="48" rx="6" fill="#111" stroke="#f87171" stroke-width="1.5"/>
  <text x="580" y="166" fill="#d6d6d6" font-family="monospace" font-size="11">worker-s0</text>
  <text x="580" y="184" fill="#f87171" font-family="monospace" font-size="10">fires</text>

  <rect x="732" y="146" width="140" height="48" rx="6" fill="#111" stroke="#f87171" stroke-width="1.5"/>
  <text x="746" y="166" fill="#d6d6d6" font-family="monospace" font-size="11">release-host</text>
  <text x="746" y="184" fill="#f87171" font-family="monospace" font-size="10">fires</text>

  <circle cx="890" cy="170" r="6" fill="#f87171"><animate attributeName="opacity" values="1;0.2;1" dur="1.5s" repeatCount="indefinite"/></circle>

  <text x="24" y="248" fill="#a3e635" font-family="monospace" font-size="13">SYNC AFTER OWNERSHIP — the plan</text>
  <rect x="24" y="262" width="150" height="40" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="38" y="287" fill="#d6d6d6" font-family="monospace" font-size="11">definition syncs</text>

  <line x1="174" y1="282" x2="250" y2="282" stroke="#a3e635" stroke-width="1.5"/>
  <text x="256" y="278" fill="#6b6b6b" font-family="monospace" font-size="10">device: auto</text>
  <text x="256" y="292" fill="#6b6b6b" font-family="monospace" font-size="10">elect over registry</text>

  <rect x="410" y="258" width="140" height="48" rx="6" fill="#111" stroke="#404040" stroke-width="1.5"/>
  <text x="424" y="278" fill="#6b6b6b" font-family="monospace" font-size="11">workstation daemon</text>
  <text x="424" y="296" fill="#6b6b6b" font-family="monospace" font-size="10">inert</text>

  <rect x="566" y="258" width="150" height="48" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="2"/>
  <text x="580" y="278" fill="#d6d6d6" font-family="monospace" font-size="11">worker-s0</text>
  <text x="580" y="296" fill="#a3e635" font-family="monospace" font-size="10">OWNER — fires once</text>

  <rect x="732" y="258" width="140" height="48" rx="6" fill="#111" stroke="#404040" stroke-width="1.5"/>
  <text x="746" y="278" fill="#6b6b6b" font-family="monospace" font-size="11">release-host</text>
  <text x="746" y="296" fill="#6b6b6b" font-family="monospace" font-size="10">inert</text>

  <line x1="24" y1="340" x2="896" y2="340" stroke="#262626" stroke-width="1"/>
  <text x="24" y="364" fill="#6b6b6b" font-family="monospace" font-size="11">Legend:</text>
  <rect x="86" y="354" width="12" height="12" fill="#111" stroke="#f87171"/>
  <text x="104" y="364" fill="#6b6b6b" font-family="monospace" font-size="11">duplicate fire</text>
  <rect x="212" y="354" width="12" height="12" fill="#0f160a" stroke="#a3e635"/>
  <text x="230" y="364" fill="#6b6b6b" font-family="monospace" font-size="11">single owner</text>
  <text x="24" y="392" fill="#6b6b6b" font-family="monospace" font-size="11">Election reads the device REGISTRY, never liveness — online-ness differs per box, so any</text>
  <text x="24" y="408" fill="#6b6b6b" font-family="monospace" font-size="11">liveness input would make daemons disagree and reintroduce the race.</text>
</svg>
<figcaption>Ownership is a prerequisite of syncing, not a companion to it.</figcaption>
</figure>

## Proposed Changes

### Behavior

<div class="artifact-grid">
<div class="artifact-panel">
<strong>Current — captured on workstation</strong>
<pre><code>$ agents monitors list
No monitors configured

$ agents monitors add dup --poll '&lt;same cmd&gt;' 2m --notify
Monitor 'dup' added        # silently, beside 3 identical watchers</code></pre>
</div>
<div class="artifact-panel">
<strong>Proposed — mockup</strong>
<pre><code>$ agents monitors list
  pr-merge-on-green  on  (built-in)  owner: worker-s0

$ agents monitors add dup --poll '&lt;same cmd&gt;' 2m --notify
Monitor 'open-pr-watch' already watches this exact source
and fires the same action.  (--force to add anyway)</code></pre>
</div>
</div>

### 1. Ownership — `device: auto` (prerequisite)

```diff
   const self = machineId();
+  // Registry, not liveness: online-ness differs per box, so any liveness input
+  // makes daemons disagree and reintroduces the race.
+  if (config.device === 'auto') return electAutoOwner() === self;
   if (config.device) return normalizeHost(config.device) === self;
```

Routines' `claimRunSlot` (`routines.ts:1807-1827`, `mkdir` EEXIST) is a **local**
claim — it stops double-fire within one box, not across the fleet — so it is the
wrong tool. Deterministic election is.

### 2. Built-ins default to enabled — `config.ts:436`

```diff
-      enabled: hasEnabled ? parsed.enabled !== false : scope === 'system' ? false : (MONITOR_DEFAULTS.enabled ?? true),
+      enabled: hasEnabled ? parsed.enabled !== false : (MONITOR_DEFAULTS.enabled ?? true),
```

Matches the house pattern: `builtin-routines.ts:93,95` sets `enabled: true`, and
`routines.ts:807-810` says a built-in "fires for every install unless the user
overrides or disables it by name". Also tag `(built-in)` in `list`/`--json`,
mirroring `routines.ts:387,532`.

### 3. Land the add-time duplicate guard (#2517 — written, needs rebase)

Fingerprint over source + condition + action; excludes name, description,
`enabled`, and placement — hashing placement would let the same watcher be re-added
by varying only the owner.

### 4. Per-device activation — `deviceMonitors` (second prerequisite)

Verified against the sync path, and it turns my earlier open question into a
required step: **`pause`/`resume` become fleet-wide the moment definitions sync.**
`setMonitorEnabled` (`config.ts:540-543`) mutates `enabled:` in the monitor's own
yml — local today, shared once synced. So `agents monitors pause X` on workstation would
pause X on every box, and every box would write the same file.

Routines keep activation *out* of the definition, precisely for this:

```text
state.ts:830-834  devices/<machine>/agents.yaml — "each machine only ever writes
                  its OWN folder, so pulls never conflict"
state.ts:917-923  META_KEY_SCOPE marks deviceRoutines 'device' — never central
```

Mirror it: add `deviceMonitors` as `'device'` scope and point `pause`/`resume` at
that list. `enabled:` in the definition stays the fleet-wide switch; the device
list answers "does THIS box run it". No new verb; reuses `routine-activation.ts`.

### 5. Sync definitions — only after 1, 2 and 4

Drop `monitors/` from the machine-specific group in `~/.agents/.gitignore`.
Runtime stays excluded by the existing `.history/*` rule. Also add `monitors` to
`RESOURCE_DIRS` (`repo.ts:122-125`), which omits it — so `repo push`/`pull` would
report monitor changes as generic `other` rather than "N new monitors".

Sync is **manual** (`commitAndPush`/`pullRepo` are user-invoked; no daemon
auto-syncs), which lowers blast radius. But a pull **SIGHUPs the daemon**
(`repo.ts:1204-1215`) and `daemon.ts:1136-1140` reloads the monitor engine — so a
synced unpinned monitor starts firing on the pulling box immediately. That is the
confirmed mechanism behind the ordering rule.

### 6. Companion — `.agents-system`

`pr-merge-on-green.yml`: add `device: auto`, delete the "Opt-in built-in … until
`agents monitors enable`" comment, rewrite the README section naming that verb.

## Public Interface

| Surface | Change |
|---|---|
| `agents monitors list` | Built-ins appear, on, tagged `(built-in)`, with owner |
| `agents monitors add` | Refuses name and behavior collisions; `--force` overrides |
| `device:` | Accepts symbolic `auto` |
| `enable` / `disable` | **Not added** — `pause`/`resume` remain |

## Plan

- [ ] `device: auto` election + owner shown in `list`/`view`
- [ ] Flip `config.ts:436`; tag built-ins; fix the two stale docblocks
- [ ] Rebase #2517 onto `main` (doc renamed `10-monitors.md` → `monitors.md`)
- [ ] `deviceMonitors` per-device activation; repoint `pause`/`resume`
- [ ] Un-ignore `monitors/` in `~/.agents` + add `monitors` to `RESOURCE_DIRS`; open the held PR
- [ ] `.agents-system` companion PR, linked

## Validation

```bash
npx vitest run src/lib/monitors src/commands/monitors.test.ts
agents monitors list                      # on, (built-in), owner
agents monitors add dup --poll '<same>' 2m --notify   # refused
agents monitors pause pr-merge-on-green   # writes a USER copy only
```

The assertion that would have caught the original race: open a throwaway PR, get a
non-author approval, let CI go green, then check
`~/.agents/.history/monitors/pr-merge-on-green/fires/` on **every** box — exactly
one may have fired.

## Risks

| Risk | Mitigation |
|---|---|
| Syncing multiplies triggers | Strict order: ownership before sync; the `.agents` branch is held |
| Default flip turns on a merge bot fleet-wide | Ships together with ownership, never alone |
| Elected owner offline → monitor down | Already the accepted tradeoff for an explicit pin |
| Daemons disagree on the owner | Election reads the registry, never liveness; test asserts one owner across machine ids |

## Tracking

- **agents-cli#2517** — duplicate guard, open, CONFLICTING (needs rebase).
- **owner/.agents** `monitors-track-definitions` — pushed, PR held until ownership lands.
- **RUSH-2476** — release train disabled; gates all visibility.
- **RUSH-2485** — monitor reported healthy, never polled; teammate active.

## Resolved while planning

I had this as a maybe-follow-up. Reading the sync path settled it as a
**prerequisite** — see step 4 — because `pause`/`resume` would silently become
fleet-wide operations on a shared file.

Still open and deliberately out of scope: whether a hand-pinned `device: <name>`
should also move to the per-device list. `auto` makes the common case moot, and an
explicit pin is a deliberate fleet-wide statement. Revisit if churn appears.
