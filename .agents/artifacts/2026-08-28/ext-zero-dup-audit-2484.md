---
kind: report
title: "PHNX-2484 — AGI EXT zero-duplication audit (full-tree)"
summary: "Full-tree audit of phnx-labs/agi-ext: 34 sites where the extension re-implements or re-derives agents-cli logic instead of consuming canonical CLI JSON/verbs, split into delete-now / needs-CLI-addition / in-progress, with a phased deletion order."
links:
  - "https://linear.app/getrush/issue/PHNX-2484"
---

# PHNX-2484 — AGI EXT zero-duplication audit (full-tree)

**Repo audited:** `phnx-labs/agi-ext` @ `main` (`b5d3494`)
**Date:** 2026-08-28
**Scope:** every place the extension *re-implements* or *re-derives* agents-cli logic
instead of consuming canonical CLI JSON/verbs, per the ticket + the agi-ext
`AGENTS.md` "one architecture rule — thin client, single stream".

> The rule: the extension may own **only** VS Code UI, webviews, terminal/tab/focus
> APIs, and presentation formatting. Session lifecycle, resume candidates & ordering,
> session state/history, usage/account health, device health/config, placement/load
> balancing, dispatch, messaging, capability discovery, watchdog, and routines MUST be
> sourced from canonical agents-cli JSON/verbs with **no extension fallback or mirrored
> implementation**.

## Summary

- **34 duplication sites** across **8 CLI concepts** (lifecycle, resume, placement,
  device health/config, usage/account, identity/hydration, transcript/tool parsing,
  panel snapshot).
- Fix split:
  - **DELETE-NOW — 11 sites.** Dead code (probe parsers with zero callers) or the
    canonical CLI field already ships on the stream, so the ext just stops re-deriving.
  - **NEEDS-CLI-ADDITION — 14 sites.** The real fix is a CLI field/verb (one-row-per-session
    on the stream, a `resume --candidates` verb, `devices config --json`, identity on the
    stream). The ext code deletes *after* the CLI grows the surface. This is the thesis:
    "if a field is missing, add it to the CLI, don't side-channel it here."
  - **IN-PROGRESS — 5 sites.** PHNX-2975 is already deleting the client-side
    attention/stall classifier (`derivePhase` / `deriveStalled` / `deriveNeeds` /
    `PHASE_RANK` + `readinessDetector.ts`). Listed for completeness, **not** to be
    double-counted.
  - **4 residual presentation/borderline sites** kept as legitimately ext-owned display
    formatting (called out so the deletion pass does not over-reach).
- **6 explicit FALLBACK paths** (thesis forbids "if CLI unavailable, compute locally"):
  the floorModel question heuristics behind `question === null`, the
  `normalizeActiveSession` "fall back to parsing lastResponse" contract, and the
  corruption-to-defaults degrades in `deviceAutoLaunch.ts` and `agentInventory.ts`.
- **Already compliant (no action):** `watchdog.vscode.ts` (pure CLI-daemon delegation +
  one-time settings migration — the reference pattern), `resumeInBest.ts` command
  builders (delegate host/harness/account picking to `agents run auto`, RUSH-2132),
  `sessionPresentationStore.ts` (pure projection of the stream).

The single largest violation is concentrated in three files —
`ui/settings/components/mission-control/floorModel.ts`, `src/core/remoteSessions.ts`,
and the raw-config readers (`src/core/deviceAutoLaunch.ts`, `src/core/agentInventory.ts`).
Fix those and roughly two-thirds of the surface collapses.

---

## Findings

Legend — **Fix**: `DELETE-NOW` · `NEEDS-CLI` · `IN-PROGRESS` (PHNX-2975) · `KEEP` (legit presentation).
**Risk**: how entangled the deletion is (callers / blast radius).

### A. Session lifecycle / phase classification

