- **Stream and answer the canonical operator feed.** `agents feed watch --json`
  now emits one versioned agents, attention, activity, and scope projection for
  thin clients, including retained peer rows across disconnects. `agents feed
  answer <attention-key>` atomically claims the first answer and routes it over
  the recorded reply rail; concurrent losers return `already_answered` without
  injecting twice. Pull-request attention is refreshed by the CLI on a bounded
  TTL. Source: `apps/cli/src/lib/feed/{watch,answer,pr-status}.ts`.
