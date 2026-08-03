- **Mailbox messages now expire and dead boxes are reaped automatically.** Messages
  enqueued without an explicit TTL used to sit in the spool forever, so pending mail
  would outlive the session that needed it. They now get a 24-hour default TTL
  (`AGENTS_MAILBOX_TTL` overrides the default; `agents message … --ttl 2h` sets it
  per message). When a message expires, a live-but-idle box archives it with a
  `dropped: expired` receipt. The watchdog tick also runs a liveness sweep using the
  same live-session set as `agents sessions --active`, archiving pending mail in dead
  boxes as `dropped: dead` and pruning stale consumed entries. Dropped messages tied
  to a feed block surface a failure receipt (`status: dropped` / `expired`) so the
  sender sees the bounce instead of silence. Run the sweep manually with
  `agents mailboxes gc` (`--json` supported). Source:
  `apps/cli/src/lib/mailbox.ts`, `apps/cli/src/lib/mailbox-gc.ts`,
  `apps/cli/src/commands/message.ts`, `apps/cli/src/commands/mailboxes.ts`,
  `apps/cli/src/commands/watchdog.ts`, `apps/cli/src/lib/feed.ts`.