| # | file:line — symbol | Duplicates | Canonical CLI source | Fix | Risk |
|---|---|---|---|---|---|
| 1 | `floorModel.ts:632` `derivePhase` | lifecycle classifier (status+active+waiting+prUnreviewed → FloorPhase) | `ActiveSession.activity`/`status` on `sessions watch --json` | IN-PROGRESS | high — wired at `floorAdapter.ts:485` |
| 2 | `floorModel.ts:659` `deriveNeeds` | attention classification (needs-you) | CLI attention rows / `activity==='waiting_input'` | IN-PROGRESS | high |
| 3 | `floorModel.ts:674` `deriveStalled` + `:497` `STALL_THRESHOLD_MS` | watchdog/stall classifier (90s threshold) | CLI daemon watchdog stall signal (missing on stream) | IN-PROGRESS | med |
| 4 | `floorModel.ts:487` `PHASE_RANK` | attention/progress ordering | CLI feed ordering (`deriveOutcome`/attention rank) | IN-PROGRESS | high — used by `sortAgents` |
| 5 | `floorModel.ts:682` `heartbeatLevel` | stall severity (live/stale/dead from silence age) | same daemon stall signal as #3 | NEEDS-CLI | med — same seam as #3, not in the 2975 list |
| 6 | `remoteSessions.ts:522` `mapStatusToPhase` | lifecycle classifier (CLI status word → phase) | CLI should project canonical `phase` once | NEEDS-CLI | high — feeds every normalized row |
| 7 | `remoteSessions.ts:799` `dedupeSessions` + `:778` `DEDUPE_PHASE_RANK` | session identity dedup (many pids → one session) + attention pick | `sessions.db`/pid→session registry — emit one row per session | NEEDS-CLI | high — header counts vs feed depend on it |
| 8 | `remoteSessions.ts:841` `isStaleSession` + `:855` `filterStaleSessions` + `:831` `sessionLastActivityMs` + `:821` `STALE_SESSION_THRESHOLD_MS` | liveness/staleness decision (6h threshold) | CLI should not emit (or should flag) stale sessions | NEEDS-CLI | high — gates counts + needs-you fleet-wide |
| 9 | `foreman.digest.ts:103` `deriveStatus` | idle/working/waiting/blocked lifecycle classifier (for the voice digest) | consume CLI `phase`/`activity` instead of re-deriving from `startedAtMs`+last-tool | NEEDS-CLI | low — foreman-only |

### B. Resume candidates & ordering

| # | file:line — symbol | Duplicates | Canonical CLI source | Fix | Risk |
|---|---|---|---|---|---|
| 10 | `resumePicker.ts:122` `classifyResumeState` + `:33` `STATE_RANK` | resume-state classifier (detached/background/parked/idle/watched) + ordering | **missing** — no `resume --candidates` verb; ext joins two reads by hand | NEEDS-CLI | med |
| 11 | `resumePicker.ts:171` `buildResumeCandidates` + `:231` `sortResumeCandidates` + `:247` `abandonedCandidates` + `:103` `indexLive` | resume candidate selection/join/ordering | **missing CLI verb** — `agents sessions resume --candidates --json` | NEEDS-CLI | med — self-contained module |
| 12 | `resumePicker.ts:303` `sharedTopicPrefixes` + `:342` `stripSharedPrefix` + `:371` `distinctiveTopic` | boilerplate-prefix stripping for the picker label | — (display formatting) | KEEP | — |

### C. Placement / load-balancing / dispatch (placement already delegated — PHNX-2092)

| # | file:line — symbol | Duplicates | Canonical CLI source | Fix | Risk |
|---|---|---|---|---|---|
| 13 | `dispatchRanking.ts:107` `deriveHostLoad` | placement/load-bucket classifier (thresholds) | `agents run auto` placement (PHNX-2092) | DELETE-NOW | **none — zero callers (dead)** |
| 14 | `dispatchRanking.ts:123` `parseRemoteCpuRatio` | SSH `uptime` CPU-ratio parse (device probe) | `agents devices status --json` | DELETE-NOW | **none — zero callers (dead)** |
| 15 | `dispatchRanking.ts:150` `buildDispatchHosts` + `:184` `rankTargets` + `:216` `buildManagedTargets` + `:243` `rankHostUses` | dispatch target/host ranking (placement) | CLI placement / `run auto` target resolution | NEEDS-CLI | med — Dispatch panel |
| 16 | `dispatchRanking.ts:74` `mapInventoriesToInstalledAgents` (+ `:56` `AGENT_META`) | capability discovery rollup (installed/signedIn/default) | `agents view --json` (already the input) — CLI should expose the "installed & runnable" set | NEEDS-CLI | low — `AGENT_META` colors are legit KEEP |

### D. Device health / config

