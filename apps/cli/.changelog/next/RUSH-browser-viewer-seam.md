- **User-facing pages open in your configured browser profile, not the OS
  default.** `agents browser navigate` honoured `browser.profile` and nothing
  else did: `agents fleet login`, `agents devices lease`, `agents feedback`,
  `agents sessions trace --open`, and `agents browser sessions --open` each
  shelled straight to `open`/`xdg-open`, so every one of them landed in whatever
  the OS handler happened to be — on a Mac with Arc set as default, all of them
  opened in Arc while the configured Comet profile sat unused. They now route
  through one seam (`showUrl`/`showFile`), which resolves the viewer once.
  This matters beyond tidiness: the configured profile is where the fleet's
  logins accumulate, so a page opened there is one you are already signed in for,
  and a login it acquires is inherited by every later agent.
  The seam does not auto-start the browser daemon: showing a page is a side
  errand, so blocking it on a cold start would be a surprising stall. Daemon
  already running -> the viewer; not running -> the OS handler.
  Source: `src/lib/open-url.ts`.
- **New `browser.viewer` config key** (device scope) — a profile name, or `os`
  to keep using the OS default handler. Unset follows `browser.profile`.
  Deliberately distinct from `browser.profile`: one is the profile agents drive,
  the other is the browser that shows you a page. Source: `src/lib/device-config.ts`.
- **New `show` IPC action** — opens a tab bound to no task, so the abandoned-task
  reaper never closes a page you are reading. That is the whole reason it is not
  `navigate`. Screenshots, PDFs and recordings still go to the OS app, where
  Preview and QuickTime are the better viewer.
  Source: `src/lib/browser/service.ts`, `src/lib/browser/ipc.ts`.
- **New `agents browser show <url|file>`** — the CLI entry point to that seam, so
  external tools (a renderer's `--open`, a script) can show a page in the
  configured profile instead of shelling to `open`. Use it instead of `navigate`
  for anything a person will read: `navigate` binds a task and the reaper closes
  a task's tabs. `--os-browser` forces the OS handler; `--json` reports where it
  landed. Source: `src/commands/browser.ts`.
