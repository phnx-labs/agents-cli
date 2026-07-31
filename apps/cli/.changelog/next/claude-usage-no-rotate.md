- **Reading Claude usage no longer rotates the token and logs your fleet out.**
  `getClaudeUsageInfo` refreshed the OAuth token just to read the usage endpoint
  (`getClaudeAccessToken`, `usage.ts`) — and Claude's refresh token is single-use
  and rotates server-side, so with one account signed into several machines that
  background refresh (fired by the stale-while-revalidate usage cache and by
  `agents run`'s default "balanced" rotation on every unpinned run) invalidated
  every other box's copy, dropping the fleet to "run /login". This is the
  RUSH-1822 stampede, which was fixed for the 3-minute health probe but left live
  in the usage/run hot path. Usage reads are now strictly read-only: a new pure
  `claudeUsageAccessTokenNoRefresh` uses the stored access token and, when it is
  within the refresh leeway, reports "no usage right now" instead of rotating —
  exactly mirroring `probeClaudeStatus`. The single legitimate refresh stays on
  the real `claude` run, never a usage read. Source: `apps/cli/src/lib/usage.ts`,
  `apps/cli/src/lib/usage.test.ts`.
