- **The Linear line on `agents projects status` is cached, and stops vanishing.** The card
  paged every issue in a project on every invocation — up to 10 requests per project — against
  a 2500/hour request budget that an agent running `status` in a loop exhausts. Answers are now
  cached on disk for 10 minutes (`~/.agents/.cache/.linear-projects.json`), so a repeated
  `status` spends zero Linear requests. More importantly, a failed or rate-limited fetch now
  serves the last good answer marked stale instead of dropping the line: a populated Linear row
  silently disappearing on one 8s timeout was the observed defect, and it is the same rule
  `mergeAuthHealthEntries` already keeps for account health. A 429 records its
  `x-ratelimit-requests-reset` so later runs don't spend a request to be told there are none
  left. Source: `apps/cli/src/lib/linear-cache.ts`.
