---
kind: plan
template: plan.v1
surface: cli
title: One event engine — events is truth; audit and logs are aliases
summary: >
  Collapse agents events, agents logs, and agents audit onto a single EventRecord
  store and a single read/write engine. audit and logs become thin wrappers with
  fixed filters. Sessions-style --include/--exclude filters the one stream.
  Bare events stays full; teach --exclude commands for noise.
status: awaiting-go
tracking: "events/logs/audit consolidation"
project: agents-cli
repository: phnx-labs/agents-cli
branch: main
host: yosemite-s0
date: '2026-08-10'
facts:
  - "Decision: one source of truth, one engine"
  - "Decision: audit and logs are aliases only — no separate implementations"
  - "Decision: bare events stays full stream; teach --exclude commands"
  - "Today: logs audit already calls runEventsCommand; audit list is a separate store"
  - "Today: agent.run.end already exists as EventType; hash-chain audit is a parallel product"
---

# One event engine: `events` is truth; `audit` and `logs` are aliases

## Focus for review

1. **Single store + single engine** — ops, activity, and former run-dispatch audit rows all become `EventRecord`s through one `emit` / `query` / `readUnifiedEvents` path.
2. **`audit` and `logs` are wrappers only** — fixed flag presets over `agents events`, zero independent logic.
3. **Hash chain** — fold onto run events in the same engine (`events verify`) **or** drop verify as a product. No second file under `.history/audit/`.
4. **`logs [id]` content path** — transcripts/host stdout leave this product; they stay on `sessions` / `hosts logs`.
5. **Default noise** — bare `events` stays full; `--exclude commands` is the taught path.

## Intent

You looked at `agents audit list` and `agents events` and saw three similar commands with three implementations. Your direction:

- One source of truth for logs, events, and audit.
- One engine for read and write.
- `audit` is a bare-bones alias/wrapper over `events`.
- Same for `logs`.
- Track broadly by default; filter with sessions-style `--include` / `--exclude`.

This plan follows that. Earlier drafts that kept three stores are rejected.

## Current vs proposed (what you type)

<section class="artifact-grid artifact-grid-2">
<article class="artifact-panel" data-state="current" data-evidence="capture">
<figcaption><strong>Current:</strong> three nouns, two stores, wall of command noise, wrong verb fails.</figcaption>

```text
$ agents events
2026-08-10 … command.end  sessions
2026-08-10 … command.end  sessions
… (×40) …

$ agents audit list
3055  2026-08-08 … plan fail exit=1  /

$ agents logs audit
# ops-only events — same reader as events --audit
# but lives under a different parent command

$ agents events list
error: too many arguments for 'events'
```
</article>

<article class="artifact-panel" data-state="proposed" data-evidence="mockup">
<figcaption><strong>Proposed:</strong> one engine; three nouns are the same command with defaults; filters kill noise.</figcaption>

```text
$ agents events --exclude commands --limit 5
2026-08-10 … secrets.get   bundle=share
2026-08-10 … pr.opened     https://github.com/…

$ agents audit
# ≡ agents events --include runs
3055  2026-08-08 … agent.run.end  plan fail exit=1

$ agents logs
# ≡ agents events

$ agents events stats
$ agents events rotate --days 7
$ agents sessions a1b2c3d4   # transcript content (not events)
```
</article>
</section>

