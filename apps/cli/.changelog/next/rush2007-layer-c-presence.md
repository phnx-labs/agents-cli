- **`agents watchdog` now tracks per-session presence (RUSH-2007 Layer C).** Each
  tick reconciles a per-session presence record — `{location, device, transport,
  lastSeen, status}` at `~/.agents/.cache/state/watchdog/presence.json` — from the
  tick's active scan, deriving `connected` / `disconnected` by diffing consecutive
  ticks. A session that was tracked but is now absent (its SSH link dropped or the
  peer went unreachable) flips to `disconnected`, and the flip is surfaced in
  `agents watchdog --json` under `presence.transitions` — an interactive drop as a
  `reconnect-nudge` candidate, a headless remote as `keep-alive`. Folded into the
  existing tick (no revived daemon, no extra SSH fan-out); additive and does not
  change the tick's nudge decisions. Source:
  `apps/cli/src/lib/session/presence.ts`, `apps/cli/src/lib/watchdog/runner.ts`.
