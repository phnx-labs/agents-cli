- **Collapse indistinguishable worker processes into one active-session row.** A daemon
  that spawns many agent binaries (an OpenClaw gateway running `codex app-server`) produced
  one `sessions --active` row per process, because a row with no session id and no
  transcript file skipped dedupe entirely — the Factory Floor showed ~40 identical
  `.openclaw · bg · 0s ago` rows that buried every real session. Dedupe now falls back to
  the cloud/run handle and then to the worker's identity (agent binary + context + working
  directory), so N indistinguishable workers become one row carrying `pidCount: N`.
  Source: `apps/cli/src/lib/session/active.ts`.
