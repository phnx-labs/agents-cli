- **Menu-bar & daemon notifications now use the current agents-cli mark, not the
  legacy logo.** A desktop notification from the menu-bar helper or the routines
  daemon showed the old `assets/logo.png` gradient "A" — outdated, and blank in the
  notification's left-hand app-icon slot. `MenubarHelper.app`'s `AppIcon.icns` is
  now generated from the current brand mark (`assets/app-icon.svg` → `app-icon.png`:
  the lime-tile lowercase `a` shared with the agi-cli web favicon and the menu-bar
  glyph), which drives both the notification's right-hand `contentImage` and its
  left-hand app icon. The installer also registers the bundle with LaunchServices
  (`lsregister -f`) at its `~/Library/Application Support` path so the OS can resolve
  that app icon. Source: `apps/cli/menubar/scripts/build.sh`,
  `apps/cli/src/lib/menubar/install-menubar.ts`, `assets/app-icon.svg`.
