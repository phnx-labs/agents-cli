---
kind: plan
title: "High-load warnings in the agents-cli menu bar"
kicker: "agents-cli · MenubarHelper"
subtitle: "Surface device overload where the user already looks — via the fast cache path, not the 136s doctor"
---

# High-load warnings in the agents-cli menu bar

**What + type:** feature — add a "device under high load" warning row to the
MenubarHelper dropdown (local *and* remote), sourced from a native `getloadavg()`
call + the daemon-warmed fleet-stats cache, deliberately bypassing the slow
`agents doctor` path.

## Purpose

Give the operator a glanceable, always-on signal that a device (local or remote) is
overloaded — in the surface they already watch — without adding cost to the menu
bar's poll loop. Turn the existing-but-hidden `headroom()` classification into a
visible warning, and prove the "make it fast" ask by sourcing it from a libc call +
a warm cache instead of the 136s doctor.

## Context

During a live profiling session, `zion` hit **load average 95 on 18 cores** with
nothing in the menu bar warning that a device was overloaded — even though
agents-cli already computes per-device load and classifies it (`headroom()` →
`loaded` at ≥75%). The signal exists; it just isn't shown. The user also flagged
that "the agent structure can be slow" — that is the ~136s `agents doctor`, the
wrong thing to hang a load warning off. Two Explore passes confirmed the menu bar
reads **no** device load today and that `doctor` carries none.

<aside class="artifact-callout">
The load warning reads <code>getloadavg()</code> (a libc call) plus one already-warm
cache file on the badge tick — it never touches the 136-second <code>agents doctor</code>.
That is both the feature and the "make it fast" answer.
</aside>

## Proposed Changes

Local load is a libc call; remote load comes from the daemon-warmed cache; the slow
doctor is never on the path:

<figure>
<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Load-warning data flow">
  <defs>
    <marker id="arw" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#58a6ff"/>
    </marker>
  </defs>
  <rect x="0" y="0" width="760" height="300" fill="#0d1117"/>
  <rect x="24" y="40" width="200" height="70" rx="8" fill="#161b22" stroke="#22c55e"/>
  <text x="124" y="70" fill="#e6edf3" font-family="monospace" font-size="13" text-anchor="middle">LOCAL machine (zion)</text>
  <text x="124" y="92" fill="#8b949e" font-family="monospace" font-size="11" text-anchor="middle">getloadavg() · libc</text>
  <rect x="24" y="150" width="200" height="70" rx="8" fill="#161b22" stroke="#58a6ff"/>
  <text x="124" y="180" fill="#e6edf3" font-family="monospace" font-size="13" text-anchor="middle">REMOTE devices</text>
  <text x="124" y="202" fill="#8b949e" font-family="monospace" font-size="11" text-anchor="middle">.fleet-stats.json (fresh)</text>
  <rect x="300" y="95" width="180" height="70" rx="8" fill="#161b22" stroke="#d4a72c"/>
  <text x="390" y="125" fill="#e6edf3" font-family="monospace" font-size="13" text-anchor="middle">headroom()</text>
  <text x="390" y="147" fill="#8b949e" font-family="monospace" font-size="11" text-anchor="middle">≥75% = loaded</text>
  <rect x="556" y="95" width="180" height="70" rx="8" fill="#161b22" stroke="#ef4444"/>
  <text x="646" y="120" fill="#e6edf3" font-family="monospace" font-size="12" text-anchor="middle">NEEDS YOU row</text>
  <text x="646" y="140" fill="#d4a72c" font-family="monospace" font-size="11" text-anchor="middle">⚠ zion — 530%</text>
  <path d="M224,75 L300,110" stroke="#58a6ff" stroke-width="2" fill="none" marker-end="url(#arw)"/>
  <path d="M224,185 L300,150" stroke="#58a6ff" stroke-width="2" fill="none" marker-end="url(#arw)"/>
  <path d="M480,130 L556,130" stroke="#58a6ff" stroke-width="2" fill="none" marker-end="url(#arw)"/>
  <rect x="300" y="220" width="436" height="46" rx="8" fill="#161b22" stroke="#484f58" stroke-dasharray="5 4"/>
  <text x="518" y="248" fill="#6e7681" font-family="monospace" font-size="12" text-anchor="middle">agents doctor (~136s) — BYPASSED, not on this path</text>
</svg>
<figcaption>Local = libc call. Remote = warm cache with a freshness guard. Doctor untouched.</figcaption>
</figure>

- **Local machine:** native Swift probe — `getloadavg()` ÷ `hw.ncpu` → load%,
  `host_statistics64` → mem%, classified with `headroom()` thresholds ported to a
  Swift constant (mirrors `devices/health.ts:194-205`). Needed because the live
  `.fleet-stats.json` lists `zion` as `"reachable": false` with no stats.
- **Remote devices:** `LocalState.loadedDevices()` (mirrors `pendingDevices()`)
  reads `~/.agents/.cache/.fleet-stats.json`, keeps rows that are reachable, fresh
  (`fetchedAt` within a window — the current file has 31h-stale rows), and `loaded`.
- **Render:** thread `[LoadedDevice]` into `rebuild()` and append rows inside
  `addNeedsAttention()` (chosen placement: the action-required NEEDS YOU section).

```swift
// StatusItemController.addNeedsAttention() — append after the routine block
for d in loadedDevices {                       // local first, then fresh remote
    let glyph = d.severity == .critical ? "✕" : "⚠"
    let color = d.severity == .critical ? fail : wait
    rows.append((glyph, color, "\(d.name) — high load \(Int(d.loadPercent))%", loadSubmenu(d)))
}
```

## Public Interface

No CLI or config surface changes. Menu-bar-only:

| Surface | Change |
|---|---|
| `MenubarHelper/LocalState.swift` | native load probe; `loadedDevices()` reader + freshness guard; `LoadedDevice` model; ported `headroom` thresholds |
| `MenubarHelper/StatusItemController.swift` | `[LoadedDevice]` into `rebuild()`; rows in `addNeedsAttention()`; header count; emphasize action-required rows |
| `MenubarHelper/Models.swift` | `LoadedDevice` struct (if models live here) |
| new dropdown rows | `⚠ <name> — high load <N>%` in NEEDS YOU (red `✕` when critical) |

## Validation

```bash
# build the menu bar, replace the installed app, then drive it on zion
swift build -c release            # or the repo's menubar build script
open the menu on zion (live load) → confirm the "zion — high load N%" ⚠ row
```

| Check | Pass condition |
|---|---|
| Local warning | `zion — high load N%` ⚠ appears in NEEDS YOU; clears when load drops |
| Remote warning | a fresh `loaded` device (e.g. mac-mini 340%) warns |
| Freshness guard | a 31h-stale cache row does NOT warn |
| Fast path | badge tick spawns no `agents doctor`; menu-open latency unchanged |

## Risks

| Risk | Mitigation |
|---|---|
| Stale cache → false remote warning | freshness guard (ignore rows older than the window) |
| Local `.fleet-stats.json` says `reachable:false` | probe local natively (getloadavg), never trust the cache row for local |
| Threshold noise (bursty load flaps the row) | classify off `headroom()` (≥75%); optionally require the row to persist across 2 ticks |
| Scope creep into the 136s doctor refactor | explicitly out of scope — filed as a separate follow-up ticket, linked from this PR |

## Out of scope (follow-up ticket)

The broader status-flow slowness — `agents doctor` ~136s (probes every installed
version of every harness), per-30s-poll transcript tailing, cross-version Claude
`statSync`, teams `meta.json` scan, `ps -A`+`lsof` fan-out — is a larger refactor,
filed separately and linked from this PR.
