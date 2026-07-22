- **Fix the release-gated macOS CI matrix (test hermeticity).** `readAndResolveBundleEnv`
  no longer throws the headless "not unlocked" error when the keychain backend is
  test-overridden (`setKeychainBackendForTest`) — the in-memory backend never prompts
  Touch ID, so the guard was spurious and broke macOS-headless test runs. Production
  (never overridden) is unchanged. Additionally, subprocess/integration tests that
  require a macOS-only prerequisite that cannot exist on a GitHub runner (the signed
  `Agents CLI.app` keychain helper, a compiled bun standalone sidecar, or an ambient
  process observable by bare name) now skip-when-absent instead of hard-failing, so they
  still run on Linux and local macOS. Source: `apps/cli/src/lib/secrets/bundles.ts`.
