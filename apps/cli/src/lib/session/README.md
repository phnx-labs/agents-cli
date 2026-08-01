# `lib/session` — the session subsystem

This directory owns everything about an "agent session": discovering transcripts on
disk, parsing them per harness, detecting which are alive, indexing them for search,
and rendering them for the `agents sessions` command. If code reasons about a session
as a first-class object, it lives here or speaks the types defined here.

This README is the spec for two things that kept drifting and were never written down:

1. **The session data model** — what one session record carries (and what it does not).
2. **The session preview contract** — the fields the preview must show, why, and where
   each one comes from.

It also records the fleet-scale requirement for the `--active` fan-out so the next
rework does not silently regress it.

All file:line anchors below are against the tree this doc was committed with; treat
them as starting points, not guarantees.

## Pipeline

```
discover.ts   scan Claude/Codex/Gemini/OpenCode/OpenClaw roots  ->  raw transcript files
parse.ts      parse a transcript into SessionEvent[]            ->  normalized events
state.ts      derive durable signals (activity, awaiting, todos) ->  SessionState
active.ts     probe live processes (ps / tmux / teams / cloud)  ->  ActiveSession[]
db.ts         SQLite index + FTS over SessionMeta               ->  SessionRow
render.ts     summary + stats for `agents sessions <id>`        ->  text
```

`types.ts` is the source of truth for the shapes every stage speaks. Cross-machine
concerns live in `remote-active.ts` / `remote-list.ts` / `remote.ts` and the
`sync/` subdir.

## Canonical data model

`SessionMeta` (`types.ts:106`) is the normalized in-memory record used in every
listing and picker. `SessionRow` (`db.ts:143`) is its 1:1 SQLite persistence shape
(table `sessions`, `db.ts:50`). `SessionEvent` (`types.ts:26`) is one parsed event
inside a transcript; per-turn cost/model/token detail lives here, not on `SessionMeta`.

Live processes are a separate shape: `ActiveSession` (`active.ts:76`) with its
provenance (`provenance.ts:66`). `ActiveSession` carries runtime facts that no
persisted `SessionMeta` has — notably the origin device and a live fork/subagent
count — and those facts are lost the moment the process exits unless we persist them.

## The session preview contract

There are two distinct renders. Do not confuse them.

- **Preview panel** — `buildPreview` (`sessions-picker.ts:114`) -> `formatHeader`
  (`sessions-picker.ts:167`) + `formatCompactPreview` (`sessions-picker.ts:310`).
  This is what the interactive browser shows on `tab`, and what the non-interactive
  `--preview` flag prints (`sessions.ts:1085`). It takes a `SessionMeta` plus, when
  available, the parsed `SessionEvent[]`.
- **Full summary** — `renderSession` summary mode (`sessions.ts:1769`) ->
  `renderSummaryHeader` (`render.ts:288`) + `renderSummary` (`render.ts:586`).
  This is `agents sessions <id>`. It already renders a **Subagents (N)** section
  (`render.ts:778`), counted from `Task`/agent tool calls (`render.ts:660`).

The preview is the high-value surface: it is what a human reads to decide "is this the
session I mean?" before resuming. It must answer, at a glance, **who ran this, where,
with what, and how big it got.** The nine fields below are that contract.

| # | Field | Meaning | In preview today | In the data model |
|---|-------|---------|------------------|-------------------|
| 1 | owner / account | who ran it | yes — `sessions-picker.ts:178` | `SessionMeta.account` (`types.ts:136`) |
| 2 | harness (agent) | claude / codex / … | yes — `sessions-picker.ts:175` | `SessionMeta.agent` (`types.ts:109`) |
| 3 | version | agents-cli version | yes — `sessions-picker.ts:175` | `SessionMeta.version` (`types.ts:135`) |
| 4 | model | model used | yes* — `sessions-picker.ts:177` | **not persisted** — only `SessionEvent.model` (`types.ts:51`), read via `extractModel` |
| 5 | tokens burned | total (and output) | yes — `sessions-picker.ts:201` | `SessionMeta.tokenCount` (`types.ts:128`), `outputTokens` (`types.ts:130`) |
| 6 | duration | how long it ran | yes — `sessions-picker.ts:194` ("lasted") | `SessionMeta.durationMs` (`types.ts:133`) |
| 7 | device it ran ON | the machine executing it | partial — remote-only note (`sessions-picker.ts:126`); not shown for local | `SessionMeta.machine` (`types.ts:205`); `ActiveSession.machine` (`active.ts:168`) |
| 8 | device STARTED FROM | ssh/origin device that launched it | **no** — not in the preview panel (it is in the list row via `sshOriginTagFor`, `sessions-browser.ts:367`) | **not persisted** — live-only `ActiveSession.provenance.origin.device` (`provenance.ts:79`) |
| 9 | sub-agents spawned | how many child agents/forks | **no** in the preview panel | **not persisted** as a count — live `ActiveSession.pidCount` (`active.ts:153`); the full summary recomputes it (`render.ts:660`) |

