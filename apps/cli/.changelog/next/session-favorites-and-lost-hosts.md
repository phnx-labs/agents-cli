- **Favorite sessions from the browser.** `*` stars the highlighted session in
  `agents sessions` and `f` filters the list to the starred ones; outside a TTY,
  `agents sessions favorite <id>` (`--remove` / `--list` / `--json`) and
  `agents sessions --favorites` do the same. Stars live in
  `~/.agents/.history/favorites.json` keyed by session id, so they survive a reindex
  of the session cache and follow the session across machines. Source:
  `apps/cli/src/lib/session/favorites.ts`, `apps/cli/src/commands/sessions-favorite.ts`.
- **Detect sessions that lost their host — two new statuses, `crashed` and `orphaned`.**
  A session whose editor window or connection went down hard used to just VANISH from
  `agents sessions --active` (its dead-pid registry entry was filtered out), and one
  still running in tmux with nobody attached reported a plain `idle`. Both now say so:
  `✗ crashed` when the host window stopped republishing and the agent died with it,
  `◍ orphan` when the agent is alive with zero clients attached. Derived from tmux's
  `#{session_attached}` and the IDE window's registry heartbeat — never from a
  deliberate `agents sessions detach`, and never over a session that is still working.
  Source: `apps/cli/src/lib/session/host-link.ts`, `apps/cli/src/lib/session/active.ts`.
