- **`agents webhooks` now advertises `/hooks/slack`.** The receiver has accepted signed
  Slack deliveries since the Slack bridge landed, but `agents webhooks serve` and
  `agents daemon webhooks list` still printed only `/hooks/github, /hooks/linear` — the
  one URL you must paste into the Slack app was missing from the banner. The slash-command
  ack now also says "replying in this channel", matching where the reply actually posts
  (a slash command carries no thread). Source: `apps/cli/src/commands/webhook.ts`,
  `apps/cli/src/commands/daemon.ts`, `apps/cli/src/lib/triggers/webhook.ts`.