`*` model silently disappears for remote/unindexed rows: `formatMetaOnlyBody`
(`sessions-picker.ts:233`) renders a `SessionMeta` with no events, and `model` is
derived from events, so it drops. This is the one field in the preview that is
genuinely lossy today.

### Gaps to close (and how)

Six of the nine fields are already in the preview. The work is the other three plus
the one lossy field:

- **model (#4) for remote/unindexed rows.** Persist a per-session `model` (or a small
  `models[]`) onto `SessionMeta`/`SessionRow` at index time, so the preview does not
  depend on a live event parse. Today it is derived from events only.
- **device it ran on (#7) for local rows.** Show `machine` unconditionally, not only
  when remote. The field exists; the render just gates it.
- **device started from (#8).** This is the biggest gap: the origin device is computed
  live from ssh provenance (`provenance.ts:79`) and never persisted, so it is gone once
  the process exits. To show it in the preview of a past session it must be captured at
  session start and stored on `SessionMeta`/`SessionRow` (a new `originDevice` /
  `startedFrom` column). Coordinate with the sessions.db `machine` work.
- **sub-agent count (#9).** Persist the count (or a lightweight roster) at index time,
  the same number the full summary computes at `render.ts:660`, so the preview can show
  it without reparsing.

### On the "the rework dropped preview fields" report

This was investigated against full history (2842 commits, `git log --follow` on
`sessions-picker.ts` plus pickaxe on `subagent`, `provenance`, `session.machine`).
**No commit ever removed model, tokens, duration, owner, machine, ssh-origin, or a
sub-agent count from the preview panel.** The default-UX "interactive fleet-wide
browser" rework (`b5ca212f`) did not touch `sessions-picker.ts` at all; the largest
preview change (`dd2796a3`) *added* the current multi-line header, replacing a
one-line one. The three fields the operator expects and cannot find — device
started-from, sub-agent count, and local device-ran-on — were **never in the preview
panel**. So this is a never-had-it gap to fill (the list above), not a regression to
revert. The one thing that does silently vanish is model on remote/unindexed rows,
for the `formatMetaOnlyBody` reason above.

## Fleet `--active` behavior and the scale requirement

`agents sessions --active` splits on TTY (`sessions.ts:1157`): an interactive terminal
gets the browser (`sessions-browser.ts`), everything else gets the static
`renderActiveSessions` dump. Both funnel through one fleet sweep, `gatherActiveSessions`
(`sessions.ts:947`) = local `getActiveSessions()` + remote SSH fan-out
`gatherRemoteActive` (`remote-active.ts:62`), deduped by `${machine}:${sessionId}`
(`sessions.ts:711`).

The interactive running-filter live set is fleet-wide: the browser builds `live` from
the same `gatherActiveSessions` (`sessions-browser.ts:446`), not the old local-only
`getActiveSessions`, so the browser and the JSON dump can no longer disagree about what
is running. Keep it that way — the local-only intersection was a real bug (a host
showed 3 sessions while `--active --json` showed 30).

**Requirement: the fan-out must stay fast at 100–200 devices.** It does not today.
`gatherRemoteAgentsJson` (`remote-agents-json.ts:102`) is an unbounded
`Promise.all(targets.map(...))` that `spawn`s one `ssh` process per peer
(`remote-agents-json.ts:45`) with no concurrency cap, no batching, and no per-peer
streaming — the whole view blocks on the slowest peer up to the 12s app timeout
(`remote-agents-json.ts:18`). There is no result cache for the live view, and the
online pre-filter reads a possibly-stale `tailscale.online` snapshot
(`remote-agents-json.ts:81`), so sleeping hosts are still dialed and burn the full
timeout. Any rework of this path must preserve fleet-wide correctness while adding:
a bounded concurrency pool, incremental render as peers resolve (not
`await Promise.all`), and a fresher reachability gate. Treat "fast at 200 devices" as
an acceptance criterion, not a nice-to-have.
