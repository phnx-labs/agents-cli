- **Fix the macOS menu-bar auto-heal so upgrades actually restart the helper.**
  `agents` has an on-startup self-heal that re-copies `MenubarHelper.app` when
  the CLI version changes, but on modern macOS `launchctl bootstrap` fails when
  the job is already bootstrapped, and the deprecated `launchctl load -w`
  fallback plus `kickstart -k` did not recover a job that launchd had stopped
  respawning after a `WindowServer event port death`. The helper would stay
  updated on disk but invisible in the menu bar. `enableMenubarService` now
  boots the old job out, bootstraps the fresh plist, and kickstarts it — the
  same sequence that reliably restores the icon by hand. Source:
  `apps/cli/src/lib/menubar/install-menubar.ts`,
  `apps/cli/src/lib/menubar/install-menubar.test.ts`.
