- **Stop the interactive host auto-reconnect spinning forever on a flapping link
  (#1884).** A reattach only refills the retry budget now if it reached the host
  **and** held the remote pane for at least 10 seconds. Before, the budget refilled
  on the preflight probe alone, so a link that reconnected and dropped the user
  straight back out — or an attach that died at TTY negotiation every time — printed
  `Reconnecting … (attempt 1/6)` on every cycle forever and `MAX_ATTEMPTS` bounded
  nothing. A link that keeps dropping now spends the budget and gives up with a
  message that says so ("kept dropping again within 10 seconds of getting back in"),
  distinct from the unreachable-host "couldn't reconnect". A session that blinks all
  day and reconnects into a working pane each time is unaffected. Source:
  `apps/cli/src/lib/hosts/reconnect.ts`, `docs/hosts.md`.
