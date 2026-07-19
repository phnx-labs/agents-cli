- **The bundled macOS menu-bar helper is now a true universal binary on
  Xcode-less release hosts.** `menubar/scripts/build.sh release` used
  `swift build --arch arm64 --arch x86_64` (needs Xcode's xcbuild) and, on a
  Command-Line-Tools-only host, silently fell back to a **single-arch** build —
  shipping an arm64-only `MenubarHelper.app` in the tarball that could not run on
  Intel Macs. It now builds each slice via `--triple` and `lipo`s them into one
  universal binary, matching the computer helper. Source:
  `apps/cli/menubar/scripts/build.sh`.
