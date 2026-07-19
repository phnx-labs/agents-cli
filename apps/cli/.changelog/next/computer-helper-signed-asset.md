- **The macOS `agents computer` helper now ships as a signed + notarized release asset,
  downloaded on demand.** A fresh `npm i -g @phnx-labs/agents-cli` no longer needs to build
  the Swift helper from source: `agents computer setup` / `agents setup computer` fetch
  `ComputerHelper.app.zip` from the matching `v<version>` GitHub release, verify it against
  the published `.sha256`, and re-check the code signature (Developer ID Team `2HTP252L87`)
  and notarization (`spctl --assess`) before it is ever copied to /Applications — mirroring
  the Windows helper's distribution. The download cache is never a trusted resolver source;
  a cached bundle is only ever read back through the verifying downloader. The helper is
  version-stamped at build time and the release pipeline publishes the asset automatically.
  Source: `apps/cli/src/lib/computer/download.ts`, `apps/cli/src/lib/computer-rpc.ts`,
  `apps/cli/src/commands/computer.ts`, `native/computer-mac/scripts/build.sh`,
  `apps/cli/scripts/publish-computer-helper-mac.sh`, `apps/cli/scripts/release.sh`.
