- **Watchdog v2 — the always-on watchdog now has judgment and delivers correctly
  into VS Codium.** The 2-minute `agents watchdog --nudge` routine no longer
  hard-skips a session that stopped to ask a question. The deterministic pass is
  now a cheap pre-filter (clearly-complete → skip, clear promise-without-toolcall →
  nudge) that ESCALATES the judgment-heavy cases — a session parked on a question,
  or an ambiguous stall — to a smart brain. The brain drives the agent to finish
  end-to-end when it asked a needless / already-authorized question or paused with
  work left, and leaves it for the human only for genuine cases (credentials/auth,
  an irreversible or outward-facing action, a real ambiguous product decision, or a
  finished task). Nudge messages restate the goal, tell the agent to use best
  judgment, and give one concrete next step. The brain is a customizable
  `watchdog` workflow: drop a `watchdog` WORKFLOW.md in your project or user
  `workflows/` to override the prompt and pick the `model:`; absent one, the
  improved built-in prompt runs via `agents run … --mode plan`. Source:
  `apps/cli/src/lib/watchdog/watchdog.ts`, `apps/cli/src/lib/watchdog/runner.ts`.
- **Watchdog delivery routes through the answer-router with the VS Codium rail
  working.** A running agent is steered via its mailbox; a parked-on-question agent
  is answered into its EXACT split — including a VS Codium / Cursor / VS Code
  integrated terminal, which the answer-router's own resolver could not address —
  or, when headless, re-entered via resume; a parked agent with no addressable rail
  is flagged, never a guessed target.
- **Watchdog precedence + concurrency fixes.** A long-idle (>15m) open question is
  no longer blindly force-nudged — waiting-on-user and completion now win over the
  15-minute force-review short-circuit. The per-session cooldown ledger is written
  under a file lock (fresh-read + merge + atomic write), closing a lost-update race
  between concurrent ticks.
- **Watchdog decisions are logged to `~/.agents/.cache/logs/watchdog.log`** in the
  JSONL shape the Factory Floor watchdog card reads, so it keeps working after the
  extension-side watchdog is retired.
