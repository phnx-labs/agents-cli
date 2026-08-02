- **Desktop notifications now show the current agents-cli mark, not the old
  logo.** The menu-bar helper's app icon — the icon macOS puts on the left of
  every notification banner it posts (the menu bar helper's own notices and every
  `agents run --notify` finish notice) — was generated from the retired gradient
  "A" logo, so notifications carried stale branding while the menu-bar status
  item already used the new lowercase `a`. The shared master logo
  (`assets/logo.png`) is now the current `a` mark, so the menu-bar helper, the
  `agents computer` helper, and the keychain helper all regenerate their
  `AppIcon.icns` from it on the next build. Source: `assets/logo.png`,
  `apps/cli/menubar/scripts/build.sh`.
