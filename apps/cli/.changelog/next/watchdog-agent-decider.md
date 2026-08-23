---
type: feat
---

The watchdog decider is now an agent, not a heuristic script. Every idle session on the machine (its originating task + transcript tail) is handed to ONE `agents run --mode plan` call per tick, which judges each: idle-but-unfinished → nudge that drives it to finish; idle-and-done or genuinely-needs-human → skip. The deterministic pre-filter (`isLikelyTrulyBlocked`, completion/promise regex) and the per-session LLM spawn are gone — one bounded call per tick, only when something is actually idle. A nudge is booked in the cooldown ledger and logged `nudge` ONLY when delivery is confirmed; tmux/iterm/pty self-confirm, while vscodium's fire-and-forget `--open-url` is recorded `undelivered` until the swarm-ext extension acks the verb, ending the phantom-nudge ledger. `agents watchdog history` gains an `undelivered` row; the `--smart` flag is removed (the agent is always the decider). Defaults stay OFF.
