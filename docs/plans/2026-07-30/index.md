# agents-cli plans — 2026-07-30

Curated snapshot of the HTML plan/design docs a fleet of agents produced against
agents-cli on 2026-07-30. Originals live in `/tmp`; these are point-in-time copies
(byte-identical to source at copy time). 13 kept out of ~16 produced — duplicates
and superseded intermediates were dropped (see the bottom section).

Provenance note: these files were still being rewritten while curated. Where two
cuts of the same plan existed, the newer one was kept and the older left in `/tmp`.

---

## 1. System architecture & onboarding

- **agents-cli-architecture-v1.html** — *system design (v1)*. The design doc:
  what agents-cli is, what it must do, and how it's built — the whole system, not
  just sessions. Newest architecture doc.
- **agents-cli-architecture.html** — *the distributed core*. Codebase onboarding:
  how agents-cli runs, watches, and shows agents across a fleet. Complements v1 as
  the as-built view.

## 2. Performance & reliability audit — four escalating research passes

- **agents-cli-ideas.html** — *six architectural moves*. Brainstorm companion to
  "the distributed core": six moves, plus three things the onboarding report got
  vague or wrong.
- **agents-cli-measured.html** — *measured (3rd pass)*. Numbers, not reasoning: the
  bottleneck isn't the poll — it's 80 GB of data nothing ever deletes.
- **agents-cli-timeline.html** — *where the milliseconds go (4th pass)*. The latency
  path profiled: it is not re-parsing your sessions — 271 ms loading code + 127 ms
  resolving where files live.
- **agents-cli-audit.html** — *the real audit* (capstone). Five parallel audits over
  5,204 runs / 1,256 transcripts / all four hosts: 44.1% of routine runs fail, and
  80.6% of those failures are one thing — auth.

> `measured` and `timeline` are the 3rd/4th passes that fed the audit capstone;
> kept because their raw profiling numbers (the 80 GB bloat, the 271/127 ms
> breakdown) are not fully reproduced inside `audit`.

## 3. Auth / credentials

- **agents-cli-auth-plan.html** — *credential subsystem remediation plan*. Three
  independent defects, one symptom cluster; the remediations are two PRs already
  written. Every claim carries the command that proves it. This is the actionable
  follow-through on the audit's auth finding.

## 4. Implementation plans — discrete, actionable

- **plan-configured-model-205039.html** — show the configured model everywhere
  agents-cli displays an agent. Newer of two cuts; supersedes `plan-configured-model.html`.
- **plan-watchdog-daemon.html** — *the watchdog is glue*. Treat the watchdog as
  composition, not a subsystem — bury it in the daemon as just another agent.
  (Rewritten at 22:12 from an earlier "Watchdog into the daemon" cut.)
- **plan-menubar-prune.html** — prune ghost sentinels and collapse the "other"
  bucket in the menu-bar helper.
- **plan-inspect-version-picker.html** — ask which version to inspect when many
  are installed.

## 5. UI redesigns / mockups

- **fleet-status-redesign.html** — fleet status, legible in a glance and fast by
  default (fleet UX + performance).
- **menu-mockup.html** — menu bar before/after, v3 (interactive). Pairs with
  `plan-menubar-prune.html`.

---

## Left in /tmp (superseded / dup / trivial)

- **plan-configured-model.html** — older cut; superseded by `-205039`.
- **agents-cli.sh.html**, **agi-cli.sh.html** — ~1 KB stubs, not plans.
