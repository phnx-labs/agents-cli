---
type: changed
---

- **`agents watchdog` uses the standard `enable`/`disable` verbs (PHNX-3949).**
  The device-local daemon watchdog pass is now toggled with
  `agents watchdog enable` / `agents watchdog disable`, matching the
  `enable`/`disable` shape `menubar` and `daemon` already use for the same
  concept. The old `on` / `off` spellings keep working as aliases, so no existing
  invocation or script breaks. Source: `cli/src/commands/watchdog.ts`.