| # | file:line — symbol | Duplicates | Canonical CLI source | Fix | Risk |
|---|---|---|---|---|---|
| 17 | `deviceHealth.ts:10` `parseUptime` + `:18` `parseVmStat` + `:35` `parseLinuxMemInfo` | device-health metric parsers (raw probe output) | `agents devices status --json` (already consumed in `deviceHealth.vscode.ts`) | DELETE-NOW | **none — zero callers (dead), superseded** |
| 18 | `deviceHealth.ts:60` `isDeviceOnline` | reachability classifier, hand-mirror of CLI `ssh.ts renderDeviceTable` | CLI should emit `online` as a field | NEEDS-CLI | med — called in `deviceHealth.vscode.ts` |
| 19 | `deviceAutoLaunch.ts` **(whole file)** — `loadAutoLaunchPreferences`, `readDeviceMaxConcurrent`, `readFleetDefaultsConfig`, `readDeviceDocConfig`, `readAllDeviceConfigs` | **raw `~/.agents/**/agents.yaml` config reader** (forbidden by AGENTS.md rule 3) + corruption→defaults fallback | `agents devices config <name> --json` (+ fleet defaults) — verb likely missing | NEEDS-CLI | med — launch-ranking path |

### E. Usage / account health

| # | file:line — symbol | Duplicates | Canonical CLI source | Fix | Risk |
|---|---|---|---|---|---|
| 20 | `agentInventory.ts:116` `loadAgentsConfig` + `:127` `readAgentRunStrategy` + `:134` `writeAgentRunStrategy` (+ `:55`/`:66` helpers) | **raw `~/.agents/agents.yaml` reader AND writer** (forbidden) — run-strategy config | CLI run-config verb (read + write `run.<agent>.strategy`) | NEEDS-CLI | med — roster toggles write yaml directly |
| 21 | `agentInventory.ts:84` `summarizeAgentInventory` (`healthyCount`/`canRotate`/`signedInCount`) | account-health rollup duplicating the CLI rotate engine | `agents view --json` (input) — CLI should expose the rollup | NEEDS-CLI | low — consumes canonical JSON |
| 22 | `resumeInBest.ts:26` `sessionUsedPercent` | per-window usage extraction | `agents view --json` window field (passthrough) | KEEP | low — trivial field read |

### F. Session identity / label hydration (RUSH-3184 debt)

| # | file:line — symbol | Duplicates | Canonical CLI source | Fix | Risk |
|---|---|---|---|---|---|
| 23 | `remoteSessions.vscode.ts:228` `fetchSessionIdentity` + `extension.ts:4068` `tryHydrateSessionIdentity` (calls `:4163`, `:4308`) | per-tab `agents sessions <id> --json` spawn loop to get version/account | `account`/`version` on the `SessionWatchRow` stream (RUSH-3184) | NEEDS-CLI (in flight) | med — flagged debt |
| 24 | `remoteSessions.vscode.ts:199` `fetchRemoteSessionLabelSource` + `remoteSessions.ts:954` `parseSessionLabelSource` + `:980` `topicFromUserEvents` + `:1055` `isDerivedSessionName` | per-tab spawn + event parse to get label/topic | `label`/`topic` **already on the stream** | DELETE-NOW | med — AGENTS.md says "DELETE now" |
| 25 | `remoteSessions.ts:1016` `parseSessionIdentity` + `:995` `SessionIdentity` | parse version/account/agent from session JSON | same stream fields as #23 | NEEDS-CLI (in flight) | low — parser feeding #23 |
| 26 | `floorModel.ts:617` `sessionKey` | canonical session-identity derivation across origins | CLI canonical session id on every origin row | NEEDS-CLI | med — keying across surfaces |

### G. Transcript / tool-call parsing (forbidden)

