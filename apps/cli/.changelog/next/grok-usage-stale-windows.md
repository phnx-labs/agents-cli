# Grok usage bars ignore expired / missing last-seen billing

`agents view grok` reads weekly usage from each machine's local
`.grok/logs/unified.jsonl` (`network: false`). Two bugs made the bars disagree
across devices and lie after a weekly reset:

1. A billing line with no `creditUsagePercent` was coerced to **0%**, so a fresh
   period looked empty instead of unknown.
2. An **expired** period (e.g. last week's 100%) was still rendered, so one box
   showed `rate-limited` after the window had already reset.

Expired windows are dropped via the same freshness check used for the Claude
usage cache; missing percents no longer invent a bar. Live cross-device parity
still requires a Grok session on that box to write a new billing line — there is
no network usage probe for Grok yet.
