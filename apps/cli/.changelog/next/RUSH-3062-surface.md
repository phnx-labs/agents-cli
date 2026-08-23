---
type: feat
---

Put real capacity in the default `agents devices list` — a `spec` cell (cores / total RAM / total disk), a `disk` used column beside load and mem, and the per-device `description` as the tail column (truncated first on narrow terminals, then role; the numbers never truncate). Add `agents devices describe <name> <text>` (task-shaped sugar over the `description` config key) and `agents devices ignored` (dismissed nodes — when, and which machine dismissed them). `devices list --json` gains `description` and disk totals inside `health` (additive only).
