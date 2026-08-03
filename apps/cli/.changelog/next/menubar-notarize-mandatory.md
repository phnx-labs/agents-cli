- **The macOS menu-bar helper is now notarized, ending the "app is damaged"
  dialog and the per-run `no valid code signature; skipping launch` spam
  (RUSH-2134).** The helper shipped Developer-ID signed but *not* notarized, so
  Gatekeeper on macOS 26+ rejected it as damaged and the install path tried to
  heal it by re-signing ad-hoc on every `agents` invocation — which can never
  satisfy Gatekeeper, so the dialog and the noise persisted. The release now
  notarizes + staples the helper (`menubar/scripts/build.sh`, mandatory for any
  Developer-ID build, run under the release's `agents secrets exec apple.com`
  context), the `prepack` gate refuses to pack an un-notarized bundle
  (`scripts/verify-menubar-helper.sh` now requires a stapled ticket), and the
  runtime ad-hoc re-sign band-aid is deleted — a notarized + stapled bundle
  survives npm's tarball round-trip untouched, so the helper launches with no
  per-machine healing. The launch guards now verify Gatekeeper acceptance (not
  just `codesign --verify`) and fail loud pointing at an upgrade rather than
  re-signing over it. Source: `apps/cli/menubar/scripts/build.sh`,
  `apps/cli/scripts/verify-menubar-helper.sh`, `apps/cli/scripts/release.sh`,
  `apps/cli/src/lib/menubar/install-menubar.ts`.