## Architecture: before → after

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg class="artifact-diagram" viewBox="0 0 1080 420" role="img" aria-labelledby="ev-title ev-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="ev-title">Before three stores; after one EventRecord engine</title>
  <desc id="ev-desc">Left side shows three write paths and three CLIs. Right side shows one emit/query engine with events primary and audit/logs as aliases.</desc>
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#a3e635"/></marker>
  </defs>

  <text x="40" y="32" fill="#f87171" font-family="Inter,system-ui" font-size="14" font-weight="700">BEFORE — three products</text>

  <rect x="30" y="52" width="200" height="70" rx="10" fill="#111827" stroke="#f87171" stroke-width="2"/>
  <text x="48" y="82" fill="#f8fafc" font-family="JetBrains Mono,monospace" font-size="13">events/*.jsonl</text>
  <text x="48" y="104" fill="#94a3b8" font-family="Inter,system-ui" font-size="11">ops emit()</text>

  <rect x="30" y="138" width="200" height="70" rx="10" fill="#111827" stroke="#f87171" stroke-width="2"/>
  <text x="48" y="168" fill="#f8fafc" font-family="JetBrains Mono,monospace" font-size="13">activity/*.jsonl</text>
  <text x="48" y="190" fill="#94a3b8" font-family="Inter,system-ui" font-size="11">milestones</text>

  <rect x="30" y="224" width="200" height="70" rx="10" fill="#111827" stroke="#f87171" stroke-width="2"/>
  <text x="48" y="254" fill="#f8fafc" font-family="JetBrains Mono,monospace" font-size="13">audit/log.jsonl</text>
  <text x="48" y="276" fill="#94a3b8" font-family="Inter,system-ui" font-size="11">hash chain (separate)</text>

  <path d="M230 87H300" stroke="#64748b" stroke-width="2" fill="none" marker-end="url(#arr)"/>
  <path d="M230 173H300" stroke="#64748b" stroke-width="2" fill="none" marker-end="url(#arr)"/>
  <path d="M230 259H300" stroke="#64748b" stroke-width="2" fill="none" marker-end="url(#arr)"/>

  <rect x="300" y="52" width="170" height="50" rx="8" fill="#1e293b" stroke="#475569"/>
  <text x="318" y="82" fill="#e2e8f0" font-family="JetBrains Mono,monospace" font-size="12">agents events</text>
  <rect x="300" y="148" width="170" height="50" rx="8" fill="#1e293b" stroke="#475569"/>
  <text x="318" y="178" fill="#e2e8f0" font-family="JetBrains Mono,monospace" font-size="12">agents logs …</text>
  <rect x="300" y="244" width="170" height="50" rx="8" fill="#1e293b" stroke="#475569"/>
  <text x="318" y="274" fill="#e2e8f0" font-family="JetBrains Mono,monospace" font-size="12">agents audit</text>

  <text x="30" y="340" fill="#94a3b8" font-family="Inter,system-ui" font-size="12">logs audit already aliases events — the outlier is audit/log.jsonl + logs[id] content</text>
  <text x="30" y="362" fill="#94a3b8" font-family="Inter,system-ui" font-size="12">Transcripts stay on sessions / hosts logs (not this product)</text>

  <text x="560" y="32" fill="#a3e635" font-family="Inter,system-ui" font-size="14" font-weight="700">AFTER — one engine</text>

  <rect x="560" y="52" width="240" height="200" rx="12" fill="#111827" stroke="#a3e635" stroke-width="2"/>
  <text x="580" y="88" fill="#a3e635" font-family="Inter,system-ui" font-size="13" font-weight="700">EventRecord engine</text>
  <text x="580" y="118" fill="#f8fafc" font-family="JetBrains Mono,monospace" font-size="12">emit() / query()</text>
  <text x="580" y="142" fill="#f8fafc" font-family="JetBrains Mono,monospace" font-size="12">readUnifiedEvents()</text>
  <text x="580" y="174" fill="#cbd5e1" font-family="Inter,system-ui" font-size="12">ops + activity + run rows</text>
  <text x="580" y="198" fill="#cbd5e1" font-family="Inter,system-ui" font-size="12">same schema, one filter layer</text>
  <text x="580" y="222" fill="#cbd5e1" font-family="Inter,system-ui" font-size="12">stats · rotate · follow · verify?</text>

  <path d="M800 152H860" stroke="#a3e635" stroke-width="3" fill="none" marker-end="url(#arr)"/>

  <rect x="860" y="60" width="190" height="48" rx="8" fill="#14532d" stroke="#a3e635" stroke-width="2"/>
  <text x="878" y="90" fill="#ecfccb" font-family="JetBrains Mono,monospace" font-size="12">events (primary)</text>

  <rect x="860" y="128" width="190" height="48" rx="8" fill="#1e293b" stroke="#64748b"/>
  <text x="878" y="150" fill="#e2e8f0" font-family="JetBrains Mono,monospace" font-size="12">audit</text>
  <text x="878" y="168" fill="#94a3b8" font-family="Inter,system-ui" font-size="11">≡ --include runs</text>

  <rect x="860" y="196" width="190" height="48" rx="8" fill="#1e293b" stroke="#64748b"/>
  <text x="878" y="218" fill="#e2e8f0" font-family="JetBrains Mono,monospace" font-size="12">logs</text>
  <text x="878" y="236" fill="#94a3b8" font-family="Inter,system-ui" font-size="11">≡ events (passthrough)</text>

  <text x="560" y="300" fill="#a3e635" font-family="Inter,system-ui" font-size="13" font-weight="700">Families</text>
  <text x="560" y="328" fill="#cbd5e1" font-family="JetBrains Mono,monospace" font-size="12">ops · activity · commands · runs · security</text>
  <text x="560" y="354" fill="#94a3b8" font-family="Inter,system-ui" font-size="12">--include / --exclude (mutex, like sessions roles)</text>
  <text x="560" y="380" fill="#94a3b8" font-family="Inter,system-ui" font-size="12">run.dispatched / agent.run.end absorb old audit list rows</text>
</svg>
<figcaption>One write/read engine. CLI nouns are entry points, not products. Content viewing stays on sessions/hosts.</figcaption>
</figure>

<div class="artifact-callout"><strong>Core rule:</strong> if it is a timestamped fleet fact, it is an <code>EventRecord</code> and goes through the events engine. If it is a session transcript or host task stdout, it is not this product — use <code>sessions</code> / <code>hosts logs</code>.</div>

## Purpose

Three top-level commands print similar rows from different writers. Operators and agents guess wrong (`events list` fails; `logs audit` vs `audit list` are different products that share a name). Half the surface already shares an engine (`logs audit` → `runEventsCommand`). The outliers are the hash-chain file and the misnamed content viewer under `logs [id]`.

The fix is one pipeline — not better help text.

## Public interface

### Primary: `agents events`

```bash
# Full stream (default)
agents events
agents events --limit 0 --json

# Sessions-style families
agents events --exclude commands              # drop command.start/end noise
agents events --include activity              # milestones only
agents events --include ops                   # operational only
agents events --include runs                  # what audit list used to show
agents events --include security              # level=audit / secrets sugar

# Existing field filters (keep)
agents events --module secrets --bundle share
agents events --event pr.opened --since 7d
agents events --session <id>
agents events -f

# Housekeeping (moved off logs)
agents events stats [--since 7d] [--json]
agents events rotate [--days 7] [--max-mb 50]
agents events emit --source factory < batch.jsonl
# optional if chain retained:
agents events verify [--json]
```

### Families

| Family | Definition |
| --- | --- |
| `ops` | Operational log rows (module ≠ activity) |
| `activity` | Agent milestones (module = activity) |
| `commands` | `command.start` + `command.end` only |
| `runs` | Run-dispatch outcomes (`agent.run.end` / `run.dispatched`) |
| `security` | level `audit` and/or secrets.* (sugar) |

`--include` and `--exclude` are mutually exclusive, same rule as `sessions`.

### Aliases (zero independent logic)

| Command | Expands to |
| --- | --- |
| `agents audit` | `agents events --include runs` |
| `agents audit list` | same |
| `agents audit verify` | `agents events verify` (if H1) or removed (if H2) |
| `agents logs` | `agents events` |
| `agents logs audit` | `agents events --include ops` |
| `agents logs stats` | `agents events stats` |
| `agents logs rotate` | `agents events rotate` |

Implementation pattern: one `runEventsCommand`; aliases only set default opts.

### Leaves this surface

| Old | New home |
| --- | --- |
| `agents logs <session-id>` transcript | `agents sessions <id>` / `sessions tail` |
| `agents logs <task-id>` host stdout | `agents hosts logs <id>` |

If `agents logs <id>` is kept for muscle memory, it **redirects** with a clear message — it does not reimplement content viewing.

## Run-dispatch rows (absorb `audit list`)

Today `audit list` shows: index, ts, agent@version, mode, ok/fail, exit, repo.

At the exec chokepoint that currently calls `recordDispatchedRun`:

```diff
- appendAuditRecord({ ts, agent, version, repo, mode, outcome, exit })
+ emit('agent.run.end', { agent, version, repo, mode, outcome, exit })
  // or 'run.dispatched' if end is too overloaded
```

`--include runs` (and thus `agents audit`) can use a **row format** tuned like the old audit table. Presentation is not a second engine.

### Hash chain (pick at implement start)

| Option | Behavior |
| --- | --- |
| **H1** | `prevHash`/`hash` on run rows only; `events verify` walks them in the same stream |
| **H2** | Drop chain product; just emit outcomes; delete verify |

Recommendation: H1 only if something still gates on `audit verify` in CI; else H2. Either way **no separate `audit/log.jsonl` product.**


## Proposed Changes

| Change | What happens |
| --- | --- |
| One EventRecord engine | All timeline writes go through `emit()`; all reads through `query` / `readUnifiedEvents` + family filters |
| `--include` / `--exclude` | Sessions-style family filters: ops, activity, commands, runs, security |
| `agents audit` | Thin alias of `agents events --include runs` — no second store |
| `agents logs` | Thin alias of `agents events`; stats/rotate re-dispatch; `logs [id]` redirects to sessions/hosts |
| Run-dispatch rows | `recordDispatchedRun` becomes `emit('agent.run.end'…)` (or `run.dispatched`) |
| Retire `audit/log.jsonl` | Stop writing the hash-chain file for new runs; optional H1 verify on run rows or H2 drop |

### Diff sketch — alias not peer product

```diff
// commands/audit.ts
- readAuditLog() + custom renderRow for AuditRecord
+ runEventsCommand({ ...opts, include: 'runs' })
```

### Diff sketch — run end writes events

```diff
// exec dispatch end
- appendAuditRecord({ ts, agent, version, repo, mode, outcome, exit })
+ emit('agent.run.end', { agent, version, repo, mode, outcome, exit })
```

## Implementation plan

### Phase 1 — families on the existing engine

- Add `--include` / `--exclude` family parser in the events option surface (mutex).
- Map families → `includeActivity` + eventTypes / level inside `readUnifiedEvents` (no second scan).
- Help leads with `--exclude commands`.
- Tests: family filters, mutex, interaction with `--module` / `--event`.

### Phase 2 — collapse CLIs onto one handler

- `registerAuditCommands` → thin alias (default `--include runs`).
- `registerLogsCommand` → thin alias of events; stats/rotate re-dispatch.
- Remove independent `readAuditLog` list renderer from the audit command tree.
- `logs [id]` → redirect to sessions/hosts.
- Deprecation one-liners for one train if needed.

### Phase 3 — absorb run-dispatch into emit

- At run end: `emit(...)` with fields audit list needed.
- Stop appending to `audit/log.jsonl` for new runs.
- Optional migration of historical chain rows into events JSONL.
- Gut or delete `lib/audit/log.ts` once no writers remain.
- H1 or H2 for verify.

### Phase 4 — docs + fleet guidance

- Rewrite `apps/cli/docs/observability.md` table.
- CHANGELOG under next version.
- Companion `.agents-system` skills/rules that teach old names — linked PR if consumers exist.

## Key files

| Area | Path |
| --- | --- |
| Types + emit + query + stats + rotate | `apps/cli/src/lib/events.ts` |
| Unified reader | `apps/cli/src/lib/event-stream.ts` |
| Events CLI + shared handler | `apps/cli/src/commands/events.ts` |
| Audit CLI → alias | `apps/cli/src/commands/audit.ts` |
| Logs CLI → alias | `apps/cli/src/commands/logs.ts` |
| Hash chain (retire) | `apps/cli/src/lib/audit/log.ts` |
| Run end write site | exec dispatch / `recordDispatchedRun` call sites |
| Docs | `apps/cli/docs/observability.md` |

## Validation

```bash
# same engine answers all three nouns
agents events --include runs --limit 5 --json
agents audit --limit 5 --json          # identical records
agents logs --include runs --limit 5 --json

agents events --exclude commands --limit 10
agents events stats --json
agents events rotate --days 7 --max-mb 50

# content is not events
agents sessions <id> --markdown
agents hosts logs <task-id>
```

## Risks

| Risk | Mitigation |
| --- | --- |
| Scripts call `audit list` / `logs audit` | Wrappers keep flags/JSON working |
| Hash-chain consumers | H1 keeps verify on same stream; or document drop |
| `logs <id>` muscle memory | Explicit redirect to sessions/hosts |
| Activity still sharded on disk | Same schema + one reader; write split is internal |
| Bare events still noisy | Teach `--exclude commands` (locked decision) |

## Plan checklist

- [ ] Confirm H1 vs H2 for hash chain at implement start
- [ ] Phase 1: `--include` / `--exclude` on events engine
- [ ] Phase 2: audit + logs as aliases; move stats/rotate; redirect logs [id]
- [ ] Phase 3: emit run outcomes into events; retire `audit/log.jsonl` writer
- [ ] Phase 4: docs, CHANGELOG, companion guidance
- [ ] Prove: three CLI nouns → one query path; new runs never open the old audit file
