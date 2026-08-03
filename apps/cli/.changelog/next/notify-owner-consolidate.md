- **Owner notifications route through the one channel seam.** The feed urgent-block
  dispatch and the monitor `notify` action now send through the registered channel
  provider (`lookupTransport` → `ChannelProvider.send`) instead of shelling out to
  `openclaw` directly. The recipient comes from `notify.owner` in agents.yaml — the
  hardcoded owner chat id is gone, so changing `notify.owner` is honoured by every
  path. A bare `--notify` on a monitor now targets `notify.owner`; `--notify <channel>`
  overrides the owner channel. The monitor path also gains the provider's missing-binary
  guard (a clean error instead of a raw ENOENT). A channel name that resolves to no
  registered provider (a typo in `notify.owner.channel`, or `--notify <channel>`) fails
  that one send with a clean error — it does not exit the monitor daemon or abort the
  `agents feed --dispatch` loop. Source: `apps/cli/src/lib/notify.ts`,
  `apps/cli/src/lib/monitors/dispatch.ts`, `apps/cli/src/lib/channels/resolve.ts`.
