- **Native helper bundles now ship the agents-cli icon and the computer helper is
  branded "Agents Computer".** MenubarHelper.app, ComputerHelper.app, and the
  keychain `Agents CLI.app` previously had no `CFBundleIconFile`/`.icns`, so
  Notification Center and System Settings → Privacy & Security showed a blank
  square. Each build script now generates `AppIcon.icns` from `assets/logo.png`
  and adds `CFBundleIconFile` to the bundle `Info.plist`. The computer helper
  display name changed from "Computer Helper" to "Agents Computer" while keeping
  its bundle id and on-disk path, so existing Accessibility/Screen Recording
  grants remain valid. Source: `apps/cli/menubar/scripts/build.sh`,
  `native/computer-mac/scripts/build.sh`, `apps/cli/scripts/build-keychain-helper.sh`,
  `apps/cli/src/commands/setup-computer.ts`, `apps/cli/menubar/Sources/MenubarHelper/PromptPanel.swift`.