| # | file:line — symbol | Duplicates | Canonical CLI source | Fix | Risk |
|---|---|---|---|---|---|
| 27 | `floorModel.ts:703` `latestTodos` (+ `:688` `ToolCallLike`) | parses raw `TodoWrite` tool calls into a checklist | `ActiveSession.todos` already on stream (RUSH-1380/1503; `todoProgressFromCli` already consumes it) | DELETE-NOW | med — wired at `floorAdapter.ts:43` |
| 28 | `floorModel.ts:738` `parseStructuredQuestion` + `:769` `structuredQuestionFromToolCalls` + `:848` `extractChoiceOptions` (+ helpers) | regex/tool-call **question extraction** — the FALLBACK when the CLI question is absent | `ActiveSession.question` (already consumed by `structuredQuestionFromRemote`) | DELETE-NOW | med — remove the fallback branch |
| 29 | `session.activity.ts` `parseLineForActivity`/`formatActivity` | per-line JSONL transcript parser for the panel activity feed | CLI `recentEvents`/`preview` on stream (whole-transcript derivations already deleted, #741/RUSH-1503) | NEEDS-CLI | med — panel feed |
| 30 | `monitor/sessionParse.ts` — head-metadata transcript parser (`forkedFromId`/`codexCwd`/`geminiSessionId`/opencode) | raw `~/.claude/projects` + rollout transcript parsing | CLI-provided fields (AGENTS.md debt) | NEEDS-CLI | high — feeds correlation |
| 31 | `monitor/readinessDetector.ts` + `monitor/probes.ts` (`ps`/`pgrep`) + `terminalReadiness.ts` recursive `fs.watch` | ext-invented lifecycle/readiness classifier + transcript watcher | daemon readiness signal on stream | IN-PROGRESS (readinessDetector) / NEEDS-CLI (watcher) | high — leader/follower path |

### H. Panel snapshot

| # | file:line — symbol | Duplicates | Canonical CLI source | Fix | Risk |
|---|---|---|---|---|---|
| 32 | `agentPanel.vscode.ts:351`/`:395` `buildSnapshot` (4s poll) | re-parses transcripts + spawns `agents sessions --include tools` per tick | bind to stream fields; `toolCallCount` on stream (AGENTS.md debt) | NEEDS-CLI | med — one panel |

### Borderline / lower-priority

| # | file:line — symbol | Note |
|---|---|---|
| 33 | `floorModel.ts:894` `outcomeLabel` | mirrors CLI `deriveOutcome`; grouping key. KEEP as presentation *iff* it stays byte-identical to the CLI, else fold to a CLI-provided `outcome` field. |
| 34 | `peerMessaging.ts:26` `resolvePeerMessage` | `send_to_agent` MCP recipient resolution over the ext's own terminal registry. Borderline "messaging" — plausibly ext-owned (routes to a local tab), but revisit if the CLI grows session→session messaging. |

---

## Fallback paths (thesis forbids "compute locally if CLI unavailable")

1. `floorModel.ts:738` question heuristics — the documented fallback for `question === null`
   (see `remoteSessions.ts:189-191` "the UI then falls back to parsing lastResponse").
2. `remoteSessions.ts:459-461` `normalizeQuestion` returns null → "webview falls back to
   parsing lastResponse" — the same fallback contract, stated at the boundary.
3. `deviceAutoLaunch.ts:35-43` — corruption of a device/fleet config degrades to
   "every device enabled, uncapped" defaults.
4. `agentInventory.ts:116-125` `loadAgentsConfig` `catch → {}` — a bad `agents.yaml`
   silently reads as "no config".
5. `remoteSessions.vscode.ts:173-178` `fetchRecentForHost` — an older CLI's non-JSON
   banner is swallowed to an empty list (degrade rather than fail-loud upgrade error).
6. `dispatchRanking.ts:107` `deriveHostLoad(cpuRatio=null)` — derives load from agent
   count alone when the probe fails (dead code, but the pattern).

---

## Recommended deletion order (safest first, grouped by concept)

**Phase 0 — dead code, zero risk (do immediately).** No callers; already superseded by
CLI JSON. Pure subtractions.
- #13 `deriveHostLoad`, #14 `parseRemoteCpuRatio` (`dispatchRanking.ts`)
- #17 `parseUptime`/`parseVmStat`/`parseLinuxMemInfo` (`deviceHealth.ts`)

**Phase 1 — delete-now, CLI field already ships.** Stop re-deriving; consume the stream.
- #24 `fetchRemoteSessionLabelSource` + label parsers (label/topic already on stream)
- #27 `latestTodos` (consume `ActiveSession.todos`; `todoProgressFromCli` is the pattern)
- #28 question heuristics — remove the fallback, rely on `ActiveSession.question`
- #6 `mapStatusToPhase` — once the ext reads a CLI-projected `phase`

**Phase 2 — let PHNX-2975 land, then extend it.** #1–#4 are in flight; fold in #5
`heartbeatLevel` and #4's `sortAgents` consumers so the whole floorModel classifier block
goes together rather than leaving an orphan half.

**Phase 3 — raw-config readers (need a CLI verb first).** Highest architectural value; each
removes a filesystem-coupling + a fallback band-aid.
- #19 `deviceAutoLaunch.ts` → `agents devices config <name> --json`
- #20 `agentInventory.ts` run-strategy read/write → CLI run-config verb
- #21 `summarizeAgentInventory` rollup → CLI-exposed rollup

**Phase 4 — needs a new CLI verb (resume candidates).**
- #10, #11 `resumePicker.ts` → `agents sessions resume --candidates --json`

**Phase 5 — stream-projection additions (identity, staleness, dedup, readiness).** Highest
blast radius; land the CLI field, then delete.
- #23/#25/#26 identity on stream (RUSH-3184 in flight)
- #7 dedup + #8 staleness → one-row-per-session, not-stale, on the stream
- #29/#30/#31/#32 activity/readiness/tool-count → daemon signals on the stream

---

## Top 3 highest-value deletions

1. **The `floorModel.ts` client-side classifier + parser block** — `derivePhase`,
   `deriveNeeds`, `deriveStalled`/`STALL_THRESHOLD_MS`, `PHASE_RANK`, `heartbeatLevel`,
   plus `parseStructuredQuestion`/`structuredQuestionFromToolCalls` and `latestTodos`.
   This is the heart of the thesis violation: the webview re-decides lifecycle, attention,
   stall, question, and checklist. PHNX-2975 already removes the first four; the CLI
   **already ships** `question` and `todos` on the stream, so the parsers and
   `heartbeatLevel` are a straightforward same-epic extension, not new CLI work.

2. **The `remoteSessions.ts` lifecycle cluster** — `mapStatusToPhase` + `dedupeSessions`
   + `isStaleSession`/`filterStaleSessions`. The ext independently decides which sessions
   are alive, which are the same session, and which are too old to show — logic that
   `sessions.db` and the pid→session registry own. It drives fleet-wide counts and the
   needs-you set, so correctness (and the "count vs list diverge" bug the dedup exists to
   paper over) belongs at the source. Fix = CLI emits canonical `phase`, one row per
   session, and drops/flags stale rows; then delete ~120 lines.

3. **The raw agents-config readers/writers** — `deviceAutoLaunch.ts` (whole file) and
   `agentInventory.ts` `loadAgentsConfig`/`readAgentRunStrategy`/`writeAgentRunStrategy`.
   These read **and write** `~/.agents/agents.yaml` and per-device docs directly — exactly
   the "raw agents-config reader" AGENTS.md rule 3 forbids — with corruption-to-defaults
   fallbacks. The ext writing config the CLI is supposed to own is the sharpest ownership
   inversion in the tree. Fix = `agents devices config --json` + a run-config verb; the
   deletion removes both the filesystem coupling and two fallback band-aids.

---

## Evidence

Method: full read of `phnx-labs/agi-ext` @ `main` (`b5d3494`) — `AGENTS.md` + `docs/`
(the thin-client thesis, `session-projection.md`), then a tree sweep for the tell-tales
(`derive*`, `classify*`, `THRESHOLD`/`_MS`, `ps`/`pgrep`, `readiness`, raw `agents.yaml`
reads, local ranking/sort). Every row is grounded in a read of the cited file at the
cited line; classification against the canonical CLI surface uses the field names the CLI
already emits on `agents sessions watch --json` (`activity`, `status`, `question`,
`todos`, `pidAlive`, `viewingIn`, `machine`, `preview`, `tokPerSec`) as documented in the
`RawActiveSession` shape in `src/core/remoteSessions.ts:315-407`.

Key grounding points:

- **Dead code confirmed by caller search** (`grep` for each symbol across `src/` + `ui/`,
  excluding definitions/tests): `deriveHostLoad`, `parseRemoteCpuRatio`
  (`dispatchRanking.ts`) and `parseUptime`/`parseVmStat`/`parseLinuxMemInfo`
  (`deviceHealth.ts`) have **zero** non-test callers — device health now flows through
  `agents devices status --json` in `deviceHealth.vscode.ts:139,166,194`.
- **CLI field already ships** for the delete-now parsers: `ActiveSession.question` is
  consumed at `floorModel.ts:818` (`structuredQuestionFromRemote`) yet the heuristic
  `parseStructuredQuestion`/`structuredQuestionFromToolCalls` remain as the
  `question === null` fallback (`remoteSessions.ts:189-191`); `ActiveSession.todos` is
  consumed at `session.activity.ts:62` (`todoProgressFromCli`) yet `latestTodos`
  re-parses raw `TodoWrite` calls (wired at `floorAdapter.ts:43`).
- **Raw-config reader/writer** confirmed by direct `fs.readFileSync`/`fs.writeFileSync`
  of `~/.agents/agents.yaml` and `devices/<name>/agents.yaml` in `agentInventory.ts:116-143`
  and `deviceAutoLaunch.ts:46-101` — the "raw agents-config reader" forbidden by the
  agi-ext `AGENTS.md` architecture rule 3.
- **Already-compliant reference** for the target shape: `watchdog.vscode.ts` holds no
  loop — it shells `agents watchdog enable|disable` and reads the daemon's
  `watchdog.log` (`core/watchdogLog.ts`); `resumeInBest.ts` builds `agents run auto`
  command strings and delegates host/harness/account picking to the CLI (RUSH-2132).
