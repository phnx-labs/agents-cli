- **The macOS menu bar app is now named AGI Menu in System Settings and
  Accessibility prompts.** Privacy & Security previously showed the executable
  name `MenubarHelper` because the bundle had no `CFBundleDisplayName`. The
  bundle now ships `CFBundleName` / `CFBundleDisplayName` = `AGI Menu`, and
  `agents menubar` status/enable/disable copy uses the same name. An install
  that was left ad-hoc-signed by an older heal path is also replaced from the
  Developer-ID source on the next `agents` run, so Accessibility stops
  re-prompting for a new identity every upgrade. Source:
  `apps/cli/menubar/scripts/build.sh`, `apps/cli/src/commands/menubar.ts`,
  `apps/cli/src/lib/menubar/install-menubar.ts`.
