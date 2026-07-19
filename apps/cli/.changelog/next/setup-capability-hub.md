- **`agents setup` is now a capability hub with guided `browser` / `computer` / `share`
  subcommands.** Bare `agents setup` still clones the system repo and imports unmanaged
  agents, but on a TTY it now also offers to set up the optional capabilities a fresh
  machine needs. Each is also runnable on its own and is idempotent (re-run to change
  settings): `agents setup browser` detects an installed Chromium-family browser and
  creates/points the `default` profile; `agents setup share` provisions or joins a
  Cloudflare share endpoint (reusing `agents share setup`/`join`); `agents setup computer`
  installs the macOS helper and walks you through the Accessibility + Screen-Recording
  grants — opening the exact System Settings panes and polling until trust lands. The
  existing `agents share setup` / `agents computer setup` remain for scripted use. Source:
  `apps/cli/src/commands/setup.ts`, `setup-browser.ts`, `setup-computer.ts`,
  `setup-share.ts`, `apps/cli/src/lib/browser/chrome.ts`, `apps/cli/src/commands/share.ts`.
