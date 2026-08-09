- **`agents feed post --notify` raises a local desktop banner on top of any configured broadcast.**
  A feed post already forwards outward through `feed.broadcast` sinks (a Linear comment, an
  owner-channel iMessage), but reaching the local desktop meant hand-declaring a `channel: desktop`
  sink in `agents.yaml`. `--notify` is the per-post, config-free equivalent — the same
  `notifyDesktop` banner `agents run --notify` fires — added **on top of** whatever delivery is
  already configured, never replacing it. It routes through the real `desktop` channel provider like
  every other `channel:` sink, so it appears in the post's broadcast outcomes and the `--json`
  payload rather than a side path. Two properties follow: it carries no `minLevel`, so a routine
  milestone post can raise a local heads-up without an `important`-gated phone sink buzzing the
  phone; and the banner is local (it reaches whoever is at the machine the post was authored on, a
  no-op with a stated reason where no notifier exists), so a headless post never mis-fires at the
  operator's Mac — reaching a phone stays the job of an `important`-level owner/broadcast sink.
  Source: `apps/cli/src/lib/feed-broadcast.ts` (`withDesktopNotify`), `apps/cli/src/commands/feed.ts`.
