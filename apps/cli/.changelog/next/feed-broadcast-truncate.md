- **Phone forwards are shaped to a text, not a wall.** `agents feed post`
  (`--level important` / `--blocked`), `agents notify`, and `agents send --to owner`
  all forward to the owner's phone through one seam, `composeBroadcastMessage`; it now
  keeps the post **title** (the scannable headline) and truncates a long **body** to a
  short excerpt marked `… (full in feed)` (caps: 500 chars / 8 lines). The full post is
  untouched in the feed — only the outbound phone copy is shortened — so a requested
  long write is not lost, and enforcing it at this seam covers every sink (owner alias,
  in-process `channel:`, spawned `command:` via `{message}`), which a per-command shell
  hook cannot. Source: `apps/cli/src/lib/feed-broadcast.ts` (`truncateBroadcastBody`).
