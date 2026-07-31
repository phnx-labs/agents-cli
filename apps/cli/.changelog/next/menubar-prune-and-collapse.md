- **Menu bar: prune orphan attention sentinels; group `NEEDS YOU`; end silent
  truncation.** `LocalState.attentionMarks` now takes the caller's live-session
  set and unlinks sentinels whose `sessionId` is not alive — the
  `06-attention-sentinel.sh` hook already clears on `Stop`/`UserPromptSubmit`,
  but leaks when a terminal is killed hard, a Claude version has no hook, or the
  `sessionId` doesn't round-trip; the reader is the only layer with `pidAlive`
  ground truth. Verified on mac-mini: 6 stale sentinels aged 1–22 days pruned to
  0 on one dump run. `addNeedsAttention` groups blocked sessions by
  `(agent, repo)` and collapses groups of 2+ into a single
  `<Agent> · <repo> · N waiting · oldest <t> ›` row + submenu, dropping the
  generic `— Claude is waiting for your input` filler when the Notification
  message is empty. `addActive` collapses the `"other"` bucket to a single
  clickable `ACTIVE · other · N idle ›` row when idle-only, and replaces the
  silent 3-cap on idle rows with an explicit `+ N more idle ›` row + submenu so
  the header count always matches visible + explicit-hidden. No new session
  state — closed = hidden, as before.
