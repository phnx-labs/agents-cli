# Project memory — agents-cli

Timestamped, provenance-anchored memory of the **major decisions** made on this project
(the agents-cli / AGI EXT / Agency.Li ecosystem, formerly Swarmify). One file per day,
`yyyy-mm-dd.md`. This is a durable decision log, not a changelog and not narration —
it records *what was decided and why*, and *who decided it*.

## Entry format

```
### HH:MM · agent@device · shortid · TICKET
- the decision made and the why / tradeoff
- outcome: PR #NNNN merged / shipped in vX / superseded
- Executed via: codex@yosemite-s0 019fd5bd, grok@yosemite-s1 019fd5d4   (for swarms)
```

- **agent@device** — which harness (claude/codex/grok/droid/kimi/cursor/opencode) on which
  fleet box (`zion` = the interactive laptop; `yosemite-s0`/`yosemite-s1` = workers).
- **shortid** — first 8 chars of the driving session's id. Cross-reference with
  `agents sessions <shortid>`. `—` where a decision is captured only in an artifact/plan
  and no single driver session resolves.
- **TICKET** — the Linear/GitHub id, or `—`.

## How this was backfilled (2026-08-10)

Session provenance was mined from `agents sessions` across all three devices that hold
this project's history (`zion`, `yosemite-s0`, `yosemite-s1`) — 3,032 sessions, 2,224 in
the agents-cli family, 2026-06-19 → 2026-08-10. Decisions were extracted from the dated
`.agents/artifacts/` plans/specs/reports (via `mq`), `apps/cli/CHANGELOG.md`,
`apps/cli/docs/specifications.md`, and `git log`. Every `HH:MM · agent@device · shortid`
chip resolves to a real session in the index (288 verified). Topic-only entries, where
no shipped change or artifact could be cited, are marked as such rather than invented.

## Index

Coverage: **42 active days**, 2026-06-24 → 2026-08-20 (gap 08-11 → 08-19 not yet backfilled).

- **Jun 24 – Jul 06** — Swarmify → Agency.Li rename; reducing Touch ID prompts (secrets
  broker); native cloud providers; agents teams; routines; the `.agents` DotAgents repo;
  Windows QA box; monorepo-workspaces reversal.
- **Jul 07 – Jul 31** — agents teams feature + spec; `--host`/`--device` flag
  centralization (two-phase, RUSH-1691 → RUSH-1967); Prix code-reviewer; Factory tabs;
  grok overnight code-loop drains; routines default-to-auto; `agents send`/`notify`/`feed`.
- **Aug 01 – Aug 04** — actor/provenance foundation; release-train jam analysis;
  invisible-sessions fix (PR #1765); `--model cheap/default/best/ultra`; one-transport
  (RUSH-2123); phnx-labs org rename; Factory launch balanced-strategy spec.
- **Aug 05 – Aug 07** — release marathon (1.22.9 → 1.22.26); menubar instant dispatch;
  task-enforcement map; the big GitHub-issue swarm (#1767/#1820/#1884/#1889/#1892/...);
  Cursor multi-account spec; account labels; routine-reliability contract; daemon-as-sole-scheduler.
- **Aug 08 – Aug 10** — unified accounts (RUSH-2527, breaking account model); remove
  `--host`, `--device` sole target (RUSH-2494); CLI surface consolidation; DeepInfra;
  events-one-engine (PR #2550); daemon services + monitors ownership; browser sessions in
  DB; dev-install no-shadow (`agents-dev`); Factory → AGI EXT rename; this backfill.
- **Aug 20** — sub-60s CI/release goal set; release train unwedged (repoRootForCwd home
  bug, darwin-only escapes past the Linux-only gate); 1.22.41 shipped end-to-end;
  headless npm token on mac-mini (file-backed); trusted-pool PR lane refused as
  fork-unsafe (29s check proven, untrusted-executor lane pending owner decision).
