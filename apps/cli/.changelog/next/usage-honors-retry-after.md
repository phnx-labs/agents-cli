- **A rate-limited usage endpoint is now backed off instead of hammered.** The
  daemon warms auth-health every 3 minutes and probes *every installed version
  home* in one parallel batch, so a machine with five Claude accounts sent five
  concurrent requests to `api.anthropic.com/api/oauth/usage` every three minutes
  — roughly 100/hour — before the usage refresh added its own. Nothing read
  `Retry-After`. Measured on `yosemite-s1`: the endpoint answered
  `429 rate_limit_error` with `retry-after: 2678` (about 45 minutes) for every
  account while the credentials themselves read healthy, and the next tick fired
  three minutes later, deep inside the penalty window, re-arming it. The box
  never recovered, every usage read failed, and its cache froze — the
  permanently-stale state balanced routing was already having to defend against.
- **A 429 now records its deadline and every read honours it.** Usage fetches and
  health probes for that provider short-circuit until the window passes — no
  request, no renewed penalty — and report
  `Claude rate-limited this machine — not retrying for 45 minutes.` The state is
  on disk, because the callers are separate processes: the long-lived daemon and
  every one-shot `agents view` / `agents run`. A server delay is capped at an
  hour, a missing or unparseable `Retry-After` still backs off, and a later 429
  carrying a shorter delay never shortens an existing window.
